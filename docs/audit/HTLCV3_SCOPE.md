# HTLCv3 audit scope

Prepared for an independent review of `contracts/hyperion/HTLCv3.hyp`. HTLCv3 is
the payout redesign required by issue #47 (`security: redesign claim payout
before any real-value deployment`). It is not deployed anywhere. The deployed
HTLCv2 contract (`contracts/hyperion/HTLC.hyp`) is unchanged by this work and
keeps its own addresses; see `docs/DEPLOYMENTS.md`.

An independent audit of this contract and a reviewed finality policy
(`docs/FINALITY.md`) are the two conditions issue #47 sets for lifting the
real-value NO-GO.

## 1. In scope

| File | Role |
|---|---|
| `contracts/hyperion/HTLCv3.hyp` | the contract under review |
| `contracts/test/MockTokens.hyp` | ERC-20 return-convention, blocklist, fee-on-transfer doubles |
| `contracts/test/MockRecipients.hyp` | adversarial payout targets and tokens added for v3 |
| `contracts/test/semantic/Q128HTLCv3.hyp` | QRVM-512 wide-address regression for the credit ledger |
| `scripts/test-htlcv3.js` | the EVM behavioural suite |
| `scripts/test-q128-accessors.js` | the QRVM-512 semantic harness |
| `scripts/abi-guards.js` | the pinned address-touching ABI surface of every contract in the bundle |
| `scripts/measure-delivery-gas.js` | the mainnet-fork measurement behind the delivery budget |
| `scripts/compile.js`, `scripts/hypc.js`, `scripts/artifacts.js` | artifact production and envelope validation |
| `config/hyperion-targets.json` | pinned compiler versions, codegen settings, address widths |
| `docs/FINALITY.md` | the finality policy the deployment depends on |

Out of scope for this review: the order book (`server/`), the browser client
(`frontend/`), the reference market maker (`marketmaker/`), and HTLCv2 itself.
Client integration of HTLCv3 is a separate change that has not been written yet.

## 2. Reproducing the artifacts

One reviewed source bundle compiles to two target-bound artifacts with identical
ABIs and target-specific bytecode. `contracts/hyperion/` currently holds both
`HTLC.hyp` (HTLCv2, deployed) and `HTLCv3.hyp`, and the bundle hash covers both.

```
npm ci
export EVM_HYPC_BIN=<path to the EVM-target hypc>
export QRL_HYPC_BIN=<path to the QRL-target hypc>
npm run compile          # writes build/hyperion/{evm,qrl}/
npm test                 # full gate, see section 7
```

Settings, from `config/hyperion-targets.json` and enforced by
`scripts/hypc.js` and `scripts/artifacts.js` on every load:

| Target | Runtime | Address bytes | Compiler | Codegen |
|---|---|---|---|---|
| `evm` | `evm-256` | 20 | `0.2.0-develop.2026.4.13+commit.d5d1b977` | `viaIR: true`, optimizer on, 200 runs, `qrvmVersion: zond` |
| `qrl` | `qrvm-512` | 64 | `0.2.0-develop.2026.8.27+commit.6f862206.mod` | `viaIR: true`, optimizer on, 200 runs, `qrvmVersion: zond` |

Both targets use `viaIR: true`. That is deliberate and load-bearing: the legacy
QRVM-512 code path has known defects around wide values, and the artifact
loaders refuse any artifact whose recorded `viaIR` setting differs from the
pinned one. The QRVM-512 semantic suite additionally runs both the legacy and
the via-IR pipelines, optimized and unoptimized, so a legacy-codegen regression
in the reviewed source is caught even though only via-IR output ships.

Hashes of the tree under review:

| Item | SHA-256 |
|---|---|
| Reviewed source bundle (both contracts) | `c2d17fd8b2c569bd31557a3d5d8a9e79c080cab59a68727a2625ed679b3ef6fe` |
| HTLCv3 ABI (identical on both targets) | `dd6863d43d4c8e104e6137eba7b9f249ad1edb2a46b91e9fcd07e39bbfe4078b` |
| HTLCv3 EVM runtime | `ed73e86007b25aebfbc96c18fa13037a09cd6fc04002ac551d4729f7d997b858` |
| HTLCv3 QRVM-512 runtime | `0de1866b8a8b78cbeebdcbf5f328b95d9b2d9502f5f42ebdffaa10e3ed3a26e6` |
| HTLCv2 EVM runtime (unchanged, matches the live deployment) | `9ad68221efceaf9f958d96a9f650946f6fce37f2ddcaf12e2b6194d7578a5e8f` |
| HTLCv2 QRVM-512 runtime (unchanged, matches the live deployment) | `7d9b70ef0d4a427f357a721b9c897cc253abaff077465cbcd8513a696cd70903` |

The two HTLCv2 runtime hashes are the values recorded for the live deployment in
`docs/DEPLOYMENTS.md`, reproduced from this tree. Adding HTLCv3 to the bundle
changed the bundle hash and left HTLCv2's bytecode byte-for-byte identical.

Runtime sizes: 5191 bytes on EVM, 6208 bytes on QRVM-512.

### Measured delivery cost against the live Ethereum tokens

`DELIVERY_GAS_LIMIT` has to cover what the delivery attempt actually consumes:
one `balanceOf`, the `transfer`, and the second `balanceOf` that asserts the
balance moved. Measured against the deployed WETH, USDC and USDT
implementations on a read-only anvil fork of Ethereum mainnet at block
26,063,714, traced with `debug_traceTransaction` and read as the gas the
`selfDeliver` frame consumed. Nothing was broadcast and no key was used.

| Token | Recipient with no prior balance | Recipient with a balance |
|---|---|---|
| WETH | 36,407 | 19,307 |
| USDC | 48,707 | 31,607 |
| USDT | 48,763 | 31,663 |

Worst real case 48,763 against a 100,000 budget, a 2.05x margin. Every case
delivered directly. Reproduce with `node scripts/measure-delivery-gas.js`, which
is outside `npm test` because it needs network access. See
A15 for the accepted risk that the constant is immutable while USDC and USDT are
upgradeable proxies.

## 3. Trust model

No trusted party exists inside the contract.

- No owner, no pause, no upgrade, no proxy, no admin key, no initializer. Every
  state transition is reachable by the parties named in the swap record, or by
  anyone where the function is deliberately permissionless.
- `claim` and `refund` are permissionless by design. The payout target is the
  one the fund owner fixed, at lock time or through the initiator's one-time
  `assign`. A caller chooses only whether and when to submit.
- `assign` and `release` are initiator-only. `withdraw` and `withdrawAll` are
  credited-account-only. `pushCredit` is permissionless and takes no
  destination, so the only address it can pay is the credited account itself.
- `selfDeliver` is callable by the contract itself and nobody else.
- The order book, the relay, the RPC endpoints and the clients are all outside
  the trust boundary. The contract never reads them.

Trusted by assumption, and stated so that a reviewer can price it:

- **The token contract.** A locked ERC-20 is arbitrary code. It can refuse
  transfers, freeze an address, freeze the HTLC, or lie. The contract confines
  the damage to that token: escrow, credits and the conservation invariant are
  all per-token, so one token's behaviour cannot reach another token's escrow or
  the native coin. Clients restrict themselves to a vetted registry
  (`config/tokens.json`).
- **The chain's gas semantics.** The delivery budget reasoning depends on the
  63/64 call rule, on a child frame's revert undoing its own state, and on
  storage write costs being within the reserve. The suite exercises this on the
  EVM target. The semantic suite exercises QRVM-512 correctness; gas is outside
  its scope, so the reserve has to be confirmed against the QRL v3 gas schedule
  before deployment (A9, and the measurement in section 8).

## 4. Invariants

Numbered for reference in findings.

**I1 Terminal settlement.** A swap record moves `None -> Open` once, then
`Open -> Claimed` or `Open -> Refunded` once. No transition out of `Claimed` or
`Refunded` exists. `release` and `refund` both write `Refunded`.

**I2 Hashlock single use.** `_lock` rejects any hashlock whose status is not
`None`, forever, including after settlement. A preimage that became public can
never gate funds on this instance again.

**I3 Write-once recipient.** `recipient` is set at lock time or by one
`assign`, is never cleared, and can never be changed. `claim` reverts
`NotAssigned` while it is zero. `recipient` can never be `address(0)` after
assignment, and never `address(this)`.

**I4 Claim is unconditional once the preimage checks out.** After
`sha256(preimage) == hashlock` passes, `status = Claimed` and the preimage are
written, and no token and no recipient can make the transaction revert them. Two
bounds, both documented: a transaction that does not carry enough gas to reach
the write reverts like any other (A3), and the check is only reached before
`timeout` (A14).

**I5 Conservation, per token.** For every token `t`, including `address(0)` for
the native coin:

```
balance(t) >= sum(amount of Open swaps whose token is t) + outstandingCredit(t)
```

Every path either moves `amount` out of the contract or adds exactly `amount` to
a credit, one of the two and not both. Two things make this an inequality rather
than an equality: native value forced in without a call (A7), and a token that
misreports this contract's balance, since the left side is whatever the token
says it is (A5).

**I6 Credit ownership.** A credit can only ever reach `account`, or a
destination `account` named itself. `withdraw` and `withdrawAll` key on
`msg.sender` and take a destination; `pushCredit` is permissionless and has no
destination parameter, so it can only pay `account`. Redirect authority is what
is airtight: no other party can send a credit anywhere `account` did not choose.
Availability is not, and cannot be at this layer, because the token decides
whether a transfer succeeds. An issuer blocklist or a gas-burning token can
freeze a credit in place (A16), which conserves it without delivering it.

**I7 Delivery atomicity.** A delivery attempt either succeeds and moves exactly
`amount`, or fails and moves nothing. Two independent mechanisms hold it up. The
attempt runs in the `selfDeliver` child frame, so its revert undoes any
partial movement; and the token branch asserts the contract's balance fell by
exactly `amount`, so a token reporting a success it did not perform fails the
attempt. A credit is therefore always fully backed, and a terminal swap always
either delivered or credited.

**I8 No initiator refund after Claimed.** Once `Claimed`, `refund` and `release`
revert `SwapNotOpen`. A failed delivery becomes a recipient credit and never an
initiator refund.

**I9 Outstanding total.** `outstandingCredit(t)` equals the sum of
`_credits[t][*]` at all times.

**I10 Reentrancy.** Every state-changing external entry point holds the single
guard for its whole body. `selfDeliver` deliberately does not, because it is the
child frame of a call made while the guard is held.

**I11 Exact escrow on lock.** A token lock records `amount` only if the
contract's balance in that token grew by exactly `amount`, so fee-on-transfer
and rebasing tokens cannot create an under-funded swap.

**I13 Bounded amount.** A lock records at most `type(uint128).max`. The credit
ledger accumulates settled amounts with checked arithmetic, so an unbounded
amount would let a token that misreports its own balance saturate
`_outstanding[token]` and make a later claim in that token overflow and revert
after publishing its preimage. The cap is far above every supported asset's
total supply and it takes 2^128 settlements to reach the bound.

**I12 Window separation.** `claim` and `assign` close at `timeout`; `refund`
opens at `timeout`. The windows never overlap. `release` is valid only while
unassigned, at any time.

## 5. Threat model

Adversaries considered, with the property each one attacks.

| Adversary | Capability | Target |
|---|---|---|
| Counterparty | knows the hashlock, can act on either chain | I4: force a claim to revert after the preimage is public, then claim the other leg |
| Arbitrary claimer or relayer | can submit `claim` for anyone, chooses gas and timing | I6: redirect a payout; I4: make the claim fail; griefing through the credit path |
| Token issuer | can block an address or freeze the contract mid-swap | I4, I5: revert a settlement, strand value |
| Malicious token | arbitrary code in `transfer` and `transferFrom` | I5, I7: report failure after moving value, exhaust the caller's gas, return an oversized payload |
| Recipient contract | arbitrary code in `receive` | I4, I10: revert or burn gas to break a claim, re-enter to double-spend |
| Initiator | controls `assign` and `release` timing | I3, I8: reclaim value the recipient is owed |
| Miner or builder | reorders and censors, sees the mempool | the preimage disclosure window, which is a protocol-level concern handled in `docs/FINALITY.md` |

Attack paths explicitly analysed and their outcome in v3:

1. **Blocklisted recipient at claim time.** The payout fails, the claim stays
   `Claimed`, the amount becomes a recipient credit, and the recipient withdraws
   to an unblocked destination without the issuer's cooperation.
2. **Frozen HTLC contract.** Every settlement in that token credits. Withdrawals
   revert while the freeze holds and succeed afterwards. No terminal state and
   no value is lost.
3. **Nonpayable native recipient.** Credits. A recipient contract that can make
   an arbitrary call collects by naming a destination that can receive.
4. **Gas-guzzling recipient.** The child frame is capped at
   `DELIVERY_GAS_LIMIT`, so it burns at most that, and `DELIVERY_GAS_RESERVE`
   remains in the settling frame to record the credit.
5. **Return-data bomb.** The settling frame discards the child's return data, so
   it never pays for the copy. The child pays inside its own budget and dies
   there.
6. **Token that moves value and reports failure.** The child frame reverts, which
   undoes the movement (I7). The credit is backed.
7. **Reentrant recipient.** The guard rejects the nested call. A callback that
   swallows the rejection still receives its payout; one that propagates turns
   the delivery into a credit. No swap other than the one being settled changes.
8. **Gas starvation by the claimer.** Shrinks the delivery budget and pushes the
   payout into the credit path. It cannot revert the settlement. This is the
   accepted trade in section 6.
9. **Redirect attempt by the claimer.** `withdraw` reads `msg.sender`; a claimer
   has no credit and `InsufficientCredit` or `NoCredit` reverts.
10. **Fee-on-transfer lock.** Rejected at both lock entries with
    `UnsupportedToken`, and no record is kept.

## 6. Known limitations and accepted risks

**A1 Gas starvation defers a payout.** A claimer that supplies little gas forces
the credit path, costing the recipient one withdrawal transaction. Accepted:
value is conserved, the same account is paid, and the alternative (reverting)
republishes a secret and leaves the swap `Open`, which is the vulnerability being
fixed. Mitigation is procedural: submit settlements with
`estimateGas + DELIVERY_GAS_LIMIT + DELIVERY_GAS_RESERVE`, which is published
on-chain through `deliveryGasPolicy()`.

**A2 A minimal gas estimate lands on the credit path.** Gas estimation minimises
gas, and the credit path is cheaper than a successful token transfer, so a bare
estimate defers a payout that would have gone through. This is a documented
integration requirement, published on-chain by the contract. It matters most for
sponsored claims, where a recipient without gas on the paying chain cannot
withdraw a credit.

**A3 A whole-transaction out-of-gas still leaks the preimage.** If the claim
transaction has too little gas, it reverts and the preimage is public. The
contract cannot defend against a caller under-funding its own transaction, and
no third party controls that gas. The reserve guarantees the delivery attempt
cannot consume what the credit fallback needs; it does not create gas that the
transaction never carried. Precisely: when `gasleft()` at the delivery attempt
exceeds `DELIVERY_GAS_RESERVE`, the settling frame retains at least the reserve
whatever the child does. Below that the budget is zero, the attempt fails
immediately for a few hundred gas, and the frame keeps everything it had, which
may still be less than the credit path costs. The only actor who can land in
that window is the submitter, who already holds the preimage.

**A4 A native credit owed to a contract that cannot receive is stuck.** A credit
is owned by the recipient address the fund owner chose. `pushCredit` is
permissionless and pays that address, so a token credit owed to a contract that
cannot make calls is still recoverable by anyone. The unrecoverable case is
narrower: a native credit owed to a contract that can neither call `withdraw`
nor accept a plain transfer. Then every exit fails and the value stays in the
ledger. There is no recovery path and no owner, by design.

**A5 Malicious-token accounting within that token.** Both the lock path (I11)
and the delivery path (I7) ask the token for this contract's own balance, so a
token that lies about it can distort its own escrow accounting and its own
delivery decisions. Damage stays inside that token: escrow, credits and the
conservation invariant are per-token.

Consulting `balanceOf` during a settlement is safe because of where it runs. The
read is a low-level call inside the `selfDeliver` child frame, so a `balanceOf`
that reverts, runs out of gas, or answers with an oversized payload fails the
delivery attempt, and a failed attempt is a credit. The revert leaving
`selfDeliver` is this contract's own four-byte error, never the token's payload.
The contract contains no typed external call at all, which is what makes that
property checkable: a typed call is the only construct that re-emits a callee's
revert data verbatim, and the settling frame copies whatever the attempt
reverted with. Before this was closed, a token reverting from `balanceOf` with a
120,832-byte payload cost the settling frame 97,764 gas of the 150,000 reserve.
The measured figure now is 47,074 for every payload size, identical to a
four-byte revert.

**A6 A token whose return data is not a canonical boolean.** `_tokenCall`
decodes the return word through the compiler, so a non-boolean word makes the
decode revert. On the settlement path that is contained (credit). On the lock
path it rejects the lock. On the withdrawal path it blocks that withdrawal while
leaving the credit intact.

**A7 Forced native value is unaccounted.** Value pushed in without a call raises
`balance` above the accounted sum, which is why I5 is an inequality. There is no
sweep and no owner, so it is unrecoverable. No swap is affected.

**A8 Griefed refund.** `refund` is permissionless, so anyone can call it after
the timeout with little gas and push the initiator into the credit path. Same
trade as A1.

**A9 Reserve sizing is measured on EVM only.** The settling frame's whole cost
after the delivery attempt is **47,074 gas** on the EVM target, traced with
`debug_traceTransaction` at a gas limit that leaves the frame holding exactly
`DELIVERY_GAS_RESERVE`. That covers two cold storage writes (the settling frame
writes the credit slots only after the attempt fails, so it never warmed them
itself, and a reverted child frame's access-list warming is rolled back with it),
a `LOG3` with one data word, the guard reset, and the copy of the attempt's
revert payload. The figure is identical for a four-byte revert and for a
120,832-byte one, which is the property A5 describes.

Against a 150,000 reserve that is a **3.19x margin**, and the suite asserts that
twice the worst observed cost still fits. The figure previously quoted here,
41,000, was an opcode estimate; the real number is measured and pinned by
`#47 gas: a revert bomb out of the delivery frame costs the settling frame
nothing`.

QRVM-512 is where this still needs a reviewer. The semantic suite proves
QRVM-512 correctness and says nothing about QRVM-512 gas. If the settling
frame's cost there exceeds 150,000, every deferred settlement on the QRL leg
reverts after the preimage check, deterministically, which is the exact failure
this contract removes. Carrying the reserve costs only the documented
transaction-limit buffer, since unused gas is refunded. **Measuring the settling
frame on the QRL target is a deployment blocker**; section 8 gives
the measurement to run.

**A12 The conservation invariant has an observation window during a token
lock.** `_lock` writes the `Open` record and emits `Locked` before
`transferFrom` pulls the funds, inherited unchanged from HTLCv2. During the
token's `transferFrom`, an external reader sees an `Open` swap whose escrow has
not arrived, so I5 is momentarily false from outside. Internally nothing can act
on it: the lock holds the guard, so every mutator reverts `Reentrancy`, and both
`balanceOf` reads are `STATICCALL`s. The ordering is kept because the record
existing during the pull is a second line of defence against a duplicate lock
if the guard were ever weakened. A future contract must therefore treat
`getSwap` and `outstandingCredit` as settlement inputs only outside a call it
made itself.

**A13 A Claimed swap does not mean the recipient holds the funds.** The
`Claimed` event and `status` are byte-identical to HTLCv2, where they did imply
delivery. An integrator that reads either as "funds received" mis-accounts every
deferred payout. The distinguishing signals are `PayoutCredited` in the same
receipt and `creditOf(token, recipient)`.

**A14 The claim window closes hard at `timeout`.** A claim broadcast in good time
that mines at or after `timeout` reverts `TimeoutPassed` with its preimage
already public and the swap still `Open`. That is the #47 shape produced by
inclusion latency, and it is the one revert after the preimage check that remains
by design: moving the cutoff would overlap the claim and refund windows and
create a worse ambiguity. The margin therefore belongs to the client, as a hard
invariant: never broadcast a claim inside a finality-sized margin of the timeout.
`docs/FINALITY.md` section 3.3 states it and names the existing knobs
(`MM_CLAIM_SAFETY_S`, the browser's `CLAIM_MARGIN_S`, and the taker's claim
margin). Covered by `parity: claim closes at timeout, refund opens at timeout`,
which also asserts that no preimage was stored.

**A15 The delivery budget is a constant in an immutable contract, and two
supported tokens are upgradeable.** `DELIVERY_GAS_LIMIT` is 100,000. Measured
against the live implementations on a mainnet fork (section 2), the worst real
case is 48,763 for USDT to a recipient with no prior balance, a 2.05x margin.
USDC and USDT are both upgradeable proxies, so a future implementation could
raise their cost past the budget. The failure degrades service without losing value: the payout defers to a
credit, `withdraw` and `pushCredit` forward all remaining gas with no cap, and
`pushCredit` is permissionless, so even a recipient with no gas on the paying
chain can be paid by anyone. Raising the constant would widen the griefing
ceiling a hostile recipient can impose on a sponsor, which is why it stays at a
measured 2x.

**A16 A token that burns all the gas it is given immobilises its own credits.**
Every exit reaches the token, so a token whose `transfer` consumes every unit of
gas cannot be made to pay anyone. Value stays conserved and accounted, no other
token is affected, and the swap stays terminal. Routing the withdrawal through a
bounded trampoline would not help: a token that refuses to cooperate cannot be
made to, and the alternative, treating a bounded failure as a success, would
destroy the credit. Covered by `#47 token: a token that burns all gas in transfer
immobilises only itself`.

**A17 Hashlock squatting on the counterparty leg.** A hashlock is single-use per
contract forever, so anyone who learns one before the counterparty locks can burn
it there with a dust lock. Inherited unchanged from HTLCv2. The cost is a wasted
setup, with no loss: the squatted leg cannot be funded, and the client rule
is to verify the hashlock is unused on the responder chain before assigning or
funding, then abort and relist with a fresh secret. `docs/ARCHITECTURE.md`
section 2 already states that rule for prelocks. It remains a real griefing
surface for a permissionless mainnet deployment.

**A10 Preimage disclosure window.** The RPC endpoint that receives a claim sees
the preimage. That is unchanged from HTLCv2 and is a deployment concern, covered
in `docs/ARCHITECTURE.md` section 7 and `docs/FINALITY.md`.

**A11 Compiler maturity.** hypc reports itself as a pre-release compiler. Both
targets are pinned by version and codegen settings, and the artifact loaders
reject any drift, but the compiler itself has not been independently audited.

## 7. Test matrix

Gate: `npm test` at the repository root, which compiles both targets, validates
manifests and artifact envelopes, runs the HTLCv2 suite on a throwaway anvil,
runs the HTLCv3 suite on a throwaway anvil, and runs the QRVM-512 semantic suite
in four modes (legacy and via-IR, each unoptimized and optimized). Result on the
reviewed tree: 6 node tests, 31 HTLCv2 scenarios, 38 HTLCv3 scenarios, 6
semantic runs, 0 failures.

Issue #47 acceptance criteria mapped to tests. All test names are from
`scripts/test-htlcv3.js` unless stated.

| Criterion | Test |
|---|---|
| claim state and the revealed preimage cannot roll back because delivery failed | `#47 native: a nonpayable recipient ends the claim as a credit`; `#47 token: an issuer blocklist on the recipient credits, then withdraws`; `#47 token: an HTLC-wide freeze credits every settlement`; `#47 token: false-return, reverting and return-bomb transfers all credit`; `#47 native: a gas-guzzling and a reverting recipient both credit`; `#47 gas: a settlement is never refused for gas, at any workable limit` |
| failed delivery becomes a conserved credit, never an initiator refund after Claimed | `#47 native: a nonpayable recipient ends the claim as a credit` (refund reverts `SwapNotOpen` after the timeout); `#47 invariants: a mixed multi-swap sequence conserves value throughout` |
| the recipient can withdraw or name an alternate payout address | `#47 token: an issuer blocklist on the recipient credits, then withdraws`; `#47 credits: partial withdrawals, withdrawAll, and destination validation`; `#47 credits: a nonpayable recipient contract collects through a payable destination`; `Q128HTLCv3.exerciseWithdrawDestinationAliases` |
| an arbitrary claimer gains no redirect authority | `#47 credits: only the credited account can move them`; `#47 trampoline: selfDeliver is not reachable from outside` |
| checks-effects-interactions and reentrancy cover native and token withdrawals | `#47 reentrancy: a recipient re-entering claim is blocked, delivery still lands`; `#47 reentrancy: a callback that propagates its revert falls back to a credit`; `#47 reentrancy: a withdrawal cannot be re-entered` |
| no-return tokens | `parity: no-return (USDT-style) tokens deliver directly`; `parity: full cross-chain atomic swap across two instances` |
| false-return tokens | `parity: a token that declines transferFrom cannot be locked` (lock path); `#47 token: false-return, reverting and return-bomb transfers all credit` (delivery path) |
| fee-on-transfer behaviour | `parity: fee-on-transfer tokens are rejected at both lock entries` |
| issuer blocklist changes | `#47 token: an issuer blocklist on the recipient credits, then withdraws`; `#47 refund: a blocked initiator keeps the value as a credit` |
| HTLC-wide freezes | `#47 token: an HTLC-wide freeze credits every settlement` |
| nonpayable recipients | `#47 native: a nonpayable recipient ends the claim as a credit`; `#47 credits: a nonpayable recipient contract collects through a payable destination` |
| malicious callback recipients | the three `#47 reentrancy` tests; `#47 native: a gas-guzzling and a reverting recipient both credit`; `#47 gas: the credit reserve survives a recipient burning the whole budget`; `#47 token: a 64k-word return bomb cannot exhaust the credit reserve` |
| value conservation, EVM target | every HTLCv3 test that moves value runs the shared tracker after each step, which re-derives `balance == sum(Open) + outstandingCredit` from chain state and also checks that the per-account credit ledger sums to `outstandingCredit`; `#47 invariants: a mixed multi-swap sequence conserves value throughout` |
| value conservation and terminal state, QRL target | `Q128HTLCv3.exerciseTokenCreditAliases`, `.exerciseWithdrawDestinationAliases`, `.exerciseNativeCreditAliases`, `.exerciseDeliveredTokenAliases`, `.exerciseDeliveredNativeAliases`, each in four codegen modes. The last two exist because the credit cases all fail delivery on purpose, so only they prove the bounded `selfDeliver` self-call round-trips a 64-byte payout address and lands on the right account |
| a token that reports success and moves nothing | `#47 token: a token that reports success and moves nothing credits` |
| a return bomb whose leading word decodes as success | `#47 token: a return bomb cannot exhaust the credit reserve`, at four tail sizes. Note what this one does and does not show: above roughly 122,880 bytes the child runs out of gas inside its own budget and returns nothing, so the large sizes exercise the out-of-gas path. The settling frame's exposure to a payload that does reach it is measured separately |
| a revert payload bubbled out of the delivery frame | `#47 gas: a revert bomb out of the delivery frame costs the settling frame nothing`: five payload sizes up to 120,832 bytes plus a case pinned at the reserve floor, each asserting the settling frame's traced cost stays at the four-byte-revert baseline |
| the credit ledger cannot be pushed into an overflow | `#47 ledger: the lockable amount is capped so credits cannot overflow` |
| a gasless recipient can be paid without choosing the destination | `#47 credits: anyone can push a credit, and only to its owner` |
| a token that burns every unit of gas it is given | `#47 token: a token that burns all gas in transfer immobilises only itself` |
| no compiler-generated getter over a wide key, on either target | `scripts/abi-guards.js` pins the address-touching ABI surface of all 20 contracts in the bundle; `scripts/test-q128-accessors.js` applies it to the QRL-target build and `scripts/artifacts.test.js` to both targets, including a self-test that the guard rejects an added getter |
| terminal-state invariants | the tracker asserts every tracked swap is Open or terminal after every step, and compares a Claimed swap's stored preimage against the exact expected value wherever the test knows it |
| HTLCv2 properties preserved | the 15 `parity:` tests |
| new immutable deployment, current addresses untouched | `scripts/artifacts.test.js` asserts the HTLCv2 ABI has no `withdraw` and that the v3 `getSwap` tuple shape matches v2; the HTLCv2 runtime hashes in section 2 reproduce the live deployment |

