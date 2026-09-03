import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  networkConfig, networkConfigFromEnv, applyVerifyMode, readAnchor,
  KeyRegistry, FAILURE, CHAIN_ID, VERIFY_MODES,
  usageEvent, licencePrefix,
} from '../src/index.js'
import { startMockRegistry, activeRecord } from './mock-registry.js'

const KID = 'aa29f37ab7f4b2cf'
const TX = '0x' + 'ab'.repeat(32)
const LICENCE = 'kxco_live_0123456789abcdef'

const anchored = (extra = {}) => ({
  payload: 'e30',
  alg: 'ML-DSA-65',
  kid: KID,
  sig: 'AA',
  issuedAt: '2026-09-03T00:00:00.000Z',
  chainId: CHAIN_ID,
  anchor: { txHash: TX, blockNumber: 90633 },
  ...extra,
})

const unanchored = () => {
  const e = anchored()
  delete e.anchor
  delete e.chainId
  return e
}

// ── configuration ───────────────────────────────────────────────────────────

test('the three modes are exactly the three modes', () => {
  assert.deepEqual(VERIFY_MODES, ['signature', 'anchored', 'anchored+live'])
})

test('the default mode is signature, so the free path is the default', () => {
  assert.equal(networkConfig().verifyMode, 'signature')
  assert.equal(networkConfig().licenceKey, null)
})

test('trailing slashes on URLs are normalised away', () => {
  const c = networkConfig({ registryUrl: 'https://chain.kxco.ai/', relayUrl: 'https://relay.kxco.ai/' })
  assert.equal(c.registryUrl, 'https://chain.kxco.ai')
  assert.equal(c.relayUrl, 'https://relay.kxco.ai')
})

test('a non-http URL is refused', () => {
  assert.throws(() => networkConfig({ registryUrl: 'chain.kxco.ai' }), /must be an http\(s\) URL/)
})

test('the environment is the whole of what a customer sets to go live', () => {
  const c = networkConfigFromEnv({
    KXCO_VERIFY_MODE: 'anchored+live',
    KXCO_LICENCE_KEY: LICENCE,
    KXCO_REGISTRY_URL: 'https://chain.kxco.ai',
    KXCO_RELAY_URL: 'https://relay.kxco.ai',
    KXCO_REGISTRY_TTL_MS: '30000',
  })
  assert.equal(c.verifyMode, 'anchored+live')
  assert.equal(c.licenceKey, LICENCE)
  assert.equal(c.registryTtlMs, 30_000)
})

test('the American spelling of licence is accepted too', () => {
  assert.equal(networkConfigFromEnv({ KXCO_LICENSE_KEY: LICENCE }).licenceKey, LICENCE)
})

// ── anchors ─────────────────────────────────────────────────────────────────

test('an anchor is read from either the current or the legacy shape', () => {
  assert.equal(readAnchor(anchored()).txHash, TX)
  // What kxco-pq-attest wrote before this package existed.
  assert.equal(readAnchor({ chainAnchor: { txHash: TX, blockNumber: 1 } }).txHash, TX)
  assert.equal(readAnchor(unanchored()), null)
  assert.equal(readAnchor(null), null)
})

test('a malformed txHash is not an anchor', () => {
  for (const txHash of ['0xdeadbeef', 'ab'.repeat(32), '', 42, null]) {
    assert.equal(readAnchor({ anchor: { txHash } }), null, JSON.stringify(txHash))
  }
})

// ── signature mode ──────────────────────────────────────────────────────────

test('signature mode passes on the maths alone, offline and unlicensed', async () => {
  const config = networkConfig({ verifyMode: 'signature' })
  const result = await applyVerifyMode({
    envelope: unanchored(), signatureValid: true, kid: KID, config,
  })
  assert.deepEqual(result, { valid: true, mode: 'signature' })
})

// The order matters: a bad signature is reported as a bad signature in every
// mode, because "forged" and "revoked" lead a reader to different conclusions.
test('a bad signature fails first, in every mode', async () => {
  for (const verifyMode of VERIFY_MODES) {
    const result = await applyVerifyMode({
      envelope: anchored(),
      signatureValid: false,
      kid: KID,
      config: networkConfig({ verifyMode, licenceKey: LICENCE }),
    })
    assert.equal(result.valid, false, verifyMode)
    assert.equal(result.reason, FAILURE.SIGNATURE_INVALID, verifyMode)
  }
})

