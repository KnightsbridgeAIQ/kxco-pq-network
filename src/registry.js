// Key registry client: GET /kids/:kid against the Armature L1 explorer.
//
// This answers the one question offline cryptography cannot: is this key still
// allowed to sign, today. A signature made by a key that was revoked an hour
// ago is still a perfectly valid signature, and a verifier that only checks
// the maths will accept it forever.
//
// Two design points are load-bearing.
//
// It fails CLOSED. If the registry cannot be reached, "anchored+live" returns
// invalid, not valid-with-a-warning. A mode whose whole purpose is to catch a
// revoked key must not degrade into the mode that cannot, precisely when the
// network is behaving oddly. Callers who would rather have the weaker answer
// than no answer can ask for "anchored" and get it deterministically.
//
// It caches by kid for registryTtlMs. Revocation is therefore visible within
// the TTL and not instantly, which is a real limit and is stated as one: at
// the 60 second default a revoked key stays accepted for up to a minute.
// Turning the cache off (registryTtlMs: 0) trades that for a lookup per
// verification.

import { kidEquals } from 'kxco-post-quantum'
import { KxcoPqNetworkError } from './errors.js'
import { CHAIN_ID } from './config.js'

// Whether a response claims to be JSON. Used to tell a registry answering from
// a web server answering, which matters most on a 404: one is a fact about a
// key, the other is a fact about the URL.
function isJson(response) {
  // A content-type is a media type plus parameters. Splitting it is exact,
  // and it avoids a regex over a header a remote server chose.
  const type = response.headers?.get?.('content-type') ?? ''
  const mediaType = type.split(';')[0].trim().toLowerCase()
  return mediaType === 'application/json' || mediaType.endsWith('+json')
}

/**
 * Statuses the registry may report. Anything else is treated as unknown.
 *
 * `expired` is here because the on-chain credential carries an `expiresAt` and
 * the registry reports it. Folding it into `unknown` would still fail closed,
 * but it would tell an operator "we have never heard of this key" about a key
 * that is registered, was never revoked, and simply ran out — which sends them
 * looking for the wrong problem.
 */
export const KID_STATUS = ['active', 'revoked', 'rotated', 'expired']

export class KeyRegistry {
  #url
  #ttlMs
  #fetch
  #timeoutMs
  #licenceKey
  #cache = new Map() // kid -> { record, expiresAt }
  #inflight = new Map() // kid -> Promise, so a burst is one request

  /**
   * @param {object} config — from networkConfig()
   */
  constructor(config) {
    this.#url = config.registryUrl
    this.#ttlMs = config.registryTtlMs
    this.#fetch = config.fetchImpl
    this.#timeoutMs = config.timeoutMs
    this.#licenceKey = config.licenceKey

    if (typeof this.#fetch !== 'function') {
      throw new KxcoPqNetworkError(
        'no fetch implementation available — pass fetchImpl in the network config',
        { code: 'BAD_CONFIG' },
      )
    }
  }

  /** Drop everything cached. For tests, and for a caller reacting to a rotation webhook. */
  clearCache() {
    this.#cache.clear()
  }

  /**
   * Look a kid up, through the cache.
   *
   * @param {string} kid
   * @returns {Promise<{ kid: string, status: string, publicKey?: string,
   *                     rotatedTo?: string|null, institutionId?: string,
   *                     chainId?: number, asOfBlock?: number, cached: boolean }>}
   * @throws {KxcoPqNetworkError} if the registry cannot be reached or answers badly
   */
  async lookup(kid) {
    if (typeof kid !== 'string' || !/^[0-9a-f]{16}$/.test(kid)) {
      throw new KxcoPqNetworkError(`kid must be 16 lowercase hex characters, got '${kid}'`, {
        code: 'BAD_KID',
      })
    }

    const now = Date.now()
    const hit = this.#cache.get(kid)
    if (hit && hit.expiresAt > now) return { ...hit.record, cached: true }

    // Collapse a burst for the same kid into one request. Without this, a
    // batch of envelopes from one signer opens one connection per envelope at
    // exactly the moment the cache is cold.
    const existing = this.#inflight.get(kid)
    if (existing) return { ...(await existing), cached: false }

    const request = this.#fetchKid(kid)
      .then((record) => {
        if (this.#ttlMs > 0) {
          this.#cache.set(kid, { record, expiresAt: Date.now() + this.#ttlMs })
        }
        return record
      })
      .finally(() => this.#inflight.delete(kid))

    this.#inflight.set(kid, request)
    return { ...(await request), cached: false }
  }

  async #fetchKid(kid) {
    const url = `${this.#url}/kids/${kid}`
    const ac = new AbortController()
    const tid = setTimeout(() => ac.abort(), this.#timeoutMs)

    let response
    try {
      response = await this.#fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          // The registry read is metered per licence where one is configured.
          // Reads without a licence are allowed, rate-limited, and are how the
          // free path stays free.
          ...(this.#licenceKey ? { authorization: `Bearer ${this.#licenceKey}` } : {}),
        },
        signal: ac.signal,
      })
    } catch (err) {
      throw new KxcoPqNetworkError(
        err.name === 'AbortError'
          ? `registry lookup timed out after ${this.#timeoutMs}ms`
          : `registry unreachable: ${err.message}`,
        { code: 'REGISTRY_UNREACHABLE', cause: err },
      )
    } finally {
      clearTimeout(tid)
    }

