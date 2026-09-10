# Assessment notes

Where this package's boundary falls, what agility it has, and what constrains
its lifecycle.

The README is already explicit about the three modes, the fail-closed rule, the
cache window and the content-type distinction on a 404. This document does not
restate them. It covers what an assessment asks and the README does not.

Algorithm conformance belongs to
[`kxco-post-quantum`](https://www.npmjs.com/package/kxco-post-quantum) and is
published in that package's evidence bundle.

## Boundary

**This package performs no cryptography at all.** `applyVerifyMode` decides
what a mode requires on top of a signature check the caller has already done.
That is unusual for this family and it is the most important thing to record:
an assessor looking for algorithm behaviour here will not find any, and should
not credit this package with any.

**This is the one package where KXCO is a required service connection.** In
`signature` and `anchored` modes there is no network at verify time and no
dependency on us. In `anchored+live` there is both, and it is a hard one:

- The registry at `https://chain.kxco.ai` must be reachable, and unreachable
  means invalid rather than valid-with-a-warning. That is the correct design
  and it means our availability becomes the caller's availability.
- The mode requires a licence key. So a commercial relationship, not only a
  technical one, sits between the caller and a successful verification.

For a buyer, that is a blocking supplier dependency and it should be recorded
as one in their own planning rather than discovered during an incident. The
mitigation is designed in and worth stating: `anchored` is deterministic,
offline and free, and a caller who would rather have the weaker answer than no
answer can ask for it.

**The transport to those endpoints is post-quantum, and here is the
measurement.** Both endpoints negotiate the hybrid key exchange group
`X25519MLKEM768` under TLS 1.3. Reproduce it:

```
echo | openssl s_client -connect chain.kxco.ai:443 -servername chain.kxco.ai \
  -groups X25519MLKEM768 -tls1_3 2>&1 | grep "Negotiated TLS1.3 group"
```

Measured 7 September 2026 against OpenSSL 3.5.6: `X25519MLKEM768` on both
`chain.kxco.ai` and `relay.kxco.ai`.

**Authentication on that connection is still classical, and that is a
different claim.** The certificates are ECDSA P-384, issued by Let's Encrypt.
No post-quantum certificate option exists in the public WebPKI, so this is the
current state of the art rather than a gap peculiar to us. The distinction that
matters: confidentiality of the connection is protected against an adversary
recording it today and breaking it later, and endpoint authentication is not,
because forging that certificate would have to happen at connection time.

**Retain history.** Nothing is stored. The cache is in memory with a 60 second
default TTL, and the README already states the consequence, which is that a
revoked key stays accepted for up to that window.

**Start and update.** No release signing of its own. Published through CI with
npm provenance from 1.0.3 onward.

1.0.2 and earlier carry no attestation, and the reason is worth recording
because it was a stale constraint rather than a decision. `--provenance` was
deliberately omitted while this repository was private, since npm signs
provenance only for builds from a public source repository. The repository is
public now. The flag outlived the reason for it, and 1.0.2 shipped without an
attestation it could have had.

## Agility

**None of its own, and that is correct.** This package does no cryptography, so
it has no algorithms to change. Agility here belongs to whichever package
produced the envelope being checked, and to `kxco-post-quantum` beneath it.

**What it does pin, deliberately.** `chainId` is `1111111` and passing anything
else throws. That is the opposite of agility and it is the right call: an anchor
written on another chain satisfying a KXCO verify would defeat the thing the
anchor exists to prove. Recorded here so it is read as a decision rather than a
limitation.

## Lifecycle

**Supported versions.** One line moving forward, matching the family.

**Pins.** `kxco-post-quantum` is declared `^1.6.0`, and the tree the evidence
bundle was last built from resolved it to **1.6.0**, against a current
primitives release of 1.7.2. Range and resolution agreeing today is a fact
about this tree and not a guarantee; `02-primitives.json` records what was
installed.

**Ceiling.** No hardware or runtime ceiling. The constraint is the registry
round trip in `anchored+live`, and the cache is the lever: concurrent lookups
of one kid collapse into a single request, so a batch from one signer costs one
connection. Setting `registryTtlMs: 0` removes the revocation window at the
cost of a lookup per verification.

**The dependency that is ours rather than a supplier's.** Everywhere else in
this family a blocking dependency means an upstream library. Here it means the
KXCO registry service and its licence. A buyer's continuity plan for
`anchored+live` needs an answer for what happens if that service is
unavailable for an extended period, and the honest answer available today is
falling back to `anchored`, which cannot detect revocation.

**Roadmap.** No external audit, no bug bounty. No published availability target
for the registry service, which for a fail-closed dependency is the number a
buyer will ask for next.

## Correcting this document

The TLS measurement above is reproducible with the command given. Everything
else is checkable against `src/`. If a claim does not match, that is a defect
worth reporting through the repository's issues.