// ── anchored mode ───────────────────────────────────────────────────────────

test('anchored mode passes with no HTTP at all', async () => {
  // No fetch is reachable: the anchor travels inside the envelope, so an
  // air-gapped verifier can check it.
  const config = networkConfig({
    verifyMode: 'anchored',
    fetchImpl: () => { throw new Error('anchored mode must not make a request') },
  })
  const result = await applyVerifyMode({
    envelope: anchored(), signatureValid: true, kid: KID, config,
  })
  assert.equal(result.valid, true)
  assert.equal(result.anchor.txHash, TX)
})

test('anchored mode needs no licence', async () => {
  const config = networkConfig({ verifyMode: 'anchored' })
  assert.equal(config.licenceKey, null)
  assert.equal((await applyVerifyMode({
    envelope: anchored(), signatureValid: true, kid: KID, config,
  })).valid, true)
})

test('an unanchored envelope fails anchored mode, and says what to do', async () => {
  const result = await applyVerifyMode({
    envelope: unanchored(), signatureValid: true, kid: KID,
    config: networkConfig({ verifyMode: 'anchored' }),
  })
  assert.equal(result.valid, false)
  assert.equal(result.reason, FAILURE.NOT_ANCHORED)
  assert.match(result.detail, /anchor: true/)
})

test('an anchor on any other chain is refused', async () => {
  const result = await applyVerifyMode({
    envelope: anchored({ chainId: 1 }), signatureValid: true, kid: KID,
    config: networkConfig({ verifyMode: 'anchored' }),
  })
  assert.equal(result.valid, false)
  assert.equal(result.reason, FAILURE.WRONG_CHAIN)
})

// An envelope written before chainId existed carries chainAnchor and nothing
// else. Rejecting it would break archives that are already in customers' hands.
test('a legacy envelope with no chainId still verifies as anchored', async () => {
  const result = await applyVerifyMode({
    envelope: { kid: KID, chainAnchor: { txHash: TX, blockNumber: 1 } },
    signatureValid: true, kid: KID,
    config: networkConfig({ verifyMode: 'anchored' }),
  })
  assert.equal(result.valid, true)
})

// ── anchored+live ───────────────────────────────────────────────────────────

test('anchored+live passes for an active kid', async (t) => {
  const server = await startMockRegistry({ [KID]: activeRecord(KID) })
  t.after(() => server.close())

  const result = await applyVerifyMode({
    envelope: anchored(), signatureValid: true, kid: KID,
    config: networkConfig({ verifyMode: 'anchored+live', registryUrl: server.url, licenceKey: LICENCE }),
  })
  assert.equal(result.valid, true)
  assert.equal(result.registry.status, 'active')
  assert.equal(result.registry.institutionId, 'org_test')
})

test('a revoked kid fails, with a reason a caller can branch on', async (t) => {
  const server = await startMockRegistry({ [KID]: activeRecord(KID, { status: 'revoked' }) })
  t.after(() => server.close())

  const result = await applyVerifyMode({
    envelope: anchored(), signatureValid: true, kid: KID,
    config: networkConfig({ verifyMode: 'anchored+live', registryUrl: server.url, licenceKey: LICENCE }),
  })
  assert.equal(result.valid, false)
  assert.equal(result.reason, FAILURE.KID_REVOKED)
})

test('a rotated kid fails and names its successor', async (t) => {
  const next = 'bb29f37ab7f4b2cf'
  const server = await startMockRegistry({ [KID]: activeRecord(KID, { status: 'rotated', rotatedTo: next }) })
  t.after(() => server.close())

  const result = await applyVerifyMode({
    envelope: anchored(), signatureValid: true, kid: KID,
    config: networkConfig({ verifyMode: 'anchored+live', registryUrl: server.url, licenceKey: LICENCE }),
  })
  assert.equal(result.reason, FAILURE.KID_ROTATED)
  assert.match(result.detail, new RegExp(next))
})

test('a kid the registry has never seen fails', async (t) => {
  const server = await startMockRegistry({})
  t.after(() => server.close())

  const result = await applyVerifyMode({
    envelope: anchored(), signatureValid: true, kid: KID,
    config: networkConfig({ verifyMode: 'anchored+live', registryUrl: server.url, licenceKey: LICENCE }),
  })
  assert.equal(result.reason, FAILURE.KID_UNKNOWN)
})