    // A 404 from the REGISTRY is an answer, not a failure: it was reached and
    // it has never heard of this kid. That is a definite "do not trust", and
    // it must not be confused with "we could not ask".
    //
    // A 404 from something that is not the registry is the opposite. Pointing
    // registryUrl at a web app gets back that app's 404 page, and reading a
    // page of HTML as "this key is unknown" would state a fact about a key on
    // the strength of a misconfigured URL. Measured, not hypothetical:
    // https://chain.kxco.ai/kids/<kid> currently serves 26KB of the marketing
    // site's 404 page.
    //
    // So the content type decides which of the two this is. JSON is the
    // registry answering; anything else is a wrong address, and a wrong
    // address is a reason we could not ask.
    if (response.status === 404) {
      if (!isJson(response)) {
        throw new KxcoPqNetworkError(
          `registry returned a non-JSON 404 from ${url} — this is a web page, not a registry ` +
          'answer. Check registryUrl: reading it as "kid unknown" would state a fact about a ' +
          'key on the strength of a misconfigured URL.',
          { code: 'REGISTRY_UNREACHABLE', status: 404 },
        )
      }
      return { kid, status: 'unknown', chainId: CHAIN_ID }
    }

    if (!response.ok) {
      throw new KxcoPqNetworkError(`registry returned ${response.status}`, {
        code: 'REGISTRY_UNREACHABLE',
        status: response.status,
      })
    }

    let body
    try {
      body = await response.json()
    } catch (err) {
      throw new KxcoPqNetworkError(
        `registry returned a non-JSON body from ${url}` +
        (isJson(response) ? '' : ' (content-type is not JSON — check registryUrl)'),
        { code: 'REGISTRY_UNREACHABLE', status: response.status, cause: err },
      )
    }

    return this.#validate(kid, body)
  }

  #validate(kid, body) {
    if (!body || typeof body !== 'object') {
      throw new KxcoPqNetworkError('registry record is not an object', { code: 'REGISTRY_BAD_RECORD' })
    }

    // The kid is compared in constant time, and it is compared at all because
    // a registry that answers about a different key than the one asked for is
    // either broken or being interposed. Either way the answer is unusable.
    if (typeof body.kid !== 'string' || !kidEquals(body.kid, kid)) {
      throw new KxcoPqNetworkError(
        `registry answered for kid '${body.kid}' but was asked about '${kid}'`,
        { code: 'REGISTRY_BAD_RECORD' },
      )
    }

    if (body.chainId !== undefined && body.chainId !== CHAIN_ID) {
      throw new KxcoPqNetworkError(
        `registry record names chain ${body.chainId}, expected ${CHAIN_ID}`,
        { code: 'WRONG_CHAIN' },
      )
    }

    // An unrecognised status becomes 'unknown' rather than being passed
    // through. A future status this build does not understand must not fall
    // out of the "is it active" check as though it were active.
    const status = KID_STATUS.includes(body.status) ? body.status : 'unknown'

    return {
      kid,
      status,
      publicKey: body.publicKey,
      rotatedTo: body.rotatedTo ?? null,
      institutionId: body.institutionId,
      chainId: CHAIN_ID,
      asOfBlock: body.asOfBlock,
    }
  }
}
