# Changelog

## 1.0.3

This release carries a SLSA provenance attestation. No source change.

**`--provenance` is back on.** It was deliberately omitted while this repository
was private, because npm signs provenance only for builds from a public source
repository and a private one is refused with `E422 ... Unsupported GitHub
Actions source repository visibility`. The repository is public now, so the
constraint is gone. The flag outlived the reason for it, and 1.0.2 shipped
without an attestation it could have had.

Verify it with `npm audit signatures kxco-pq-network`. Until now the README
pointed at `kxco-post-quantum` for the provenance claim, because that was the
only package in the pair that could make it. This one makes its own from here.

## 1.0.2

Documentation and a dependency refresh. No source change.

**ASSESSMENT.md.** Where this package's boundary falls, what cryptographic
agility it has beyond what the primitives provide, and what constrains its
lifecycle. It references the `kxco-post-quantum` evidence rather than restating
it, because a second copy of a conformance claim invites the reader to count it
twice.

**`npm run evidence` now exists.** The README already told you to run it and
there was no such script, so the command failed for anyone who followed it.
The bundle records identity, this package's own tests, its SBOM, registry
signature verification, and the `kxco-post-quantum` version actually installed
rather than the range declared.

**`kxco-post-quantum` refreshed to 1.7.2**, from 1.6.0 in the previous
lockfile. Within the existing range, so no declared dependency changed. Tests
pass unchanged.

## 1.0.0

First release. This package is the boundary between what is free and what is
sold, and it exists because that boundary needed a name.

The maths stays free. `kxco-post-quantum` and `kxco-verify` are Apache-2.0,
chain-agnostic, and work with the network unplugged. Nothing here changes that.

What this adds is the answer to a question offline cryptography cannot answer:
is this key still allowed to sign, today. A signature made by a key that was
revoked an hour ago is still a perfectly valid signature, and a verifier that
only checks the maths will accept it forever.

### The three modes

- `signature` — the maths. Offline, free, no server in the path.
- `anchored` — plus an Armature L1 anchor carried by the envelope. Still no
  HTTP at verify time, so an air-gapped verifier can check it.
- `anchored+live` — plus a live registry lookup. Needs a licence.

`applyVerifyMode` does no cryptography. Each package owns its own envelope
shape and signing message, and a second definition of "valid signature" here
would be one definition too many. The caller checks the maths and hands the
outcome in.

### It fails closed

An unreachable registry makes `anchored+live` return **invalid**, not
valid-with-a-warning. A mode whose entire purpose is to catch a revoked key
must not degrade into the mode that cannot, precisely when the network is
behaving oddly — which is precisely when an attacker would arrange for it to
be.

A **JSON** 404 is treated as an **answer**, not a failure: the registry was
reached and has never heard of that key. That reports as `kid_unknown`, not
`registry_unreachable`. The distinction is the whole design.

A 404 that is not JSON is the opposite, and this was found by probing the live
endpoint rather than by reasoning about it. `https://chain.kxco.ai/kids/<kid>`
currently serves the marketing site's HTML 404 page, and an earlier draft of
this client read that as a confident "this key is unknown" — stating a fact
about a key on the strength of a misconfigured URL. The content type now
decides which of the two a 404 is.

### Caching, and what it costs

Lookups are cached by kid for `registryTtlMs`, 60 seconds by default, and
concurrent lookups of one kid collapse into a single request. **At the default,
a revoked key stays accepted for up to a minute.** That is a real limit, it is
stated in the README rather than buried, and `registryTtlMs: 0` or
`clearCache()` trades it away.

### Refusals

`chainId` is not configurable. Anything but 1111111 throws at construction:
accepting another chain would mean an anchor written elsewhere could satisfy a
KXCO verify, which is the one thing the anchor exists to prove.

A registry record whose kid does not match what was asked for is refused, using
the constant-time comparison from `kxco-post-quantum`. A status this build does
not recognise becomes `unknown` rather than passing through, so a status added
in a later release cannot fall out of the "is it active" check as though it
were active.

### Metering

`meter()` and `usageEvent()` emit structured records. They emit; they do not
aggregate, invoice, or phone home. **The licence key is never emitted in full**
— only its first 8 characters, which is enough to attribute an event and
useless to whoever reads the log. The test suite asserts a full key never
appears in a record.

### Why a separate package

`kxco-pq-sdk` already depends on `kxco-pq-attest`. Putting this module inside
the SDK and having attest import it would make a dependency cycle. It is
separate because it has to be, not for tidiness.

### Not assessed

No third party has assessed this code. `@noble/post-quantum`, reached through
`kxco-post-quantum`, has been self-audited by its maintainer only — The other Noble packages have been audited, but separately and at different times: `@noble/hashes` by Cure53 in January 2022, `@noble/curves` by Trail of Bits in February 2023, Kudelski in September 2023 and Cure53 in September 2024, and `@noble/ciphers` by Cure53 in September 2024. None of those engagements covered the post-quantum package.
