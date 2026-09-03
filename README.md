# kxco-pq-network

Verification modes for KXCO post-quantum envelopes.

This package is the boundary between what is free and what is sold.

The maths is free and stays free. `kxco-post-quantum` and `kxco-verify` are Apache-2.0, chain-agnostic, and work offline with no KXCO server anywhere in the path. Nothing here changes that.

What this package adds is the answer to a question offline cryptography cannot answer: **is this key still allowed to sign, today?** A signature made by a key that was revoked an hour ago is still a perfectly valid signature. A verifier that only checks the maths will accept it forever.

---

## Install

```bash
npm install kxco-pq-network
```

Node 20.19+. ESM only.

---

## The three modes

| Mode | Checks | Network at verify time | Licence |
|---|---|---|---|
| `signature` | The maths | None | No |
| `anchored` | The maths, plus an Armature L1 anchor carried by the envelope | None | No |
| `anchored+live` | Anchored, plus a live key-registry lookup | Yes, fails closed | **Yes** |

`signature` is what `kxco-post-quantum` has always done. It works offline, forever.

`anchored` additionally requires the envelope to carry chain id `1111111` and a transaction hash. The anchor travels inside the envelope, so an air-gapped verifier can check it. What it cannot tell you is whether the key is still good.

`anchored+live` answers "should I act on this now". It needs a hosted registry, and that is the part we sell.

```js
import { networkConfigFromEnv, applyVerifyMode, FAILURE } from 'kxco-pq-network'
import { verify } from 'kxco-pq-attest'

const config = networkConfigFromEnv()             // reads KXCO_VERIFY_MODE etc.
const signature = verify(envelope, publicKey)     // your own crypto check

const result = await applyVerifyMode({
  envelope,
  signatureValid: signature.valid,
  kid: envelope.kid,
  config,
})

if (!result.valid) {
  switch (result.reason) {
    case FAILURE.SIGNATURE_INVALID:      // the document is not what it claims
    case FAILURE.KID_REVOKED:            // valid signature, key no longer trusted
    case FAILURE.REGISTRY_UNREACHABLE:   // we could not ask; see below
  }
}
```

`applyVerifyMode` does no cryptography. Each package owns its own envelope shape and signing message, and a second definition of "valid signature" here would be one definition too many. You check the maths; this decides what the mode requires on top of it.

---

## It fails closed

If the registry cannot be reached, `anchored+live` returns **invalid**. Not valid-with-a-warning.

A mode whose entire purpose is to catch a revoked key must not quietly degrade into the mode that cannot, precisely when the network is behaving oddly — which is precisely when an attacker would arrange for it to be. Callers who would rather have the weaker answer than no answer should ask for `anchored` and get it deterministically.

A **JSON** `404` is treated as an **answer**, not a failure: the registry was reached and has never heard of that key. That is a definite "do not trust", and it is reported as `kid_unknown`, not `registry_unreachable`. The distinction is the whole design.

A `404` that is **not** JSON is the opposite. Point `registryUrl` at a web app and you get that app's 404 page back, and reading a page of HTML as "this key is unknown" would state a fact about a key on the strength of a misconfigured URL. The content type decides which of the two it is.

---

## Caching, and what it costs you

Lookups are cached by kid for `registryTtlMs`, 60 seconds by default. Concurrent lookups of the same kid collapse into one request, so a batch of envelopes from one signer arriving on a cold cache opens one connection, not one per envelope.

**The limit this creates, stated plainly:** at the 60 second default, a revoked key stays accepted for up to a minute after revocation. Set `registryTtlMs: 0` to trade that for a lookup per verification, or call `registry.clearCache()` when you receive a rotation webhook.

---

## Configuration

Everything a customer sets to go live:

```bash
KXCO_VERIFY_MODE=anchored+live
KXCO_LICENCE_KEY=kxco_live_...
KXCO_REGISTRY_URL=https://chain.kxco.ai     # default
KXCO_RELAY_URL=https://relay.kxco.ai        # default
KXCO_REGISTRY_TTL_MS=60000                  # default
```

