import { test } from 'node:test'
import assert from 'node:assert/strict'

import { networkConfig, KeyRegistry, KxcoPqNetworkError } from '../src/index.js'
import { startMockRegistry, activeRecord } from './mock-registry.js'

const KID = 'aa29f37ab7f4b2cf'
const OTHER = 'bb29f37ab7f4b2cf'

function configFor(url, extra = {}) {
  return networkConfig({ registryUrl: url, licenceKey: 'kxco_test_licence_key', ...extra })
}

test('an active kid resolves with its record', async (t) => {
  const server = await startMockRegistry({ [KID]: activeRecord(KID) })
  t.after(() => server.close())

  const record = await new KeyRegistry(configFor(server.url)).lookup(KID)
  assert.equal(record.status, 'active')
  assert.equal(record.institutionId, 'org_test')
  assert.equal(record.chainId, 1111111)
  assert.equal(record.cached, false)
})

test('revoked and rotated statuses come through, with rotatedTo', async (t) => {
  const server = await startMockRegistry({
    [KID]: activeRecord(KID, { status: 'revoked' }),
    [OTHER]: activeRecord(OTHER, { status: 'rotated', rotatedTo: KID }),
  })
  t.after(() => server.close())

  const registry = new KeyRegistry(configFor(server.url))
  assert.equal((await registry.lookup(KID)).status, 'revoked')

  const rotated = await registry.lookup(OTHER)
  assert.equal(rotated.status, 'rotated')
  assert.equal(rotated.rotatedTo, KID)
})

// The distinction the whole fail-closed design rests on.
test('a 404 is an answer (unknown); being unreachable is not', async (t) => {
  const server = await startMockRegistry({})
  t.after(() => server.close())

  const record = await new KeyRegistry(configFor(server.url)).lookup(KID)
  assert.equal(record.status, 'unknown')

  // Nothing listening at all.
  const dead = new KeyRegistry(configFor('http://127.0.0.1:1', { timeoutMs: 500 }))
  await assert.rejects(() => dead.lookup(KID), (err) => {
    assert.ok(err instanceof KxcoPqNetworkError)
    assert.equal(err.code, 'REGISTRY_UNREACHABLE')
    return true
  })
})

// Found by probing the live endpoint, not by reasoning about it. Pointing
// registryUrl at a web app gets that app's 404 page back, and the earlier
// version of this client read it as a confident "this key is unknown" —
// stating a fact about a key on the strength of a misconfigured URL.
test('an HTML 404 is a wrong address, not an answer about a key', async (t) => {
  const server = await startMockRegistry({ [KID]: 'webpage' })
  t.after(() => server.close())

  await assert.rejects(
    () => new KeyRegistry(configFor(server.url)).lookup(KID),
    (err) => {
      assert.equal(err.code, 'REGISTRY_UNREACHABLE')
      assert.match(err.message, /web page, not a registry answer/)
      return true
    },
  )
})

test('a JSON 404 from the registry is still a definite answer', async (t) => {
  const server = await startMockRegistry({})
  t.after(() => server.close())
  assert.equal((await new KeyRegistry(configFor(server.url)).lookup(KID)).status, 'unknown')
})

test('a 5xx and a non-JSON body are both unreachable, not unknown', async (t) => {
  const server = await startMockRegistry({ [KID]: 503, [OTHER]: 'garbage' })
  t.after(() => server.close())
  const registry = new KeyRegistry(configFor(server.url))

  await assert.rejects(() => registry.lookup(KID), (e) => e.code === 'REGISTRY_UNREACHABLE' && e.status === 503)
  await assert.rejects(() => registry.lookup(OTHER), (e) => e.code === 'REGISTRY_UNREACHABLE')
})

test('a slow registry times out rather than hanging the caller', async (t) => {
  const server = await startMockRegistry({ [KID]: 'hang' })
  t.after(() => server.close())

  const registry = new KeyRegistry(configFor(server.url, { timeoutMs: 300 }))
  await assert.rejects(() => registry.lookup(KID), /timed out after 300ms/)
})

// A registry that answers about a different key than the one asked for is
// either broken or being interposed. Either way the answer is unusable.
test('a record for the wrong kid is refused', async (t) => {
  const server = await startMockRegistry({ [KID]: activeRecord(OTHER) })
  t.after(() => server.close())

  await assert.rejects(
    () => new KeyRegistry(configFor(server.url)).lookup(KID),
    /was asked about/,
  )
})

test('a record naming another chain is refused', async (t) => {
  const server = await startMockRegistry({ [KID]: activeRecord(KID, { chainId: 1 }) })
  t.after(() => server.close())

  await assert.rejects(
    () => new KeyRegistry(configFor(server.url)).lookup(KID),
    (e) => e.code === 'WRONG_CHAIN',
  )
})