// The single most important assertion in this file. A mode whose purpose is to
// catch a revoked key must not degrade into the mode that cannot, precisely
// when the network is behaving oddly.
test('anchored+live fails CLOSED when the registry is unreachable', async () => {
  const result = await applyVerifyMode({
    envelope: anchored(), signatureValid: true, kid: KID,
    config: networkConfig({
      verifyMode: 'anchored+live',
      registryUrl: 'http://127.0.0.1:1',
      licenceKey: LICENCE,
      timeoutMs: 400,
    }),
  })
  assert.equal(result.valid, false)
  assert.equal(result.reason, FAILURE.REGISTRY_UNREACHABLE)
  assert.match(result.detail, /fails closed/)
})

test('a registry timeout also fails closed', async (t) => {
  const server = await startMockRegistry({ [KID]: 'hang' })
  t.after(() => server.close())

  const result = await applyVerifyMode({
    envelope: anchored(), signatureValid: true, kid: KID,
    config: networkConfig({
      verifyMode: 'anchored+live', registryUrl: server.url, licenceKey: LICENCE, timeoutMs: 250,
    }),
  })
  assert.equal(result.valid, false)
  assert.equal(result.reason, FAILURE.REGISTRY_UNREACHABLE)
})

test('anchored+live without a licence key fails, and points at anchored', async () => {
  const result = await applyVerifyMode({
    envelope: anchored(), signatureValid: true, kid: KID,
    config: networkConfig({ verifyMode: 'anchored+live' }),
  })
  assert.equal(result.valid, false)
  assert.equal(result.reason, FAILURE.LICENCE_REQUIRED)
  assert.match(result.detail, /KXCO_LICENCE_KEY/)
})

test('anchored+live still requires the anchor', async (t) => {
  const server = await startMockRegistry({ [KID]: activeRecord(KID) })
  t.after(() => server.close())

  const result = await applyVerifyMode({
    envelope: unanchored(), signatureValid: true, kid: KID,
    config: networkConfig({ verifyMode: 'anchored+live', registryUrl: server.url, licenceKey: LICENCE }),
  })
  assert.equal(result.reason, FAILURE.NOT_ANCHORED)
  assert.equal(server.requests.length, 0, 'no lookup should happen for an unanchored envelope')
})

test('a shared registry instance shares its cache across verifications', async (t) => {
  const server = await startMockRegistry({ [KID]: activeRecord(KID) })
  t.after(() => server.close())

  const config = networkConfig({
    verifyMode: 'anchored+live', registryUrl: server.url, licenceKey: LICENCE, registryTtlMs: 5000,
  })
  const registry = new KeyRegistry(config)
  for (let i = 0; i < 5; i++) {
    await applyVerifyMode({ envelope: anchored(), signatureValid: true, kid: KID, config, registry })
  }
  assert.equal(server.countFor(KID), 1)
})

// ── metering ────────────────────────────────────────────────────────────────

test('a usage event carries the institution and kid but never the whole licence', () => {
  const record = usageEvent('anchor_written', {
    institutionId: 'org_abc', kid: KID, licenceKey: LICENCE, txHash: TX,
  })
  assert.equal(record.event, 'anchor_written')
  assert.equal(record.institutionId, 'org_abc')
  assert.equal(record.kid, KID)
  assert.equal(record.chainId, CHAIN_ID)
  assert.equal(record.licencePrefix, 'kxco_liv')
  assert.equal(record.licenceKey, undefined)
  assert.ok(!JSON.stringify(record).includes(LICENCE), 'the full licence must never reach a log line')
})

test('licencePrefix handles a missing key', () => {
  assert.equal(licencePrefix(null), null)
  assert.equal(licencePrefix(''), null)
  assert.equal(licencePrefix(undefined), null)
})

test('an expired kid fails anchored+live with its own reason', async (t) => {
  const server = await startMockRegistry({ [KID]: activeRecord(KID, { status: 'expired' }) })
  t.after(() => server.close())

  const result = await applyVerifyMode({
    envelope: anchored(), signatureValid: true, kid: KID,
    config: networkConfig({ verifyMode: 'anchored+live', registryUrl: server.url, licenceKey: LICENCE }),
  })
  assert.equal(result.valid, false)
  assert.equal(result.reason, FAILURE.KID_EXPIRED)
})
