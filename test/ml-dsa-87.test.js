// Registry records carry the algorithm, and anchored+live refuses a mismatch.
//
// The key decides the parameter set. A registry record for the right kid that
// names the other set is either a wrong or interposed registry, or an envelope
// claiming a set its key is not, and neither is something to act on. A record
// with no `alg` predates the field and means ML-DSA-65, which keeps every
// existing record and every existing caller working.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'

import {
  networkConfig, applyVerifyMode, KeyRegistry, FAILURE, CHAIN_ID, DEFAULT_ALG,
} from '../src/index.js'
import { startMockRegistry, activeRecord } from './mock-registry.js'

const KID = '87a1b2c3d4e5f607'
const TX = '0x' + 'cd'.repeat(32)
const LICENCE = 'kxco_live_0123456789abcdef'

const reg = await startMockRegistry({})
after(() => reg.close())

const live = () => networkConfig({
  registryUrl: reg.url, verifyMode: 'anchored+live', licenceKey: LICENCE, registryTtlMs: 0,
})
const envelope = (extra = {}) => ({
  payload: 'e30', kid: KID, sig: 'AA', issuedAt: '2026-10-05T00:00:00.000Z',
  chainId: CHAIN_ID, anchor: { txHash: TX, blockNumber: 3600000 }, ...extra,
})
const verify = (opts) => applyVerifyMode({ signatureValid: true, kid: KID, config: live(), ...opts })

// ── the record ──────────────────────────────────────────────────────────────

test('a record names its algorithm, and one without it means ML-DSA-65', async () => {
  assert.equal(DEFAULT_ALG, 'ML-DSA-65')
  const client = new KeyRegistry(live())

  reg.set(KID, activeRecord(KID, { alg: 'ML-DSA-87', publicKey: 'ab'.repeat(2592) }))
  assert.equal((await client.lookup(KID)).alg, 'ML-DSA-87')

  reg.set(KID, activeRecord(KID))
  assert.equal((await client.lookup(KID)).alg, 'ML-DSA-65')

  // An unknown kid has no record, so no algorithm.
  assert.equal((await client.lookup('0000000000000000')).alg, undefined)
})

test('a non-string alg is a malformed record, not a default', async () => {
  const client = new KeyRegistry(live())
  for (const alg of [87, null, {}, ['ML-DSA-87'], true]) {
    reg.set(KID, activeRecord(KID, { alg }))
    await assert.rejects(client.lookup(KID), (err) => err.code === 'REGISTRY_BAD_RECORD', JSON.stringify(alg))
  }
})

// ── anchored+live ───────────────────────────────────────────────────────────

test('an ML-DSA-87 key the registry holds as ML-DSA-87 is valid in anchored+live', async () => {
  reg.set(KID, activeRecord(KID, { alg: 'ML-DSA-87' }))
  const r = await verify({ envelope: envelope({ alg: 'ML-DSA-87' }), alg: 'ML-DSA-87' })
  assert.equal(r.valid, true, JSON.stringify(r))
  assert.equal(r.registry.alg, 'ML-DSA-87')
})

test('a record holding the other set is refused as alg_mismatch, whichever side it comes from', async () => {
  // The registry says ML-DSA-65 for an ML-DSA-87 key.
  reg.set(KID, activeRecord(KID, { alg: 'ML-DSA-65' }))
  let r = await verify({ envelope: envelope(), alg: 'ML-DSA-87' })
  assert.equal(r.valid, false)
  assert.equal(r.reason, FAILURE.ALG_MISMATCH)
  assert.equal(FAILURE.ALG_MISMATCH, 'alg_mismatch')
  assert.match(r.detail, /holds kid 87a1b2c3d4e5f607 as ML-DSA-65, but the key is ML-DSA-87/)

  // A record without alg means ML-DSA-65, so it too refuses an ML-DSA-87 key.
  reg.set(KID, activeRecord(KID))
  r = await verify({ envelope: envelope(), alg: 'ML-DSA-87' })
  assert.equal(r.reason, FAILURE.ALG_MISMATCH)

  // The envelope claims ML-DSA-87 and the caller states nothing.
  r = await verify({ envelope: envelope({ alg: 'ML-DSA-87' }) })
  assert.equal(r.reason, FAILURE.ALG_MISMATCH)
  assert.match(r.detail, /the envelope is ML-DSA-87/)

  // The registry says ML-DSA-87 for an ML-DSA-65 key.
  reg.set(KID, activeRecord(KID, { alg: 'ML-DSA-87' }))
  r = await verify({ envelope: envelope({ alg: 'ML-DSA-65' }), alg: 'ML-DSA-65' })
  assert.equal(r.reason, FAILURE.ALG_MISMATCH)

  // A caller stating nothing, on an envelope naming nothing, verified
  // ML-DSA-65, so a record holding ML-DSA-87 is refused rather than trusted.
  r = await verify({ envelope: envelope() })
  assert.equal(r.reason, FAILURE.ALG_MISMATCH)

  // The key and the envelope disagree with each other: one of them is wrong.
  r = await verify({ envelope: envelope({ alg: 'ML-DSA-87' }), alg: 'ML-DSA-65' })
  assert.equal(r.reason, FAILURE.ALG_MISMATCH)

  // A set this build does not know matches neither.
  reg.set(KID, activeRecord(KID, { alg: 'ML-DSA-1024' }))
  r = await verify({ envelope: envelope(), alg: 'ML-DSA-87' })
  assert.equal(r.reason, FAILURE.ALG_MISMATCH)
})

test('ML-DSA-65 back-compat: no alg anywhere is ML-DSA-65 on both sides, and valid', async () => {
  reg.set(KID, activeRecord(KID))
  const old = envelope()
  assert.equal((await verify({ envelope: old })).valid, true)
  assert.equal((await verify({ envelope: envelope({ alg: 'ML-DSA-65' }) })).valid, true)
  assert.equal((await verify({ envelope: old, alg: 'ML-DSA-65' })).valid, true)
  reg.set(KID, activeRecord(KID, { alg: 'ML-DSA-65' }))
  assert.equal((await verify({ envelope: old })).valid, true)
})

test('a revoked key is reported as revoked, not as a mismatch', async () => {
  reg.set(KID, activeRecord(KID, { status: 'revoked', alg: 'ML-DSA-65' }))
  const r = await verify({ envelope: envelope(), alg: 'ML-DSA-87' })
  assert.equal(r.reason, FAILURE.KID_REVOKED)
})

test('signature and anchored modes consult no registry, so no algorithm check applies', async () => {
  const before = reg.requests.length
  for (const verifyMode of ['signature', 'anchored']) {
    const r = await applyVerifyMode({
      envelope: envelope({ alg: 'ML-DSA-87' }), signatureValid: true, kid: KID, alg: 'ML-DSA-87',
      config: networkConfig({ registryUrl: reg.url, verifyMode }),
    })
    assert.equal(r.valid, true, verifyMode)
  }
  assert.equal(reg.requests.length, before)
})
