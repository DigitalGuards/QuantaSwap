# Finality policy

Status: specification. Sections marked **implemented** describe code in this
repository today. Sections marked **required** are preconditions for lifting the
real-value NO-GO, and are not implemented yet. Issue #47 names a reviewed
finality policy as one of the two gates alongside an independent contract audit.

Scope: when each side of a swap may act on what it reads from the other chain,
what the timelocks have to be for those reads to stay safe, and what the
observation source is per chain.

## 1. Why finality is a settlement parameter

An HTLC is atomic against a static view of both chains. It is not atomic against
a chain that reorganises. Three distinct exposures follow from that.

- **Acting on a lock that disappears.** The responder funds its leg because it
  read the initiator lock. If that lock is reorganised out, the responder has
  funded a swap whose counter-leg does not exist. The responder recovers only at
  its own timeout, and only if it never revealed anything.
- **Revealing against a lock that disappears.** The initiator reveals the
  preimage by claiming the responder leg. If the responder lock is reorganised
  out, the secret is public and the initiator's own leg is claimable by the
  counterparty. This is the loss case, and it is why a reveal needs a stronger
  observation than a lock does.
- **A reveal that itself disappears.** The initiator's claim lands, the
  responder reads the preimage and claims the initiator leg. The claim on the
  responder leg is then reorganised out. Unless the initiator re-submits before
  the responder-leg timeout, the responder refunds that leg and keeps both
  sides. The initiator therefore has to reveal early enough to survive a reorg
  of its own claim and re-submit.

The third exposure is the one that sets the margin between the reveal and the
responder timeout. It is unaffected by HTLCv3: v3 changes what happens when a
payout cannot be delivered, and a claim that ends in a credit has revealed the
preimage exactly as a claim that paid directly.

## 2. What is implemented today

### 2.1 Observation depth

| Actor | Leg | Depth source | Value |
|---|---|---|---|
| Browser client | Ethereum | `head - confirmations` numeric block tag | `confirmations = 0` (`frontend/src/config.ts:39`) |
| Browser client | QRL | `head - confirmations` numeric block tag | `confirmations = 0` (`frontend/src/config.ts:24`) |
| Reference maker | responder leg | `head - MM_CONFIRMATIONS` numeric block tag | default `3` (`marketmaker/src/config.ts:250`) |
| Reference maker | initiator leg | `latest` | no depth |

Depth is computed as `max(0, head - confirmations)` and passed as a hexadecimal
block number (`frontend/src/lib/htlc.ts:134-151`,
`marketmaker/src/htlc.ts:218-227`). The browser's `confirmations = 0` reads the
head block itself, which is a deliberate testnet-speed choice recorded in the
source comment and in `docs/ARCHITECTURE.md` section 7.

There is no use of the `finalized` or `safe` block tag anywhere in
`frontend/src`, `marketmaker/src` or `server/src`. There is no beacon-chain or
consensus-layer query of any kind, no slot or epoch arithmetic, and no
finality-checkpoint poll. Finality is approximated entirely by `head - N`.

### 2.2 What each decision is gated on

Browser (`frontend/src/lib/swapMachine.ts`):

- Responder lock (`:281-289`) requires the initiator lock Open in the depth
  snapshot, with token, recipient and amount verified against that snapshot
  (`:188-197`), and the initiator timeout at least `CLAIM_MARGIN_S` beyond the
  responder timeout.
- Secret reveal (`:308-317`) requires the responder lock Open in the depth
  snapshot, verified the same way (`:209-218`), plus the own leg still Open.
- Claim of the initiator leg after a reveal (`:335-341`) requires no depth at
  all, which is correct: the preimage stays valid whatever that chain does.
- A depth read that fails is dropped, and a stale snapshot is never reused
  (`frontend/src/components/SwapFlow.tsx:120-141`), so every gate fails closed.

Reference maker (`marketmaker/src/policy.ts`):

- Claim, meaning the reveal (`:261-275`), requires the responder lock Open in
  the depth-3 snapshot with token, recipient and amount matching, and
  `now < rConfirmed.timeout - MM_CLAIM_SAFETY_S` against the timeout actually
  on chain, plus the same margin against the announced T2.
- Sponsored claim of its own initiator lock (`:285-297`) requires its own
  reveal visible at depth 3 as Claimed, and `now < iState.timeout -
  sponsorMarginS` where `sponsorMarginS = ceil(MM_TX_TIMEOUT_MS / 1000) + 60`,
  which is 240 s at defaults (`marketmaker/src/index.ts:600`).
- Its own lock (`:304-314`) requires no chain observation at all. It is gated on
  book status, a persisted authenticated FillV2 acknowledgement,
  `MM_LOCK_GRACE_S` (30 s) and `now < t2 - MM_CLAIM_SAFETY_S`.
- Refund (`:318-324`) uses the announced `t1`. The browser uses the on-chain
  timeout instead (`swapMachine.ts:340`).

Neither client records the block hash of the depth snapshot it read, so a reorg
between two polls is invisible to both.

### 2.3 Timelocks and margins in force