`chainId` is not a configuration option. It is `1111111` and passing anything else throws. Accepting another chain would mean an anchor written somewhere else could satisfy a KXCO verify, which is the one thing the anchor exists to prove.

---

## Registry contract

`GET /kids/:kid` on the registry base URL. `kid` is 16 lowercase hex characters.

> **Status, 3 September 2026.** This endpoint is **implemented but not yet deployed**. The handler lives in `kxco-chain-live/explorer-public` (`src/pages/api/kids/[kid].js`, published at `/kids/:kid` by a rewrite) and reads the `KXCOIdentityRegistry` contract at `0x87776E97F981DdEF0b77469c67E222B106B94319` on chain 1111111. It is verified end to end against a scripted chain, including the `kxco-pq-network` client itself.
>
> Until it is deployed, `https://chain.kxco.ai/kids/<kid>` still serves the marketing site's HTML 404. The client detects that and reports `REGISTRY_UNREACHABLE` rather than reading it as "this key is unknown", so `anchored+live` fails closed against production and `anchored` is the strongest mode that works end to end today.

```json
{
  "kid": "aa29f37ab7f4b2cf",
  "publicKey": "<hex or jwk>",
  "status": "active",
  "rotatedTo": null,
  "institutionId": "org_...",
  "chainId": 1111111,
  "asOfBlock": 1234567
}
```

`status` is `active`, `revoked` or `rotated`. **Any value this build does not recognise is treated as `unknown`**, so a status added in a later release cannot fall out of the "is it active" check as though it were active.

A record whose `kid` does not match what was asked for is refused. The comparison is constant-time. A registry that answers about a different key is either broken or being interposed, and either way its answer is unusable.

The registry read is metered where a licence is configured and rate-limited where one is not. Reads without a licence are allowed — that is how the free path stays free.

---

## Metering

`meter()` and `usageEvent()` emit structured events for `anchor_written`, `kid_registered`, `kid_revoked`, `kid_rotated`, `relay_post`, `registry_read` and `verify`.

They emit; they do not aggregate, invoice, or phone home. The default sink is one JSON line on stdout, because that is what every log shipper already parses.

**The licence key is never emitted in full.** Only the first 8 characters, which is enough to attribute an event and useless to anyone who reads the log. Logs get shipped to places the key was never meant to reach.

---

## What this does NOT do

- No cryptography. It never verifies a signature.
- No key generation or storage.
- No relay writes — that is `kxco-pq-chain`.
- It does not make a signature valid or invalid. It decides what a mode requires **on top of** a signature check you performed.

---

## Why this is its own package

`kxco-pq-sdk` already depends on `kxco-pq-attest`. Putting this module inside the SDK and having attest import it would make a dependency cycle. It is separate because it has to be, not for tidiness.

---

## Security

Cryptographic primitives come from `kxco-post-quantum`, which wraps `@noble/post-quantum`. **That upstream package has not been independently audited by a third party**; it has been self-audited by its maintainer. The other Noble packages have been audited, but separately and at different times: `@noble/hashes` by Cure53 in January 2022, `@noble/curves` by Trail of Bits in February 2023, Kudelski in September 2023 and Cure53 in September 2024, and `@noble/ciphers` by Cure53 in September 2024. None of those engagements covered the post-quantum package. This package has had no third-party assessment either. See [`kxco-post-quantum/AUDIT.md`](https://github.com/KnightsbridgeAIQ/kxco-post-quantum/blob/main/AUDIT.md) for the full posture.

To report a vulnerability, open a [private security advisory](https://github.com/KnightsbridgeAIQ/kxco-pq-network/security/advisories/new) or email **security@kxco.ai**.

---

## License

Apache-2.0. Use of the hosted registry, relay and anchoring service is governed separately — see `LICENCE-PRODUCT.md`.

---

## Maintainers

Shayne Heffernan and John Heffernan — [KXCO by Knightsbridge](https://kxco.ai)
