// Structured usage events.
//
// Seats are priced per institution, and anchors and registry reads are
// metered, so the code that performs them has to say so in a shape a billing
// pipeline can read. This is the metre hook and nothing more: it emits, it
// does not aggregate, invoice, or phone home.
//
// The licence key is never emitted in full. A prefix is enough to attribute an
// event to a customer and useless to anyone who intercepts a log line, and
// logs get shipped to places the key was never meant to reach.

/** Events this package and its callers emit. */
export const EVENTS = [
  'anchor_written',
  'kid_registered',
  'kid_revoked',
  'kid_rotated',
  'relay_post',
  'registry_read',
  'verify',
]

const LICENCE_PREFIX_LENGTH = 8

/** First 8 characters of a licence key, for attribution. Never the whole key. */
export function licencePrefix(licenceKey) {
  if (typeof licenceKey !== 'string' || licenceKey.length === 0) return null
  return licenceKey.slice(0, LICENCE_PREFIX_LENGTH)
}

/**
 * Build a usage event. Returns the record rather than writing it, so the
 * caller's own logger decides where it goes.
 *
 * @param {string} event — one of EVENTS
 * @param {{ institutionId?: string, kid?: string, licenceKey?: string,
 *           [k: string]: unknown }} fields
 */
export function usageEvent(event, fields = {}) {
  const { licenceKey, ...rest } = fields
  return {
    event,
    at: new Date().toISOString(),
    chainId: 1111111,
    ...rest,
    licencePrefix: licencePrefix(licenceKey),
  }
}

/**
 * Emit a usage event through a sink.
 *
 * The default sink is a single JSON line on stdout, because that is what every
 * log shipper already parses. Pass your own to send it somewhere else.
 *
 * @param {string} event
 * @param {object} fields
 * @param {(record: object) => void} [sink]
 */
export function meter(event, fields = {}, sink) {
  const record = usageEvent(event, fields)
  if (sink) sink(record)
  else console.log(JSON.stringify(record))
  return record
}
