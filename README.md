# kxco-pq-network

**Three levels of proof for a post-quantum envelope: the signature offline, an Armature L1 anchor offline, and a live answer that the signing key is still trusted today.**

[![npm](https://img.shields.io/npm/v/kxco-pq-network?label=npm&color=b0964f)](https://www.npmjs.com/package/kxco-pq-network)
[![downloads](https://img.shields.io/npm/dm/kxco-pq-network?label=downloads&color=b0964f)](https://www.npmjs.com/package/kxco-pq-network)
[![NIST ACVP](https://img.shields.io/badge/NIST_ACVP-1,793_passed,_0_failed-2ea44f)](https://github.com/KnightsbridgeAIQ/kxco-post-quantum/blob/main/CONFORMANCE.md)
[![npm provenance](https://img.shields.io/badge/npm-provenance-2ea44f)](https://www.npmjs.com/package/kxco-pq-network)
[![Socket](https://socket.dev/api/badge/npm/package/kxco-pq-network)](https://socket.dev/npm/package/kxco-pq-network)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![node](https://img.shields.io/node/v/kxco-pq-network.svg)](https://nodejs.org)

Verification modes for KXCO post-quantum envelopes, and the line between what is free and what is sold. The maths is free and stays free: `kxco-post-quantum` and `kxco-verify` are Apache-2.0, chain-agnostic, and work offline with no KXCO server anywhere in the path. What this package adds is the answer to the question a signature alone leaves open: **is this key still allowed to sign, today?** A signature made by a key revoked an hour ago still checks out mathematically, and `anchored+live` is how you find out.

- **Three levels, one call.** `applyVerifyMode()` takes your own signature check and applies `signature`, `anchored` or `anchored+live`, so each decision gets the assurance it warrants.
- **Offline for good.** `signature` and `anchored` need no network at verify time, no licence and nothing from KXCO, and the anchor travels inside the envelope, so an air-gapped verifier can check it.
- **Catches a revoked key.** `anchored+live` asks the KXCO registry whether the signing key is `active`, `revoked`, `rotated` or `expired`, and reports each as its own reason.
- **Fails closed, by design.** If the registry cannot answer, `anchored+live` returns invalid with `registry_unreachable`, so the check you rely on to catch revocation holds when the network misbehaves.
- **A clean answer from the registry.** A JSON `404` is a definite `kid_unknown`, a web page from a misconfigured URL is `registry_unreachable`, and a record must name the key that was asked for.
- **Proven underneath.** 1,793 NIST ACVP vectors passed, 0 failed, and 225 interoperability checks against liboqs, Bouncy Castle and the Python reference implementations, 0 failed, in [`kxco-post-quantum`](https://github.com/KnightsbridgeAIQ/kxco-post-quantum/blob/main/CONFORMANCE.md).
- **A supply chain you can check.** A CycloneDX SBOM on every release, SLSA provenance from 1.0.3 onward, and every GitHub Action pinned by commit SHA.

**The migration has dates.**

- **NIST** published [FIPS 203](https://csrc.nist.gov/pubs/fips/203/final), [FIPS 204](https://csrc.nist.gov/pubs/fips/204/final) and [FIPS 205](https://csrc.nist.gov/pubs/fips/205/final) in August 2024.
- **United States:** [Executive Order 14412](https://www.federalregister.gov/documents/2026/06/25/2026-12909/securing-the-nation-against-advanced-cryptographic-attacks), signed on 22 June 2026, moves federal high-value and high-impact systems to post-quantum key establishment by 31 December 2030 and to post-quantum signatures by 31 December 2031. [OMB M-26-15](https://www.whitehouse.gov/wp-content/uploads/2026/06/M-26-15-Execution-of-the-Migration-to-Post-Quantum-Cryptography.pdf) requires PQC-agile libraries for all new applications.
- **United Kingdom:** the [NCSC](https://www.ncsc.gov.uk/guidance/pqc-migration-timelines) sets 2028, 2031 and 2035 as its migration milestones.

[Quick start](#quick-start) · [The three modes](#the-three-modes) · [Configuration](#configuration) · [For institutions](#for-institutions) · [Seats and metering](./SALES-SKU.md) · [Assessment notes](./ASSESSMENT.md) · [Changelog](./CHANGELOG.md) · [kxco.ai](https://kxco.ai)

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

`anchored` additionally requires the envelope to carry an Armature L1 transaction hash, and any chain id it names must be `1111111`. The anchor travels inside the envelope, so an air-gapped verifier can check it. For whether the key is still good today, use `anchored+live`.

`anchored+live` answers "should I act on this now". It needs a hosted registry, and that is the part we sell.

## Quick start

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

`applyVerifyMode` leaves the cryptography to the package that made the envelope: each owns its envelope shape and signing message, so there is one definition of a valid signature. You check the maths; this decides what the mode requires on top of it.

---

## It fails closed

If the registry cannot be reached, `anchored+live` returns **invalid**, with the reason `registry_unreachable`.

A mode whose purpose is to catch a revoked key keeps that purpose when the network is behaving oddly, which is exactly when an attacker would arrange for it to be. For an answer that needs no network, ask for `anchored` and get it deterministically.

A **JSON** `404` is an **answer**: the registry was reached and has never heard of that key. That is a definite "do not trust", reported as `kid_unknown` and kept distinct from `registry_unreachable`. The distinction is the whole design.

Any other `404` is the opposite. Point `registryUrl` at a web app and you get that app's error page back, which is a fact about the URL rather than the key, so it is reported as `registry_unreachable` and fails closed. The content type decides which of the two it is.

---

## Caching, and your revocation window

Lookups are cached by kid for `registryTtlMs`, 60 seconds by default. Concurrent lookups of the same kid collapse into one request, so a batch of envelopes from one signer arriving on a cold cache opens one connection, not one per envelope.

**You choose the revocation window.** At the 60 second default, the client reuses a registry answer for up to a minute, so a key revoked in that minute is refused from its next lookup. Set `registryTtlMs: 0` for a lookup on every verification, or call `registry.clearCache()` when you receive a rotation webhook.

---

## For institutions

The cryptography is free under Apache-2.0, works offline and needs nothing from
KXCO, now or in ten years. What KXCO sells is the part that has to be operated:
an answer about the present.

| Service | What you get |
|---|---|
| Hosted key registry | Whether a key is active, revoked or rotated, answered at verification time |
| Meta-transaction relay | KXCO validates your signed intent, pays the gas and submits it, so you never hold a token or run a node |
| On-chain anchoring | A timestamp on Armature L1 that the chain itself has verified |
| Live revocation | `anchored+live` verification, which confirms the signing key is still trusted now |
| Support and SLA | Availability commitments, an escalation path and a named contact |

Priced in USD, per seat, per year. No tokens, no nodes and no wallets. The line
between free and paid is set out in
[LICENCE-PRODUCT.md](https://github.com/KnightsbridgeAIQ/kxco-post-quantum/blob/main/LICENCE-PRODUCT.md).

**Talk to us: [admin@kxco.ai](mailto:admin@kxco.ai)** · [kxco.ai](https://kxco.ai)

Each seat, and how it is counted, is defined in [SALES-SKU.md](./SALES-SKU.md).

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

`chainId` is fixed at `1111111`, Armature L1, and passing anything else throws, so only an anchor written on Armature L1 can satisfy a KXCO verify.

---

## Registry contract

`GET /kids/:kid` on the registry base URL. `kid` is 16 lowercase hex characters.

The registry at `https://chain.kxco.ai` answers from the `KXCOIdentityRegistry` contract at `0x87776E97F981DdEF0b77469c67E222B106B94319` on chain 1111111, and each answer names the block it was read at.

```json
{
  "kid": "aa29f37ab7f4b2cf",
  "publicKey": "<hex or jwk>",
  "alg": "ML-DSA-87",
  "status": "active",
  "rotatedTo": null,
  "institutionId": "org_...",
  "chainId": 1111111,
  "asOfBlock": 1234567
}
```

`status` is `active`, `revoked`, `rotated` or `expired`. **Any other value is treated as `unknown`**, so only `active` ever passes the check.

A record must name the `kid` that was asked for, compared in constant time, so a misrouted or interposed answer is refused.

`alg` is the ML-DSA parameter set the registry holds the key under: `ML-DSA-65` or `ML-DSA-87`. **A record without `alg` means `ML-DSA-65`**, because every key registered before the field existed is one, so `KidRecord.alg` is always set on a record the registry returned. A non-string `alg` makes the record malformed. A name this build does not know is passed through unchanged and matches no key. The chain stores a hash of each key, which cannot say which set it is, so the registry learns `alg` when the key itself is presented to `POST /kids/:kid/key` with a signature proving possession; until then the record carries no `alg`.

In `anchored+live`, an active record must agree with the key that signed. Pass `alg`, the parameter set you verified the signature under (the key decides it), to `applyVerifyMode`; an `alg` on the envelope is checked as well. If either disagrees with the record the result is invalid with the reason `alg_mismatch`. With neither, the caller is taken to have verified ML-DSA-65, as every caller did before the field existed. Revoked, rotated, expired and unknown keys keep their own reasons.

The registry read is metered where a licence is configured and rate-limited where one is not. Reads without a licence are allowed, which is how the free path stays free.

---

## Metering

`meter()` and `usageEvent()` emit structured events for `anchor_written`, `kid_registered`, `kid_revoked`, `kid_rotated`, `relay_post`, `registry_read` and `verify`.

They emit to a sink you control and nowhere else. The default is one JSON line on stdout, which every log shipper already parses.

**The licence key is never emitted in full.** Only the first 8 characters, which is enough to attribute an event and useless to anyone who reads the log. Logs get shipped to places the key was never meant to reach.

---

## The KXCO post-quantum family

This decides what a verification mode requires, and both `kxco-pq-attest` and `kxco-pq-sdk` build on it. The rest of the family covers the jobs around it:

| You need to | Install |
|---|---|
| Put the whole stack in one install | [`kxco-pq`](https://www.npmjs.com/package/kxco-pq) |
| Use ML-DSA, ML-KEM and SLH-DSA directly | [`kxco-post-quantum`](https://www.npmjs.com/package/kxco-post-quantum) |
| Keep signing keys on the HSM you already run | [`kxco-pq-hsm`](https://www.npmjs.com/package/kxco-pq-hsm) |
| Sign a document or record anyone can verify offline | [`kxco-pq-attest`](https://www.npmjs.com/package/kxco-pq-attest) |
| Keep a tamper-evident audit trail | [`kxco-pq-audit`](https://www.npmjs.com/package/kxco-pq-audit) |
| Verify a signature in a browser, with no server | [`kxco-verify`](https://www.npmjs.com/package/kxco-verify) |
| Issue institution identity credentials | [`kxco-pq-sdk`](https://www.npmjs.com/package/kxco-pq-sdk) |
| Encrypt files and payloads to one or many recipients | [`kxco-pq-vault`](https://www.npmjs.com/package/kxco-pq-vault) |
| Encrypt Node streams and WebSockets | [`kxco-pq-tls`](https://www.npmjs.com/package/kxco-pq-tls) |
| Sign and verify webhooks | [`kxco-post-quantum-webhook`](https://www.npmjs.com/package/kxco-post-quantum-webhook) |
| Give an AI agent an identity a verified institution sponsors | [`kxco-pq-agent`](https://www.npmjs.com/package/kxco-pq-agent) |
| Have Armature L1 verify a signature in consensus | [`kxco-pq-chain`](https://www.npmjs.com/package/kxco-pq-chain) |
| Prove an envelope at three levels, offline to on-chain | [`kxco-pq-network`](https://www.npmjs.com/package/kxco-pq-network) |
| Generate and rotate keys from a terminal | [`kxco-pq-cli`](https://www.npmjs.com/package/kxco-pq-cli) |
| Find quantum-vulnerable cryptography in a dependency tree | [`kxco-pq-scan`](https://www.npmjs.com/package/kxco-pq-scan) |
| Fail the build when code reaches past the wrapper | [`eslint-plugin-kxco-pq`](https://www.npmjs.com/package/eslint-plugin-kxco-pq) |

## Release integrity

Each release from 1.0.3 carries a SLSA provenance attestation tying the published tarball to
the commit and workflow that built it: verify with `npm audit signatures`, or read
it from `registry.npmjs.org/-/npm/v1/attestations/kxco-pq-network@<version>`. A CycloneDX
SBOM is published as a GitHub Release asset at
`releases/download/v<version>/sbom.cyclonedx.json`, a permanent unauthenticated
URL. Sibling `kxco-*` packages sit on caret ranges so a correctness fix in the
base package reaches you on the next install, with no release of every package
above it.

---

## Security

**ML-DSA-65** (NIST FIPS 204) via [`kxco-post-quantum`](https://www.npmjs.com/package/kxco-post-quantum), running on the OpenSSL 3.5 primitives where the runtime provides them. No custom cryptography.

The signatures this package rules on are checked by the base package, and that evidence is reproducible on your own machine:

- **1,793 NIST ACVP vectors passed, 0 failed** across FIPS 203, 204 and 205, pinned by digest, per [CONFORMANCE.md](https://github.com/KnightsbridgeAIQ/kxco-post-quantum/blob/main/CONFORMANCE.md). The other 310 are pairings the library refuses as weaker than the parameter set
- **225 interoperability checks passed, 0 failed**, against OpenSSL 3.5, liboqs, Bouncy Castle and dilithium-py/kyber-py, in both directions and with negative controls
- **SLSA provenance** on every [`kxco-post-quantum`](https://www.npmjs.com/package/kxco-post-quantum) release since 1.4.0: verify with `npm audit signatures kxco-post-quantum`

This package carries its own evidence too:

- **SLSA provenance on this package** from 1.0.3 onward: verify with `npm audit signatures kxco-pq-network`
- `npm run evidence` here records what only this package can say: identity, its own tests, its SBOM, registry signature verification, and the `kxco-post-quantum` version actually installed rather than the range declared
- `npm run evidence` in the base package regenerates the conformance bundle from source

Dependency audit history is recorded in [AUDIT.md](https://github.com/KnightsbridgeAIQ/kxco-post-quantum/blob/main/AUDIT.md).

Every signature check stays with the package that made the envelope. This decides what a verification mode requires on top of it, and it fails closed: an unreachable registry returns invalid.

To report a vulnerability, email **security@kxco.ai**.

---

## License

Apache-2.0 © 2026 Knightsbridge Financial Ltd, trading as KXCO. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE). Use of the hosted registry, relay and anchoring service is governed separately, by [LICENCE-PRODUCT.md](https://github.com/KnightsbridgeAIQ/kxco-post-quantum/blob/main/LICENCE-PRODUCT.md).

---

## Maintainers

Shayne Heffernan and John Heffernan, [KXCO by Knightsbridge](https://kxco.ai)