| Parameter | Value | Source |
|---|---|---|
| Responder window T2 | 3600 s | `MM_RESPONDER_WINDOW_S` (`marketmaker/src/config.ts:258`), `RESPONDER_TIMEOUT_S` (`frontend/src/config.ts:72`) |
| Initiator window T1 | 7200 s | `MM_INITIATOR_WINDOW_S` (`:257`), `INITIATOR_TIMEOUT_S` (`frontend/src/config.ts:71`) |
| Prelock listing T1 | 172800 s | `PRELOCK_INITIATOR_TIMEOUT_S` (`frontend/src/config.ts:168`) |
| Claim safety margin | 600 s | `MM_CLAIM_SAFETY_S` (`:255`) |
| Browser claim margin | 1800 s | `CLAIM_MARGIN_S` (`frontend/src/config.ts:163`) |
| Sponsor margin | 240 s derived | `marketmaker/src/index.ts:600` |
| Maker tick | 15 s | `MM_TICK_MS` (`:251`) |
| Own-transaction confirmation wait | 1 block, 180 s cap | `marketmaker/src/chains.ts:92,112` |
| Minimum takeable runway | 9000 s | `MIN_TAKEABLE_RUNWAY_S` (`frontend/src/config.ts:174`, `server/src/store.ts:273`) |

Ordering is enforced server-side at announce: the responder timeout must be more
than 600 s out, and `initiatorTimeout - now >= 2 * (responderTimeout - now)`
(`server/src/store.ts:2913-2919`). Signed orders bound the windows to
`MAX_RESPONDER_WINDOW_S = 7200` and `MAX_INITIATOR_WINDOW_S = 14400`
(`server/src/order-signing.ts:248-259`), so the values required in section 3 fit
inside the existing wire limits without a protocol change.

`config/protocol-v2.json` carries chain identity only. It has no confirmation,
timeout or finality field.

### 2.4 Claim preflight

Every secret-bearing claim is simulated from the real sender at `latest`
immediately before submission, and is not broadcast on any simulation error
(`frontend/src/lib/legSender.ts:88-160`, `marketmaker/src/htlc.ts:125-172`).
That mitigation covers payout failure. It reads the head block and closes
nothing about reorgs. HTLCv3 makes the payout-failure case
structurally safe, and the preflight remains useful as an early warning.

## 3. Required policy for real value

### 3.1 Per-chain finality source

**Ethereum.** Read the `finalized` block tag, and use the block it names as the
observation point for every gate that today uses `head - N`. Justification: the
`finalized` tag is the consensus-layer finalized checkpoint, which cannot be
reverted without breaking finality and slashing at least one third of the stake.
Nominal latency is two epochs, 64 slots, about 12.8 minutes; treat 15 minutes as
the planning figure. Ethereum can stop finalizing during an inactivity leak, in
which case the tag stops advancing and latency becomes unbounded.

**QRL v3.** QRL v3 runs a Gasper-style beacon chain, so the same notion exists.
Read the finalized checkpoint from the consensus client
(`/eth/v1/beacon/states/head/finality_checkpoints` on the beacon API) and map it
to an execution block, or, where only the execution RPC is reachable, use a
depth equal to `2 * slots_per_epoch + 1 epoch of slack` converted to blocks. The
slot time and epoch length of the target QRL network have to be measured on that
network and recorded here before this policy is signed off; they are not assumed
in this document. The mapping has to be verified against the deployed node
on that network. Ethereum's parameters do not carry over.

**Both chains.** Pin the block hash of every finality-gated read and re-verify it
on the next poll. A snapshot whose hash changed is a reorg of the observation
point and has to invalidate every decision derived from it. Neither client does
this today.

**Circuit breaker.** If the finalized checkpoint on either chain has not
advanced for longer than one planning-figure finality interval, stop opening new
swaps and stop revealing secrets, and let in-flight swaps run to their timeouts.
Fail closed, exactly as the depth reads already do when an RPC call fails.

### 3.2 What the maker must wait for before revealing

Ordered, with no step skippable:

1. Its own leg is locked and that lock is finalized on its own chain.
2. The counterparty lock is finalized on the counterparty chain.
3. The finalized record matches the expected token, recipient, amount and
   timeout, all read from the finalized snapshot and not from the order book.
4. The on-chain timeout of the counterparty lock leaves at least
   `Final(responder leg) + Retry(responder leg)` before it expires, so a reorg
   of the reveal still leaves room for one re-submission.
5. The finalized checkpoints on both chains are advancing.

Step 4 replaces `MM_CLAIM_SAFETY_S = 600` with a value derived from measured
finality.

### 3.3 Timelock ordering and margins

Notation, per chain X: `Incl(X)` is the worst-case inclusion time for a
fee-competitive transaction, `Final(X)` is the worst-case time from inclusion to
finalized, `Retry(X)` is the budget for one re-submission after a reorg.

Measured from the match, with I the initiator leg and R the responder leg:

