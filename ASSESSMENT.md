# Assessment notes

The answers a buyer's readiness assessment asks for: what this package does,
how it moves when algorithms move, and what it takes to run it.

## What this package is

The part that answers "should I act on this signature, now". It performs no
cryptography of its own, deliberately: each package owns its envelope shape and
its signing message, and a second definition of "valid signature" here would be
one definition too many. You check the maths; this decides what a verification
mode requires on top of it.

**Three modes, so a caller buys the assurance a decision warrants.**

| Mode | Checks | Network at verify time |
|---|---|---|
| `signature` | The maths | None |
| `anchored` | Plus an Armature L1 anchor carried by the envelope | None |
| `anchored+live` | Plus a live key-registry lookup | Yes, fails closed |

`signature` and `anchored` work offline, forever, with no dependency on us.
`anchored` is the one worth noticing: the anchor travels *inside* the envelope,
so an air-gapped verifier gets an independent time bound without a network call.
`anchored+live` is the mode that catches a revoked key, and it is the one we
sell.

**It fails closed, and that is the whole design.** If the registry cannot be
reached, `anchored+live` returns invalid. Not valid-with-a-warning. A mode whose
purpose is catching a revoked key must not quietly degrade into the mode that
cannot, precisely when the network is behaving oddly, which is precisely when an
attacker would arrange for it to. A caller who would rather have the weaker
answer than no answer asks for `anchored` and gets it deterministically.

**A 404 is an answer, not a failure — if it is JSON.** A JSON 404 means the
registry was reached and has never heard of that key: a definite "do not trust",
reported as `kid_unknown`. A non-JSON 404 is somebody's web app error page, and
reading that as "this key is unknown" would state a fact about a key on the
strength of a misconfigured URL. The content type decides which it is. That
distinction is the difference between a control and a coin toss.

**`chainId` is not configurable.** It is `1111111` and passing anything else
throws. An anchor written on another chain satisfying a KXCO verify would defeat
the thing the anchor exists to prove, so this is fixed on purpose.

**Caching is honest about what it costs.** Lookups cache by kid for
`registryTtlMs`, 60 seconds by default, and concurrent lookups of the same kid
collapse into one request, so a batch of envelopes from one signer on a cold
cache opens one connection rather than one per envelope. At the default a
revoked key stays accepted for up to a minute; set `registryTtlMs: 0` to trade
that for a lookup per verification, or call `registry.clearCache()` on a
rotation webhook. The number is documented so it can be chosen rather than
discovered.

## Scope

`applyVerifyMode` decides; the calling package verifies. That separation is what
lets every envelope format in the family share one policy layer without any of
them sharing a signature implementation.

`anchored+live` is where KXCO becomes part of the path: the registry must be
reachable and the mode requires a licence key. For a buyer that is a supplier
dependency worth putting in a continuity plan, and the mitigation is built in
and deterministic — `anchored` is free, offline and always available.

## Agility

No algorithms of its own, so nothing here to replace. Agility belongs to
whichever package produced the envelope, and to `kxco-post-quantum` beneath it.

What this package pins on purpose is the chain identity, for the reason above.

## Running it

**Release integrity.** From 1.0.3 every release carries a SLSA provenance
attestation, alongside a CycloneDX SBOM at a permanent unauthenticated URL and
an evidence bundle from `npm run evidence`. Verify with
`npm audit signatures kxco-pq-network`.

**Supported versions.** One line moving forward. Fixes land in the next release.

**Cost.** No hardware or runtime ceiling. The only cost that scales is the
registry round trip in `anchored+live`, and the cache and request collapsing are
the levers.

**Connections.** `chain.kxco.ai` and `relay.kxco.ai`, both negotiating the
hybrid key exchange group `X25519MLKEM768` under TLS 1.3. Measured 7 September
2026 with OpenSSL 3.5.6, and reproducible:

```
echo | openssl s_client -connect chain.kxco.ai:443 -servername chain.kxco.ai \
  -groups X25519MLKEM768 -tls1_3 2>&1 | grep "Negotiated TLS1.3 group"
```

So the connection carrying a registry lookup is itself protected against an
adversary recording it today to break later.

**Configuration.** Everything a deployment sets is an environment variable, and
the defaults are the production ones:

```bash
KXCO_VERIFY_MODE=anchored+live
KXCO_LICENCE_KEY=kxco_live_...
KXCO_REGISTRY_URL=https://chain.kxco.ai
KXCO_RELAY_URL=https://relay.kxco.ai
KXCO_REGISTRY_TTL_MS=60000
```

## Correcting this document

Every claim here is checkable against `src/`. The TLS measurement is
reproducible with the command given. If one does not match, that is a defect
worth reporting through the repository's issues.