Invariants to tests:

| Invariant | Covered by |
|---|---|
| I1, I12 | `parity: claim closes at timeout, refund opens at timeout`; `parity: settled swaps cannot be claimed or refunded again`; `parity: open locks, assign write-once, release, NotAssigned guard` |
| I2 | `parity: a hashlock is single-use forever` |
| I3 | `parity: open locks, assign write-once, release, NotAssigned guard`; `parity: lock rejects invalid parameters, including the HTLC itself` |
| I4 | every `#47` credit test asserts `status == Claimed` and the stored preimage |
| I5 | the tracker in every test; `#47 invariants: a mixed multi-swap sequence conserves value throughout` |
| I9 | the tracker sums `creditOf` over every account that appears as an initiator or a recipient of a tracked swap and compares it with `outstandingCredit`; those are the only accounts a credit can accrue to |
| I13 | `#47 ledger: the lockable amount is capped so credits cannot overflow` |
| A14 | `parity: claim closes at timeout, refund opens at timeout` |
| A16 | `#47 token: a token that burns all gas in transfer immobilises only itself` |
| I6 | `#47 credits: only the credited account can move them` |
| I7 | `#47 token: false-return, reverting and return-bomb transfers all credit`; `#47 token: a token that reports success and moves nothing credits` |
| I13 | `#47 ledger: the lockable amount is capped so credits cannot overflow` |
| I8 | `#47 native: a nonpayable recipient ends the claim as a credit` |
| I10 | the three `#47 reentrancy` tests; `#47 trampoline: selfDeliver is not reachable from outside` |
| I11 | `parity: fee-on-transfer tokens are rejected at both lock entries` |

