// Property-based tests with fast-check.
//
// test/network.test.js and test/registry.test.js pin the cases someone thought
// to write down, against a real HTTP registry on a loopback port. These ask
// the general question of applyVerifyMode instead: for ANY envelope, signature
// outcome, registry answer and mode, does it require exactly what the mode
// promises, and fail closed everywhere else? fast-check generates the inputs
// and, when a property breaks, shrinks the failing case to the smallest one
// that still breaks it, so a failure arrives as a minimal reproduction.
//
// Nothing here opens a connection. The signature is checked in this file with
// kxco-post-quantum, the way a caller would, and the registry is either a
// local object with a lookup() or a real KeyRegistry whose fetchImpl is a
// local function returning a Response. The registry URL is on the reserved
// .invalid domain, so even a mistake here could not reach a host.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { mlDsa, fingerprint } from 'kxco-post-quantum'
import {
  applyVerifyMode, readAnchor, networkConfig, KeyRegistry, KxcoPqNetworkError,
  FAILURE, CHAIN_ID, VERIFY_MODES, KID_STATUS,
} from '../src/index.js'

// Signing is milliseconds per case; the mode logic on its own is not.
const SIGNING = { numRuns: 40 }
const PURE = { numRuns: 500 }

const LICENCE = 'kxco_live_property_tests'
const REGISTRY_URL = 'http://registry.invalid'

const key = mlDsa.keypairFromMaster(new Uint8Array(32).fill(7), 'kxco-pq-network-property-tests-v1')
const KID = fingerprint(key.publicKey)

// The caller's own signature check, which is what applyVerifyMode is handed.
function signatureValid(envelope) {
  try {
    return mlDsa.verify(key.publicKey, envelope.payload, envelope.sig) === true
  } catch {
    return false
  }
}

// A fetch that must never be reached: any path that falls through to it fails
// closed and visibly rather than going anywhere.
const noFetch = async () => { throw new Error('no network in property tests') }

function config(verifyMode, extra = {}) {
  return networkConfig({
    verifyMode, licenceKey: LICENCE, registryUrl: REGISTRY_URL, registryTtlMs: 0, fetchImpl: noFetch, ...extra,
  })
}

// A registry object that answers with a fixed record and counts the asks.
function countingRegistry(record) {
  const r = { asked: 0, async lookup() { r.asked++; return record } }
  return r
}

// A real KeyRegistry whose fetch returns what the generator chose.
function registryAnswering(respond) {
  return new KeyRegistry(config('anchored+live', { fetchImpl: async () => respond() }))
}

// ── generators ──────────────────────────────────────────────────────────────

const TX = fc.stringMatching(/^0x[0-9a-fA-F]{64}$/)
const badTx = fc.oneof(
  fc.string({ maxLength: 70 }),
  fc.stringMatching(/^0x[0-9a-fA-F]{63}$/),
  fc.stringMatching(/^0x[0-9a-fA-F]{65}$/),
  fc.stringMatching(/^[0-9a-fA-F]{64}$/),
  fc.integer(),
  fc.constant(null),
)
const otherChain = fc.oneof(
  fc.integer().filter((n) => n !== CHAIN_ID),
  fc.constantFrom(String(CHAIN_ID), 1, 0),
)
// How an envelope might carry, mis-carry or omit an anchor, with the answer
// the README gives for each: anchored needs a 0x + 64 hex transaction hash,
// in either shape, and any chain id it names must be Armature L1.
const anchoring = fc.oneof(
  fc.constant({ fields: {}, expect: FAILURE.NOT_ANCHORED }),
  fc.record({ tx: TX, chain: fc.constantFrom(CHAIN_ID, undefined) })
    .map(({ tx, chain }) => ({ fields: { chainId: chain, anchor: { txHash: tx, blockNumber: 1 } }, expect: 'ok' })),
  fc.record({ tx: TX, chain: fc.constantFrom(CHAIN_ID, undefined) })
    .map(({ tx, chain }) => ({ fields: { chainAnchor: { txHash: tx, blockNumber: 1, chainId: chain } }, expect: 'ok' })),
  fc.record({ tx: badTx, shape: fc.constantFrom('anchor', 'chainAnchor') })
    .map(({ tx, shape }) => ({ fields: { chainId: CHAIN_ID, [shape]: { txHash: tx } }, expect: FAILURE.NOT_ANCHORED })),
  fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null))
    .map((junk) => ({ fields: { chainId: CHAIN_ID, anchor: junk }, expect: FAILURE.NOT_ANCHORED })),
  fc.record({ tx: TX, chain: otherChain })
    .map(({ tx, chain }) => ({ fields: { chainId: chain, anchor: { txHash: tx } }, expect: FAILURE.WRONG_CHAIN })),
  fc.record({ tx: TX, chain: otherChain })
    .map(({ tx, chain }) => ({ fields: { chainAnchor: { txHash: tx, chainId: chain } }, expect: FAILURE.WRONG_CHAIN })),
)
const payload = fc.oneof(fc.string({ maxLength: 200 }), fc.json({ maxDepth: 2 }))
const anyEnvelope = fc.tuple(payload, anchoring).map(([p, a]) => ({ envelope: { payload: p, kid: KID, sig: 'AA', ...a.fields }, expect: a.expect }))

