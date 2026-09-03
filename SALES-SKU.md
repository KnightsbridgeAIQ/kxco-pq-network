# Seats and metering

What is sold, how it is counted, and where in the code the counting happens.

Prices are **USD, per seat, per year**, invoiced. No customer holds ARMR, runs a node, sets a gas price or touches a wallet. If that changes, this document is wrong and should be corrected rather than quietly reinterpreted.

Commercial terms: **hello@kxco.ai**

---

## The line

Free: the maths. `kxco-post-quantum` and `kxco-verify` are Apache-2.0, chain-agnostic, and work with the network unplugged. They keep working if KXCO stops existing.

Paid: **an answer about the present.** A signature made by a key that was revoked an hour ago is still a perfectly valid signature. No offline check can tell you it was revoked. Only an operated service can, and only an operated service can be held to an answer.

See [`LICENCE-PRODUCT.md`](https://github.com/KnightsbridgeAIQ/kxco-post-quantum/blob/main/LICENCE-PRODUCT.md).

---

## Seats

### 1. Network seat

The unit of subscription. One institution, one licence key.

Entitles: registry reads at metered volume, `anchored+live` verification, relay writes, and the `KXCO Verified` mark under contract.

Counted by `institutionId`. A licence key belongs to exactly one institution; sharing one across legal entities is what the contract prohibits, not what the code prevents.

### 2. Anchor quota

On-chain writes to Armature L1 — `anchorHash`, `anchorAuditRoot`, `anchorAttestation`.

Each anchor is an EVM transaction whose gas KXCO pays in ARMR. That is a real cost per write, which is why this is a quota and not unlimited.

Sold in blocks per year. Overage is invoiced, not blocked: a compliance anchor that fails because a counter rolled over is worse for the customer than an invoice.

### 3. Agent kids

Machine identities registered under an institution — `registerAgent` / `issueAgentCredential` for `llm`, `robot`, `iot` and `process` types.

Counted as **distinct agent kids ever registered**, not concurrent. A kid revoked and replaced counts as two, because registering it consumed a chain write either way.

### 4. Webhook verified

Outbound deliveries signed with ML-DSA-65, and the optional compact-JWS path, from `kxco-post-quantum-webhook`.

**Signing and verifying webhooks needs no licence.** The package is Apache-2.0 and does not call anything. What is sold here is the hosted key-rotation endpoint and the registry lookup that lets a receiver confirm a signing kid is still current, which is the part a receiver cannot do for themselves.

### 5. SLA

Availability commitment on `chain.kxco.ai` and `relay.kxco.ai`, an escalation path, and a named contact.

Worth stating plainly: `anchored+live` **fails closed**. When the registry is unreachable, verification returns invalid. That is deliberate — a revocation check that quietly passes when it could not run is not a check — and it means registry availability is directly a customer's availability. That is what the SLA is for, and it is why a customer who cannot tolerate it should use `anchored`, which needs no registry at all.

---

## Metering hooks

Billing is metered **server-side**. The relay and the registry are the source of truth, because a client-side counter is a counter the customer controls.

The hooks below exist for the customer's own observability, and to reconcile an invoice against their own logs. They emit; they do not aggregate, invoice, or phone home.

| Event | Emitted by |
|---|---|
| `relay_post` | `kxco-pq-chain`, on every relay write |
| `anchor_written` | callers, on a successful anchor |
| `kid_registered` | callers, on identity or agent registration |
| `kid_revoked`, `kid_rotated` | callers, on revocation or rotation |
| `registry_read` | `kxco-pq-network`, on a registry lookup |
| `verify` | callers, per verification |

Every record carries:

```json
{
  "event": "relay_post",
  "at": "2026-09-03T00:00:00.000Z",
  "chainId": 1111111,
  "operation": "anchorHash",
  "institutionKid": "aa29f37ab7f4b2cf",
  "kid": "bb29f37ab7f4b2cf",
  "licencePrefix": "kxco_liv",
  "txHash": "0x…",
  "blockNumber": 90633
}
```

**`licencePrefix` is the first 8 characters and never more.** Enough to attribute an event to a customer, useless to whoever reads the log. Logs get shipped to places the key was never meant to reach, and the test suites in both packages assert that a full licence key never appears in an emitted record.

### Turning them on

```js
// kxco-pq-chain — off by default; a library should not write to your logs uninvited
new KxcoChain({ identity, licenceKey, onUsageEvent: (e) => logger.info(e) })

// kxco-pq-network — build a record, or emit one through your own sink
import { meter, usageEvent } from 'kxco-pq-network'
meter('registry_read', { institutionId, kid, licenceKey }, (r) => logger.info(r))
```

---

## Going live

Everything a customer sets:

```bash
KXCO_LICENCE_KEY=kxco_live_...          # required for relay writes and anchored+live
KXCO_VERIFY_MODE=anchored+live          # or anchored, or signature
KXCO_REGISTRY_URL=https://chain.kxco.ai # default
KXCO_RELAY_URL=https://relay.kxco.ai    # default
KXCO_REGISTRY_TTL_MS=60000              # default
```

A missing licence throws at **construction**, not at the first write. A service that boots looking healthy and fails on a customer's first transaction has already told someone their onboarding succeeded.

`KXCO_LICENSE_KEY` is accepted as well, because half the world spells it that way and a failed deployment over a vowel helps nobody.

---

## What is not sold

- **Not the cryptography.** It is Apache-2.0 and it is not going to stop being.
- **Not a token.** No ARMR to buy, no wallet, no gas.
- **Not an audit.** Nobody independent has assessed this code. What exists is evidence a customer can re-run themselves — see the `evidence` job in `kxco-post-quantum`.
- **Not a FIPS 140-3 validated module, and not CNSA 2.0 compliance.** The algorithms are NIST-standardised. The module is not validated. Those are different statements and we do not blur them.
