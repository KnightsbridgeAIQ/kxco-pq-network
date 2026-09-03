/// <reference types="node" />

/** Armature L1. The only chain an anchor may name. */
export const CHAIN_ID: 1111111

export const DEFAULT_REGISTRY_URL: 'https://chain.kxco.ai'
export const DEFAULT_RELAY_URL: 'https://relay.kxco.ai'
export const DEFAULT_REGISTRY_TTL_MS: 60000

/**
 * - `signature`     — crypto only. Offline, free, no KXCO server in the path.
 * - `anchored`      — crypto, plus an Armature L1 anchor carried by the
 *                     envelope. Still no HTTP at verify time.
 * - `anchored+live` — anchored, plus a live registry lookup. Fails closed if
 *                     the registry is unreachable. Requires a licence key.
 */
export type VerifyMode = 'signature' | 'anchored' | 'anchored+live'

export const VERIFY_MODES: VerifyMode[]

export interface NetworkConfigInput {
  /** Must be 1111111 if given. Any other value throws. */
  chainId?: 1111111
  /** Defaults to https://chain.kxco.ai */
  registryUrl?: string
  /** Defaults to https://relay.kxco.ai */
  relayUrl?: string
  /** Defaults to 'signature'. */
  verifyMode?: VerifyMode
  licenceKey?: string | null
  /** Defaults to 60000. Zero disables the cache. */
  registryTtlMs?: number
  /** Defaults to globalThis.fetch. Inject to test, or to use a scoped fetch. */
  fetchImpl?: typeof fetch
  /** Defaults to 10000. */
  timeoutMs?: number
}

export interface NetworkConfig {
  chainId: 1111111
  registryUrl: string
  relayUrl: string
  verifyMode: VerifyMode
  licenceKey: string | null
  registryTtlMs: number
  fetchImpl: typeof fetch
  timeoutMs: number
}

/** Normalise and validate a configuration. Throws on a wrong chain id or mode. */
export function networkConfig(config?: NetworkConfigInput): NetworkConfig

/**
 * Read a configuration from the environment:
 * `KXCO_REGISTRY_URL`, `KXCO_RELAY_URL`, `KXCO_VERIFY_MODE`,
 * `KXCO_LICENCE_KEY` (or `KXCO_LICENSE_KEY`), `KXCO_REGISTRY_TTL_MS`.
 */
export function networkConfigFromEnv(
  env?: Record<string, string | undefined>,
  overrides?: NetworkConfigInput,
): NetworkConfig

// ── registry ────────────────────────────────────────────────────────────────

export type KidStatus = 'active' | 'revoked' | 'rotated' | 'expired' | 'unknown'

export const KID_STATUS: ['active', 'revoked', 'rotated', 'expired']

export interface KidRecord {
  kid: string
  status: KidStatus
  publicKey?: string
  rotatedTo?: string | null
  institutionId?: string
  chainId: 1111111
  asOfBlock?: number
  /** Whether this answer came from the TTL cache. */
  cached: boolean
}

export class KeyRegistry {
  constructor(config: NetworkConfig)
  /**
   * `GET /kids/:kid`. Cached for `registryTtlMs`; concurrent lookups of the
   * same kid share one request.
   *
   * A 404 resolves to `status: 'unknown'` — the registry was reached and does
   * not know the key. Being unable to reach it throws instead, so a caller can
   * tell "definitely not trusted" from "could not ask".
   */
  lookup(kid: string): Promise<KidRecord>
  clearCache(): void
}

// ── modes ───────────────────────────────────────────────────────────────────

export const FAILURE: {
  SIGNATURE_INVALID: 'signature_invalid'
  MALFORMED: 'malformed'
  NOT_ANCHORED: 'not_anchored'
  WRONG_CHAIN: 'wrong_chain'
  KID_REVOKED: 'kid_revoked'
  KID_ROTATED: 'kid_rotated'
  KID_EXPIRED: 'kid_expired'
  KID_UNKNOWN: 'kid_unknown'
  REGISTRY_UNREACHABLE: 'registry_unreachable'
  LICENCE_REQUIRED: 'licence_required'
}

export interface EnvelopeAnchor {
  txHash: string
  blockNumber?: number
  chainId?: number
}

/** Read the anchor from either the current `anchor` shape or the legacy `chainAnchor`. */
export function readAnchor(envelope: unknown): EnvelopeAnchor | null

export interface VerifyModeResult {
  valid: boolean
  mode: VerifyMode
  /** One of FAILURE's values, when invalid. */
  reason?: string
  /** Human-readable detail, when invalid. */
  detail?: string
  anchor?: EnvelopeAnchor
  registry?: KidRecord
}

/**
 * Apply a verification mode on top of a signature check the caller performed.
 *
 * This does no cryptography: each package owns its own envelope shape and
 * signing message, and a second definition of "valid signature" here would be
 * one definition too many.
 */
export function applyVerifyMode(opts: {
  envelope: unknown
  signatureValid: boolean
  kid: string
  config: NetworkConfig
  /** Pass one to share its cache across verifications. */
  registry?: KeyRegistry
}): Promise<VerifyModeResult>

// ── errors and metering ─────────────────────────────────────────────────────

export class KxcoPqNetworkError extends Error {
  name: 'KxcoPqNetworkError'
  code: string
  status: number | null
}

export const EVENTS: string[]

/** First 8 characters of a licence key. Never the whole key. */
export function licencePrefix(licenceKey: string | null | undefined): string | null

export function usageEvent(
  event: string,
  fields?: { institutionId?: string; kid?: string; licenceKey?: string; [k: string]: unknown },
): Record<string, unknown>

/** Build and emit a usage event. Default sink is one JSON line on stdout. */
export function meter(
  event: string,
  fields?: Record<string, unknown>,
  sink?: (record: Record<string, unknown>) => void,
): Record<string, unknown>