// ── properties ──────────────────────────────────────────────────────────────

test('the harness fails a property that is false', () => {
  assert.throws(() => fc.assert(fc.property(fc.integer(), (n) => n + 1 === n), { numRuns: 10 }))
})

test('with a real signature check, each mode adds exactly its own requirement', async () => {
  await fc.assert(fc.asyncProperty(payload, anchoring, fc.boolean(), async (p, a, tamper) => {
    const envelope = { payload: p, alg: 'ML-DSA-65', kid: KID, sig: mlDsa.sign(key.secretKey, p), ...a.fields }
    if (tamper) envelope.payload = `${p}.`
    const sig = signatureValid(envelope)
    if (sig === tamper) return false

    const active = countingRegistry({ kid: KID, status: 'active', chainId: CHAIN_ID })
    const run = (mode) => applyVerifyMode({ envelope, signatureValid: sig, kid: KID, config: config(mode), registry: active })
    const [s, an, live] = [await run('signature'), await run('anchored'), await run('anchored+live')]

    const anchorOk = a.expect === 'ok'
    return s.valid === sig &&
      an.valid === (sig && anchorOk) &&
      live.valid === (sig && anchorOk) &&
      (sig || [s, an, live].every((r) => r.reason === FAILURE.SIGNATURE_INVALID)) &&
      (!sig || anchorOk || (an.reason === a.expect && live.reason === a.expect)) &&
      // The registry is asked only once the signature and the anchor have passed.
      active.asked === (sig && anchorOk ? 1 : 0)
  }), SIGNING)
})

test('a failed signature fails first in every mode, whatever the envelope, and the registry is never asked', async () => {
  await fc.assert(fc.asyncProperty(anyEnvelope, fc.constantFrom(...VERIFY_MODES), async ({ envelope }, mode) => {
    const registry = countingRegistry({ kid: KID, status: 'active' })
    const r = await applyVerifyMode({ envelope, signatureValid: false, kid: KID, config: config(mode), registry })
    return r.valid === false && r.reason === FAILURE.SIGNATURE_INVALID && r.mode === mode && registry.asked === 0
  }), PURE)
})

test('anchored: valid exactly when the envelope carries an Armature L1 anchor, with no registry involved', async () => {
  await fc.assert(fc.asyncProperty(anyEnvelope, async ({ envelope, expect }) => {
    const registry = countingRegistry({ kid: KID, status: 'revoked' })
    const r = await applyVerifyMode({ envelope, signatureValid: true, kid: KID, config: config('anchored'), registry })
    if (registry.asked !== 0) return false
    if (expect === 'ok') return r.valid === true && r.anchor.txHash === (envelope.anchor ?? envelope.chainAnchor).txHash
    return r.valid === false && r.reason === expect
  }), PURE)
})