## 8. The measurement to run on the QRL v3 devnet before deployment

A9 is a deployment blocker and this is what settles it. Run it on the private
QRL v3 devnet (chain 3151909), against the QRL-target artifact, with no real
value.

**What to deploy.** `build/hyperion/qrl/HTLCv3.json` plus two adversarial
tokens from `contracts/test/MockRecipients.hyp`: `SilentSuccessToken` (a
delivery that fails cheaply) and `RevertBombBalanceToken` (a delivery that fails
with a large payload).

**Scenario A, the settling frame's cost.** For each token: `lockToken` a small
amount to a fresh 64-byte recipient, then `claim` from a third account with a
gas limit of `estimateGas + DELIVERY_GAS_LIMIT + DELIVERY_GAS_RESERVE`, which
pins the settling frame at the reserve floor. Arm the bomb at 4 bytes, then at
120,832 bytes. The figure to record is the gas the settling frame consumes after
the delivery attempt returns, the same quantity `settleFrameCost` reads from a
trace in `scripts/test-htlcv3.js`. On the EVM target it is 47,074 for both
payload sizes.

**Bound.** That figure must stay **under 150,000** (`DELIVERY_GAS_RESERVE`), and
it must not grow with the payload size. The EVM margin is 3.19x. If the QRL
figure exceeds 150,000, raise `DELIVERY_GAS_RESERVE` and redeploy before any
value moves; if it grows with the payload size, the target re-emits a callee's
revert data somewhere this review did not find, and that has to be understood
before deployment.