// A status this build has never heard of must not fall out of the "is it
// active" check as though it were active.
test('an unrecognised status becomes unknown, not active', async (t) => {
  const server = await startMockRegistry({ [KID]: activeRecord(KID, { status: 'suspended-pending-review' }) })
  t.after(() => server.close())

  assert.equal((await new KeyRegistry(configFor(server.url)).lookup(KID)).status, 'unknown')
})

// ── caching ─────────────────────────────────────────────────────────────────

test('lookups are cached by kid for the TTL', async (t) => {
  const server = await startMockRegistry({ [KID]: activeRecord(KID) })
  t.after(() => server.close())

  const registry = new KeyRegistry(configFor(server.url, { registryTtlMs: 5000 }))
  const first = await registry.lookup(KID)
  const second = await registry.lookup(KID)

  assert.equal(first.cached, false)
  assert.equal(second.cached, true)
  assert.equal(server.countFor(KID), 1, 'the second lookup must not hit the network')
})

test('a zero TTL disables the cache', async (t) => {
  const server = await startMockRegistry({ [KID]: activeRecord(KID) })
  t.after(() => server.close())

  const registry = new KeyRegistry(configFor(server.url, { registryTtlMs: 0 }))
  await registry.lookup(KID)
  await registry.lookup(KID)
  assert.equal(server.countFor(KID), 2)
})

test('the cache expires, and a revocation becomes visible after it', async (t) => {
  const server = await startMockRegistry({ [KID]: activeRecord(KID) })
  t.after(() => server.close())

  const registry = new KeyRegistry(configFor(server.url, { registryTtlMs: 50 }))
  assert.equal((await registry.lookup(KID)).status, 'active')

  server.set(KID, activeRecord(KID, { status: 'revoked' }))
  // Still cached: this is the documented limit, not a bug.
  assert.equal((await registry.lookup(KID)).status, 'active')

  await new Promise((r) => setTimeout(r, 60))
  assert.equal((await registry.lookup(KID)).status, 'revoked')
})

test('clearCache makes a revocation visible immediately', async (t) => {
  const server = await startMockRegistry({ [KID]: activeRecord(KID) })
  t.after(() => server.close())

  const registry = new KeyRegistry(configFor(server.url, { registryTtlMs: 60_000 }))
  await registry.lookup(KID)
  server.set(KID, activeRecord(KID, { status: 'revoked' }))
  registry.clearCache()
  assert.equal((await registry.lookup(KID)).status, 'revoked')
})

// A batch of envelopes from one signer arriving on a cold cache must not open
// one connection per envelope.
test('concurrent lookups of one kid collapse into a single request', async (t) => {
  const server = await startMockRegistry({ [KID]: activeRecord(KID) })
  server.setLatency(50)
  t.after(() => server.close())

  const registry = new KeyRegistry(configFor(server.url))
  const results = await Promise.all(Array.from({ length: 8 }, () => registry.lookup(KID)))

  assert.equal(server.countFor(KID), 1)
  for (const r of results) assert.equal(r.status, 'active')
})

// ── request shape ───────────────────────────────────────────────────────────

test('a configured licence key is sent as a bearer token', async (t) => {
  const server = await startMockRegistry({ [KID]: activeRecord(KID) })
  t.after(() => server.close())

  await new KeyRegistry(configFor(server.url, { licenceKey: 'kxco_live_abc123' })).lookup(KID)
  assert.equal(server.requests.at(-1).headers.authorization, 'Bearer kxco_live_abc123')
})

test('registry reads work without a licence, so the free path stays free', async (t) => {
  const server = await startMockRegistry({ [KID]: activeRecord(KID) })
  t.after(() => server.close())

  const registry = new KeyRegistry(networkConfig({ registryUrl: server.url }))
  assert.equal((await registry.lookup(KID)).status, 'active')
  assert.equal(server.requests.at(-1).headers.authorization, undefined)
})

test('a malformed kid is rejected before any request is made', async (t) => {
  const server = await startMockRegistry({})
  t.after(() => server.close())

  const registry = new KeyRegistry(configFor(server.url))
  for (const bad of ['', 'AA29F37AB7F4B2CF', 'zz', KID + '00', '../../etc/passwd']) {
    await assert.rejects(() => registry.lookup(bad), (e) => e.code === 'BAD_KID', JSON.stringify(bad))
  }
  assert.equal(server.requests.length, 0)
})

// The on-chain credential carries an expiresAt and the registry reports it.
// Folding this into 'unknown' would still fail closed, but it would tell an
// operator "never heard of this key" about one that simply ran out.
test('an expired credential is reported as expired, not unknown', async (t) => {
  const server = await startMockRegistry({ [KID]: activeRecord(KID, { status: 'expired' }) })
  t.after(() => server.close())
  assert.equal((await new KeyRegistry(configFor(server.url)).lookup(KID)).status, 'expired')
})