test('anchored+live: without a licence key it is refused, and the registry is never asked', async () => {
  await fc.assert(fc.asyncProperty(anyEnvelope, fc.constantFrom(null, undefined, ''), async ({ envelope, expect }, licenceKey) => {
    fc.pre(expect === 'ok')
    const registry = countingRegistry({ kid: KID, status: 'active' })
    const r = await applyVerifyMode({
      envelope, signatureValid: true, kid: KID, config: config('anchored+live', { licenceKey }), registry,
    })
    return r.valid === false && r.reason === FAILURE.LICENCE_REQUIRED && registry.asked === 0
  }), { numRuns: 100 })
})

test('anchored+live: a registry that cannot be reached, or answers with something that is not a record, fails closed as registry_unreachable', async () => {
  const json = (body, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const failure = fc.oneof(
    // fetch itself throws or rejects.
    fc.string().map((m) => () => { throw new Error(m) }),
    fc.constant(() => { throw new Error() }),
    fc.string().map((m) => () => { throw new TypeError(m) }),
    fc.constant(() => { throw new DOMException('aborted', 'AbortError') }),
    fc.oneof(fc.constantFrom(null, undefined), fc.anything()).map((v) => () => { throw v }),
    fc.string().map((m) => () => Promise.reject(new Error(m))),
    // A 200 whose body is not JSON, whatever it claims to be.
    fc.tuple(fc.string(), fc.constantFrom('application/json', 'text/html', 'text/plain', ''))
      .map(([t, type]) => () => new Response(`<${t}`, { status: 200, headers: type ? { 'content-type': type } : {} })),
    // A 404 that is a web page, not a registry answer.
    fc.tuple(fc.string(), fc.constantFrom('text/html; charset=utf-8', 'text/plain', ''))
      .map(([t, type]) => () => new Response(`<!DOCTYPE html>${t}`, { status: 404, headers: type ? { 'content-type': type } : {} })),
    // Any other status that is not success.
    fc.oneof(fc.integer({ min: 400, max: 599 }).filter((s) => s !== 404), fc.constantFrom(301, 302, 307, 308))
      .map((status) => json({ error: 'upstream' }, status)),
    // JSON that is not a record, a record about another kid, or on another chain.
    fc.oneof(fc.constant(null), fc.integer(), fc.string(), fc.boolean()).map((v) => json(v)),
    fc.stringMatching(/^[0-9a-f]{16}$/).filter((k) => k !== KID).map((k) => json({ kid: k, status: 'active' })),
    fc.oneof(fc.string().filter((k) => k !== KID), fc.constant(undefined)).map((k) => json({ kid: k, status: 'active' })),
    otherChain.map((c) => json({ kid: KID, status: 'active', chainId: c })),
    // Objects where text belongs, including one that cannot be turned into text.
    fc.oneof(fc.constant({ toString: null }), fc.dictionary(fc.string(), fc.jsonValue({ maxDepth: 1 })))
      .chain((o) => fc.constantFrom(json({ kid: o, status: 'active' }), json({ kid: KID, status: 'active', chainId: o }))),
  )
  await fc.assert(fc.asyncProperty(failure, async (respond) => {
    const r = await applyVerifyMode({
      envelope: { payload: 'e30', kid: KID, sig: 'AA', chainId: CHAIN_ID, anchor: { txHash: `0x${'ab'.repeat(32)}` } },
      signatureValid: true, kid: KID, config: config('anchored+live'), registry: registryAnswering(respond),
    })
    return r.valid === false && r.reason === FAILURE.REGISTRY_UNREACHABLE && r.anchor !== undefined
  }), PURE)
})

test('anchored+live: a registry object that throws a KxcoPqNetworkError also fails closed as registry_unreachable', async () => {
  const code = fc.constantFrom('REGISTRY_UNREACHABLE', 'REGISTRY_BAD_RECORD', 'WRONG_CHAIN', 'BAD_KID', 'NETWORK_ERROR')
  await fc.assert(fc.asyncProperty(fc.string(), code, async (message, c) => {
    const registry = { async lookup() { throw new KxcoPqNetworkError(message, { code: c }) } }
    const r = await applyVerifyMode({
      envelope: { chainId: CHAIN_ID, anchor: { txHash: `0x${'cd'.repeat(32)}` } },
      signatureValid: true, kid: KID, config: config('anchored+live'), registry,
    })
    return r.valid === false && r.reason === FAILURE.REGISTRY_UNREACHABLE
  }), PURE)
})

test('anchored+live: only an active status passes, and any status outside the four is refused as kid_unknown', async () => {
  const status = fc.oneof(
    fc.constantFrom(...KID_STATUS),
    fc.constantFrom('ACTIVE', 'Active', ' active', 'active ', 'unknown', 'suspended', ''),
    fc.string(),
    fc.jsonValue({ maxDepth: 1 }),
  )
  const REASON = { revoked: FAILURE.KID_REVOKED, rotated: FAILURE.KID_ROTATED, expired: FAILURE.KID_EXPIRED }
  const rotatedTo = fc.oneof(fc.constant(undefined), fc.constant({ toString: null }), fc.jsonValue({ maxDepth: 1 }))
  await fc.assert(fc.asyncProperty(status, fc.constantFrom(CHAIN_ID, undefined), rotatedTo, async (s, chainId, to) => {
    const body = JSON.stringify({ kid: KID, status: s, chainId, rotatedTo: to })
    const registry = registryAnswering(() => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }))
    const r = await applyVerifyMode({
      envelope: { chainId: CHAIN_ID, anchor: { txHash: `0x${'ef'.repeat(32)}` } },
      signatureValid: true, kid: KID, config: config('anchored+live'), registry,
    })
    // What the registry actually said, after the JSON round trip.
    const said = JSON.parse(body).status
    if (said === 'active') return r.valid === true && r.registry.status === 'active'
    return r.valid === false && typeof r.detail === 'string' &&
      r.reason === (REASON[KID_STATUS.includes(said) ? said : ''] ?? FAILURE.KID_UNKNOWN)
  }), PURE)
})