**Scenario B, the delivery budget.** The QRL leg settles the native coin, so the
token path is only reachable if a QRC-20 leg is ever added. Measure the native
delivery attempt to a plain 64-byte account and to a contract that rejects the
transfer, and record both. The figure must stay under 100,000
(`DELIVERY_GAS_LIMIT`). On the EVM target a native delivery to an account costs
about 9,700 and the worst measured token delivery is 48,763 (section 2).

**Scenario C, the claim floor.** Sweep the claim gas limit upward from below the
estimate and confirm the same property the EVM suite asserts: every transaction
that completes leaves the swap terminal, and every transaction that fails leaves
it `Open` with no preimage stored.

If the QRL execution client exposes no step tracer, Scenario A can be run
differentially instead: claim once with a cheap failure and once with the bomb
armed, at the same gas limit, and compare total gas used. The two must be equal
to within a few hundred gas.

## 9. Review questions we would most like answered

1. Is `DELIVERY_GAS_RESERVE` sufficient on the QRVM-512 gas schedule, in the
   worst case where both credit slots are cold and the child frame consumed its
   entire budget? A9 treats this as a deployment blocker and we would like it
   measured independently.
2. Is `DELIVERY_GAS_LIMIT` high enough for the intended asset set and for smart
   contract recipients, and low enough that a hostile recipient's griefing of a
   sponsor stays acceptable?
3. Is the `selfDeliver` trampoline the right boundary, or is there a cheaper
   construction that keeps return-data copying and partial-movement rollback out
   of the settling frame?
4. Does any path exist where a swap reaches a terminal state without either
   delivering or crediting exactly `amount`?
5. Is discarding the child frame's return data in `_settle` free of any
   information the contract should have acted on?
6. Does the accepted gas-starvation trade (A1, A2, A8) hold under an adversary
   we have not modelled, in particular one that profits from deferring a payout
   as well as from reverting it?
7. Are the HTLCv2 properties this contract inherits still correct in the
   presence of the credit ledger, especially `release` against `assign`?