```
T2 >= Incl(I) + Final(I)        # responder waits for the initiator lock
    + Incl(R) + Final(R)        # responder locks, initiator waits for it
    + Incl(R)                   # initiator reveals
    + Final(R) + Retry(R)       # the reveal survives a reorg, or is re-sent
    + slack

T1 >= T2 - Final(R) - Retry(R)  # latest safe reveal
    + Incl(I)                   # responder claims the initiator leg
    + Final(I) + Retry(I)
    + slack
```

The existing `T1 >= 2 * T2` rule satisfies the second inequality whenever
`Final(I) + Retry(I) + Incl(I)` is well under `T2`, and it stays the enforced
form because it is simple to check on the wire. The first inequality is the one
that today's 3600 s responder window does not satisfy under real finality.

Planning figures with Ethereum as the initiator leg and QRL as the responder
leg, `Final(ETH) = 15 min`, `Incl(ETH) = 5 min`, `Retry(ETH) = 5 min`,
`Final(QRL) = 10 min` pending measurement, `Incl(QRL) = 2 min`,
`Retry(QRL) = 5 min`, slack 10 min:

| Parameter | Today | Required | Note |
|---|---|---|---|
| Responder window T2 | 3600 s | **5400 s** (90 min) | computed minimum 59 min, rounded up |
| Initiator window T1 | 7200 s | **10800 s** (180 min) | keeps `T1 >= 2 * T2` |
| Claim safety margin | 600 s | **1200 s** | `Final(R) + Retry(R)` |
| Sponsor margin | 240 s | **1200 s** | `Final(I) + Retry(I)` |
| Minimum takeable runway | 9000 s | **12600 s** | `2 * T2 + claim margin` |
| Prelock listing T1 | 172800 s | unchanged | already far above the floor |

Both required windows stay inside the signed-order bounds in section 2.3, so
this is a parameter change and not a wire change. Swapping the direction, with
QRL as the initiator leg, changes which `Final` appears where; the formula is
symmetric and has to be evaluated per direction.

### 3.4 Sponsored claims

A sponsored claim is a third party submitting the claim so the recipient needs
no gas on the paying chain. Two margins apply.

- The sponsor may only submit after the reveal it depends on is finalized on the
  chain where it was revealed. The reference maker already requires its own
  reveal at depth before sponsoring (`policy.ts:285-297`); depth becomes
  finality.
- The sponsored claim has to be included and finalized before the paying leg's
  on-chain timeout, so the margin is `Final(paying leg) + Retry(paying leg)`,
  which is the 1200 s figure above. The current 240 s comes from the
  transaction timeout and tracks nothing about finality.

HTLCv3 adds one consideration specific to sponsorship. If the delivery defers to
a credit, only the recipient can withdraw it, and a recipient without gas on that
chain cannot. A sponsor therefore has to submit the claim with
`estimateGas + DELIVERY_GAS_LIMIT + DELIVERY_GAS_RESERVE` as documented in
`contracts/hyperion/HTLCv3.hyp`, so a payout that can be delivered is delivered
and the recipient is never left holding a credit it cannot reach.

### 3.5 Observation of credits

An indexer or UI that reports a deferred payout from a `PayoutCredited` event
has to apply the same finality rule it applies to a claim. A credit read at the
head block can be reorganised out together with the claim that created it.
Withdrawing a credit is a single-chain action and needs no cross-chain finality
of its own.

## 4. Implemented against required

| Item | Implemented | Required |
|---|---|---|
| Depth mechanism | `head - N` numeric tag | `finalized` tag (Ethereum), beacon finality checkpoint or measured epoch depth (QRL) |
| Browser depth | 0 on both legs | finality-gated on both legs |
| Maker depth | `MM_CONFIRMATIONS = 3`, one knob for both legs | per-chain finality source |
| Initiator-leg observation by the maker | `latest`, no depth | finality-gated before its own reveal |
| Maker lock decision | no chain observation | initiator lock finalized before the responder funds |
| Reorg detection | none | block hash pinned and re-verified per poll |
| Non-finality handling | none | circuit breaker on a stalled finalized checkpoint |
| Claim margin | 600 s flat | derived from measured finality |
| Sponsor margin | 240 s derived from the tx timeout | derived from measured finality |
| Timelock ordering | `T1 >= 2 * T2`, enforced at announce | unchanged rule, larger windows |
| Refund trigger | announced `t1` in the maker, on-chain timeout in the browser | on-chain timeout everywhere |
| Timing policy location | code constants and maker env vars, duplicated in four files | one reviewed source both clients read |
| Payout-failure atomicity | HTLCv2 rolls the claim back | HTLCv3 credit path, this branch |

## 5. Open questions

1. QRL v3 slot time and epoch length on the target network, and whether its
   beacon API exposes finality checkpoints in the standard shape. Both have to
   be measured and recorded before this policy is signed off.
2. Whether the QRL execution RPC can serve a `finalized` tag directly, which
   would remove the need for a beacon-API dependency in the clients.
3. Where the reviewed timing policy lives so both clients and the order book read
   one source. `config/protocol-v2.json` is the natural place and currently
   carries chain identity only.
4. Whether non-finality on Ethereum should also suspend refunds, or only new
   swaps and reveals. Suspending refunds is the conservative reading and it
   conflicts with letting in-flight swaps drain.
