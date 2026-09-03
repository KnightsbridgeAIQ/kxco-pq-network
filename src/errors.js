// One error type, with a code a caller can branch on.
//
// The codes matter more than the messages here, because the two failures a
// customer must be able to tell apart — "this signature is forged" and "we
// could not reach the registry" — look identical in a boolean.

export class KxcoPqNetworkError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number|null, cause?: unknown }} [opts]
   */
  constructor(message, { code = 'NETWORK_ERROR', status = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'KxcoPqNetworkError'
    this.code = code
    this.status = status
  }
}

/**
 * Reasons a verification failed. A caller that treats every one of these the
 * same way is running a weaker check than it thinks it is.
 */
export const FAILURE = {
  /** The signature does not check out. The document is not what it claims. */
  SIGNATURE_INVALID: 'signature_invalid',
  /** Envelope structure is wrong or a required field is missing. */
  MALFORMED: 'malformed',
  /** The mode requires an anchor and the envelope carries none. */
  NOT_ANCHORED: 'not_anchored',
  /** The anchor names a chain that is not Armature L1. */
  WRONG_CHAIN: 'wrong_chain',
  /** The registry says this key was revoked. */
  KID_REVOKED: 'kid_revoked',
  /** The registry says this key was rotated out. */
  KID_ROTATED: 'kid_rotated',
  /** The credential is past its on-chain expiry. Not revoked — it ran out. */
  KID_EXPIRED: 'kid_expired',
  /** The registry has never heard of this key. */
  KID_UNKNOWN: 'kid_unknown',
  /** The registry could not be reached. Fails closed — see verifyEnvelope. */
  REGISTRY_UNREACHABLE: 'registry_unreachable',
  /** The mode needs a licence key and none was configured. */
  LICENCE_REQUIRED: 'licence_required',
}
