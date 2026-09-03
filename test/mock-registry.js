// A real HTTP registry, on a loopback port.
//
// Not a stubbed fetch. The behaviours that matter here are HTTP behaviours —
// a 404 that means "unknown" rather than "unreachable", a timeout, a body that
// is not JSON, a record answering about the wrong kid — and a fake fetch would
// let us assert against our own idea of them instead of the real thing.

import { createServer } from 'node:http'

/**
 * @param {Record<string, object|number|'garbage'|'hang'>} kids
 *   kid -> a record to serve, an HTTP status to return, 'garbage' for a
 *   non-JSON body, or 'hang' to never respond.
 */
export async function startMockRegistry(kids = {}) {
  const requests = []
  let latencyMs = 0

  const server = createServer(async (req, res) => {
    requests.push({ url: req.url, headers: req.headers, method: req.method })

    if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs))

    const match = /^\/kids\/([0-9a-f]{16})$/.exec(req.url ?? '')
    if (!match) {
      res.writeHead(404).end('{}')
      return
    }

    const entry = kids[match[1]]

    if (entry === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unknown kid' }))
      return
    }
    if (entry === 'hang') return // never responds; the client's timeout must fire
    if (entry === 'webpage') {
      // What https://chain.kxco.ai/kids/<kid> actually serves today: the
      // marketing site's 404 page, ~26KB of HTML. Not a registry answer.
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
         .end('<!DOCTYPE html><html><head><title>404</title></head><body>Not found</body></html>')
      return
    }
    if (entry === 'garbage') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('<html>not json</html>')
      return
    }
    if (typeof entry === 'number') {
      res.writeHead(entry, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'upstream' }))
      return
    }

    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(entry))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    /** How many times a kid was asked for. The cache assertions read this. */
    countFor(kid) {
      return requests.filter((r) => r.url === `/kids/${kid}`).length
    },
    setLatency(ms) {
      latencyMs = ms
    },
    set(kid, entry) {
      kids[kid] = entry
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** A well-formed active record. */
export function activeRecord(kid, extra = {}) {
  return {
    kid,
    publicKey: 'ab'.repeat(1952),
    status: 'active',
    rotatedTo: null,
    institutionId: 'org_test',
    chainId: 1111111,
    asOfBlock: 1234567,
    ...extra,
  }
}