test('anchored+live: a JSON 404 is the registry answering, and is refused as kid_unknown', async () => {
  await fc.assert(fc.asyncProperty(fc.jsonValue({ maxDepth: 2 }), fc.constantFrom('application/json', 'application/json; charset=utf-8', 'application/problem+json'), async (body, type) => {
    const registry = registryAnswering(() => new Response(JSON.stringify(body), { status: 404, headers: { 'content-type': type } }))
    const r = await applyVerifyMode({
      envelope: { chainId: CHAIN_ID, anchor: { txHash: `0x${'12'.repeat(32)}` } },
      signatureValid: true, kid: KID, config: config('anchored+live'), registry,
    })
    return r.valid === false && r.reason === FAILURE.KID_UNKNOWN
  }), { numRuns: 200 })
})

test('anchored+live: whatever a registry object reports, it never throws, only an active status passes, and every refusal names one of the package reasons', async () => {
  // Anything at all, with the names every plain object inherits, the four
  // statuses and an object that cannot be turned into text drawn often.
  const reported = fc.oneof(
    fc.anything(),
    fc.constantFrom('toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf', ...KID_STATUS, { toString: null }),
  )
  const REASONS = Object.values(FAILURE)
  await fc.assert(fc.asyncProperty(reported, reported, async (s, to) => {
    const r = await applyVerifyMode({
      envelope: { chainId: CHAIN_ID, anchor: { txHash: `0x${'34'.repeat(32)}` } },
      signatureValid: true, kid: KID, config: config('anchored+live'),
      registry: countingRegistry({ kid: KID, status: s, rotatedTo: to }),
    })
    if (s === 'active') return r.valid === true
    return r.valid === false && REASONS.includes(r.reason) && typeof r.detail === 'string'
  }), PURE)
})

test('readAnchor: never throws on arbitrary input, and only returns a well-formed transaction hash', () => {
  fc.assert(fc.property(fc.anything(), fc.anything(), (a, b) => {
    for (const input of [a, { anchor: a }, { chainAnchor: a }, { anchor: a, chainAnchor: b, chainId: b }]) {
      const r = readAnchor(input)
      if (r !== null && !(typeof r.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(r.txHash))) return false
    }
    return true
  }), { numRuns: 2000 })
})
