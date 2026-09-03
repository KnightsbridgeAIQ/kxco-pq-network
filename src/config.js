// Network configuration, and the three verification modes.
//
// The modes are the product boundary, so they are worth stating plainly.
//
//   signature      the maths, and nothing else. Works offline, forever, with
//                  no KXCO server in the path and no licence. This is what
//                  kxco-post-quantum and kxco-verify do, and it stays free.
//
//   anchored       the maths, plus proof that the envelope was written to
//                  Armature L1: chain id 1111111 and a transaction hash inside
//                  the envelope. Still no HTTP at verify time — the anchor is
//                  carried by the envelope, so an air-gapped verifier can
//                  check it. What it cannot tell you is whether the key is
//                  still good today.
//
//   anchored+live  anchored, plus a live registry lookup that says whether the
//                  signing key is still active. This is the mode that answers
//                  "should I act on this now", and it is the one that needs a
//                  hosted registry.
//
// Only the maths is free. What we sell is the answer to whether a key is still
// allowed to sign, which is a fact about the present that no amount of
// offline cryptography can supply.

import { KxcoPqNetworkError } from './errors.js'

/** Armature L1. The only chain this package will accept an anchor from. */
export const CHAIN_ID = 1111111

export const DEFAULT_REGISTRY_URL = 'https://chain.kxco.ai'
export const DEFAULT_RELAY_URL = 'https://relay.kxco.ai'
export const DEFAULT_REGISTRY_TTL_MS = 60_000

export const VERIFY_MODES = ['signature', 'anchored', 'anchored+live']

/**
 * Normalise and validate a network configuration.
 *
 * A missing licence key is not an error here. It becomes one at the point of
 * use, where the message can say what the caller was actually trying to do:
 * "signature" needs no licence at all, and refusing to construct a config
 * without one would break the free path.
 *
 * @param {object} [config]
 * @returns {Required<Pick<object,never>> & {
 *   chainId: number, registryUrl: string, relayUrl: string,
 *   verifyMode: string, licenceKey: string|null, registryTtlMs: number,
 *   fetchImpl: typeof fetch, timeoutMs: number,
 * }}
 */
export function networkConfig(config = {}) {
  if (config === null || typeof config !== 'object') {
    throw new KxcoPqNetworkError('network config must be an object', { code: 'BAD_CONFIG' })
  }

  const {
    chainId = CHAIN_ID,
    registryUrl = DEFAULT_REGISTRY_URL,
    relayUrl = DEFAULT_RELAY_URL,
    verifyMode = 'signature',
    licenceKey = null,
    registryTtlMs = DEFAULT_REGISTRY_TTL_MS,
    fetchImpl,
    timeoutMs = 10_000,
  } = config

  // A different chain id is not a configuration option. Accepting one would
  // mean an anchor written to some other chain could satisfy a KXCO verify,
  // which is the whole thing the anchor is supposed to prove.
  if (chainId !== CHAIN_ID) {
    throw new KxcoPqNetworkError(
      `chainId must be ${CHAIN_ID} (Armature L1), got ${chainId}`,
      { code: 'WRONG_CHAIN' },
    )
  }

  if (!VERIFY_MODES.includes(verifyMode)) {
    throw new KxcoPqNetworkError(
      `unknown verifyMode '${verifyMode}' — expected one of ${VERIFY_MODES.join(', ')}`,
      { code: 'BAD_CONFIG' },
    )
  }

  for (const [name, value] of [['registryUrl', registryUrl], ['relayUrl', relayUrl]]) {
    if (typeof value !== 'string' || !/^https?:\/\//.test(value)) {
      throw new KxcoPqNetworkError(`${name} must be an http(s) URL, got ${value}`, { code: 'BAD_CONFIG' })
    }
  }

  if (!Number.isFinite(registryTtlMs) || registryTtlMs < 0) {
    throw new KxcoPqNetworkError('registryTtlMs must be a non-negative number', { code: 'BAD_CONFIG' })
  }

  return {
    chainId,
    registryUrl: registryUrl.replace(/\/$/, ''),
    relayUrl: relayUrl.replace(/\/$/, ''),
    verifyMode,
    licenceKey: licenceKey || null,
    registryTtlMs,
    // Captured so a test can inject a mock without touching globals, and so a
    // caller in a runtime with a scoped fetch can pass their own.
    fetchImpl: fetchImpl ?? globalThis.fetch,
    timeoutMs,
  }
}

/**
 * Read a configuration out of the environment.
 *
 * This is the whole of what a customer has to set to go live, which is why it
 * is one function and not a framework.
 *
 * @param {Record<string,string|undefined>} [env]
 * @param {object} [overrides]
 */
export function networkConfigFromEnv(env = process.env, overrides = {}) {
  return networkConfig({
    registryUrl: env.KXCO_REGISTRY_URL || undefined,
    relayUrl: env.KXCO_RELAY_URL || undefined,
    verifyMode: env.KXCO_VERIFY_MODE || undefined,
    licenceKey: env.KXCO_LICENCE_KEY || env.KXCO_LICENSE_KEY || null,
    registryTtlMs: env.KXCO_REGISTRY_TTL_MS ? Number(env.KXCO_REGISTRY_TTL_MS) : undefined,
    ...overrides,
  })
}
