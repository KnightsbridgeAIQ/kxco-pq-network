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
import { KeyRegistry, DEFAULT_ALG } from './registry.js'

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
 * @param {string}  [opts.alg]           The ML-DSA parameter set the caller
 *   verified the signature under, which the key decides. Omitted, with no
 *   `alg` on the envelope either, it means ML-DSA-65, which is what every
 *   caller verified before the field existed.
 * @returns {Promise<{ valid: boolean, mode: string, reason?: string,
 *                     detail?: string, anchor?: object, registry?: object }>}
 */
export async function applyVerifyMode({ envelope, signatureValid, kid, config, registry, alg }) {
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
    // The record must describe this key as the parameter set it is. The kid is
    // a fingerprint, so a record for the right kid under the wrong set is a
    // registry that is wrong or interposed, or an envelope claiming a set its
    // key is not; either way the answer cannot be relied on. Checked only on
    // an active record, so revoked, rotated and unknown keep their own reasons.
    const held = record.alg ?? DEFAULT_ALG
    const claims = [['key', alg], ['envelope', envelope?.alg]].filter(([, v]) => v !== undefined)
    if (claims.length === 0) claims.push(['key', DEFAULT_ALG])
    const disagreeing = claims.find(([, v]) => v !== held)
    if (disagreeing) {
      const [source, value] = disagreeing
      return {
        valid: false,
        mode,
        reason: FAILURE.ALG_MISMATCH,
        detail: `the registry holds kid ${kid} as ${held}, but the ${source} is ${value}`,
        anchor,
        registry: record,
      }
    }
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
