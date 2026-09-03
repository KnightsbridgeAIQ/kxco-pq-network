// The three modes, applied to an envelope whose signature has already been
// checked.
//
// This module does not do cryptography. Each package owns its own envelope
// shape and its own signing message, and duplicating that here would mean two
// definitions of what a valid signature is. Instead the caller checks the
// maths and hands the outcome in, and this decides what the mode requires on
// top of it.
//
// The order matters: signature first, always. A revoked key that signed
// nothing should be reported as a bad signature, not as a revocation, because
// the two lead a reader to different conclusions about what happened.

import { CHAIN_ID } from './config.js'
import { FAILURE, KxcoPqNetworkError } from './errors.js'
import { KeyRegistry } from './registry.js'

/**
 * Read the anchor out of an envelope, whichever of the two shapes it uses.
 *
 * kxco-pq-attest wrote `chainAnchor: { txHash, blockNumber }` before this
 * package existed, and the current shape is `chainId` alongside
 * `anchor: { txHash, blockNumber }`. Both are accepted so that envelopes
 * already in customers' archives keep verifying.
 *
 * @param {object} envelope
 * @returns {{ txHash: string, blockNumber?: number, chainId: number|undefined }|null}
 */
export function readAnchor(envelope) {
  if (!envelope || typeof envelope !== 'object') return null

  const anchor = envelope.anchor ?? envelope.chainAnchor
  if (!anchor || typeof anchor !== 'object') return null
  if (typeof anchor.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(anchor.txHash)) return null

  return {
    txHash: anchor.txHash,
    blockNumber: anchor.blockNumber,
    // The envelope-level chainId is the current shape. An older envelope with
    // only chainAnchor and no chainId is treated as unstated, not as wrong:
    // it predates the field, and rejecting it would break archives.
    chainId: envelope.chainId ?? anchor.chainId,
  }
}

/**
 * Apply a verification mode.
 *
 * @param {object} opts
 * @param {object}  opts.envelope        — the envelope being verified
 * @param {boolean} opts.signatureValid  — the caller's own signature check
 * @param {string}  opts.kid             — the signing kid
 * @param {object}  opts.config          — from networkConfig()
 * @param {KeyRegistry} [opts.registry]  — reuse one to share its cache
 * @returns {Promise<{ valid: boolean, mode: string, reason?: string,
 *                     detail?: string, anchor?: object, registry?: object }>}
 */
export async function applyVerifyMode({ envelope, signatureValid, kid, config, registry }) {
  const mode = config.verifyMode

  if (!signatureValid) {
    return { valid: false, mode, reason: FAILURE.SIGNATURE_INVALID }
  }

  if (mode === 'signature') {
    return { valid: true, mode }
  }

  // ── anchored ──────────────────────────────────────────────────────────────

  const anchor = readAnchor(envelope)
  if (!anchor) {
    return {
      valid: false,
      mode,
      reason: FAILURE.NOT_ANCHORED,
      detail:
        'this envelope carries no Armature L1 anchor. It was signed in signature mode; ' +
        're-issue it with anchor: true, or verify it in signature mode.',
    }
  }

  if (anchor.chainId !== undefined && anchor.chainId !== CHAIN_ID) {
    return {
      valid: false,
      mode,
      reason: FAILURE.WRONG_CHAIN,
      detail: `anchor names chain ${anchor.chainId}; this verifier accepts only ${CHAIN_ID} (Armature L1)`,
      anchor,
    }
  }

  if (mode === 'anchored') {
    return { valid: true, mode, anchor }
  }

  // ── anchored+live ─────────────────────────────────────────────────────────

  if (!config.licenceKey) {
    return {
      valid: false,
      mode,
      reason: FAILURE.LICENCE_REQUIRED,
      detail:
        'anchored+live performs a live key-registry lookup and needs a licence key. ' +
        'Set KXCO_LICENCE_KEY, or use anchored, which needs none.',
      anchor,
    }
  }

  const client = registry ?? new KeyRegistry(config)

  let record
  try {
    record = await client.lookup(kid)
  } catch (err) {
    if (!(err instanceof KxcoPqNetworkError)) throw err
    // Fails closed. The point of this mode is to catch a key that is no longer
    // good; degrading to "probably fine" when the registry is unreachable
    // would remove exactly the protection the customer is paying for, at
    // exactly the moment it is most likely to matter.
    return {
      valid: false,
      mode,
      reason: FAILURE.REGISTRY_UNREACHABLE,
      detail: `${err.message}. anchored+live fails closed; use anchored for an offline answer.`,
      anchor,
    }
  }

  if (record.status === 'active') {
    return { valid: true, mode, anchor, registry: record }
  }

  const reason = {
    revoked: FAILURE.KID_REVOKED,
    rotated: FAILURE.KID_ROTATED,
    expired: FAILURE.KID_EXPIRED,
  }[record.status] ?? FAILURE.KID_UNKNOWN

  return {
    valid: false,
    mode,
    reason,
    detail:
      record.status === 'rotated' && record.rotatedTo
        ? `kid ${kid} was rotated to ${record.rotatedTo}`
        : `registry reports kid ${kid} as ${record.status}`,
    anchor,
    registry: record,
  }
}
