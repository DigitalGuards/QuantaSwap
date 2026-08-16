# QuantaSwap Fee and Revenue Model

Status: design proposal, July 2026. No code changes; this document is the decision basis for fee work in Phases 3-4. Companion to `docs/ARCHITECTURE.md`.

## 0. Summary of the recommendation

Protocol mode stays fee-free forever on the deployed v1 HTLCs. It is the trust anchor, the marketing story ("pure protocol, zero rake"), and it is unenforceable to charge for anyway. Solver mode is the revenue product: spread-based pricing embedded in the quote (no contract change required), plus an optional explicit protocol fee enforced by a fee-aware HTLC v2 if and when on-chain fee transparency is wanted. Ship nothing fee-related to users on testnet beyond instrumentation and the solver spread engine; turn revenue on at QRL v2 mainnet.

## 1. Candidate fee capture points

Five candidate mechanisms, with concrete mechanics.

### 1.1 Contract fee at lock time (skim on `lockNative`/`lockToken`)

Mechanics: HTLC v2 computes `fee = amount * feeBps / 10000` inside `_lock`, records `amount - fee` as the swap amount, and credits `fee` to a treasury accrual. The locker signs one transaction as today; the fee lands in the HTLC's fee ledger on the chain where the lock happened.

Problems: the on-chain locked amount no longer equals the agreed amount, so both clients' verification logic (`SwapFlow.tsx` `initiatorLockIssue`/`responderLockIssue`) must model the fee. Worse, the fee is paid even if the swap fails and refunds. A counterparty can grief you into paying fees by never responding. Rejected.

### 1.2 Contract fee at claim time (skim on `claim`)

Mechanics: HTLC v2 stores the full locked amount; `claim` pays `amount - fee` to the recipient and accrues `fee` for the treasury. `refund` pays the full amount back to the initiator, always fee-free. The claimer signs `claim(hashlock, preimage)` exactly as today (still permissionless, so sponsored claims keep working); the fee lands in the HTLC's internal fee balance on the claim chain, withdrawable by the treasury address fixed at deploy.

Properties: fee only on success, refund path untouched, both sides see gross amounts on chain, fee parameters are immutable constructor arguments so the "no owner, no pause, no upgrade" invariant survives (a fee change is a new deployment). This is the only contract-enforced design worth building. Detailed sketch in section 4.

### 1.3 Order book / matching service charge

Mechanics options: (a) pay-to-post, maker pays a small fee (on-chain payment reference or Lightning-style voucher) before the order is listed; (b) pay-to-match, taker's `accept` requires payment; (c) success fee invoiced off-chain.

All three are conventional, not enforced. The order book is deliberately coordination-only; its small lockfile-pinned runtime dependency set verifies portable maker signatures, while clients still re-verify everything on-chain and the protocol explicitly degrades to out-of-band coordination if the server disappears (ARCHITECTURE section 3). Two parties who found each other on the book can complete the swap without ever paying the book, and the frontend is GPL so a fee-stripped mirror is a `git clone` away. Any enforcement attempt (withholding the counterparty's address until payment) just pushes users out-of-band and damages the zero-maintenance-floor story. Rejected as a revenue line; keep the book free.

### 1.4 Solver spread (quote-embedded pricing)

Mechanics: in solver mode the solver quotes `amountOut` for a given `amountIn`. The quote is `mid_price * (1 - spread)` where spread covers: the free-option premium (the user can abandon after the quote), inventory and rebalancing cost, gas on both legs including the sponsored claim, and the protocol margin. The user signs only their own lock; the solver signs its lock and the sponsored claim. The fee lands implicitly in the solver's inventory: the solver's WETH-side receipts exceed what its QRL-side payouts cost at mid, and the difference accumulates in the TEE-held solver wallets, swept periodically to treasury.

Properties: fully enforceable, because the product is the solver's own inventory and quoting. You cannot bypass a spread on liquidity you do not have. No contract changes needed; works on the deployed v1 HTLCs today. The TEE attestation makes the spread policy auditable (the quoting code is the published build), which turns "trust our pricing" into "verify our pricing".

### 1.5 Sponsored-claim service fee

Mechanics: a relayer submits `claim` for a recipient with no gas on the claim chain. Because `claim` is permissionless with the recipient fixed at lock time, the relayer cannot steal, but also cannot be paid by the contract as deployed. Options: (a) charge off-chain (solver bundles the gas cost into the spread, the recommended path); (b) HTLC v2 adds a locker-funded `claimTip` paid to `msg.sender` of a successful claim, creating an open relayer market for protocol mode.

Properties: (a) is revenue-neutral plumbing inside 1.4. (b) is a protocol feature, not a revenue line: the tip goes to whoever claims, not to QuantaSwap. Worth adding to v2 for protocol-mode UX, but it does not fund the project.

## 2. Enforceability analysis

The blunt hierarchy, strongest first:

| Mechanism | Enforcement | Rational-user bypass |
|---|---|---|
| Solver spread (1.4) | Economic: the spread is inseparable from the liquidity | None. Alternative is protocol mode: find your own counterparty, pay gas on both chains, hold the free-option risk yourself. The spread is the price of not doing that. |
| Claim-time contract fee (1.2) | Contract-enforced on that deployment only | Use the fee-free v1 HTLC (deployed, immutable, permissionless, address is public in `docs/DEPLOYMENTS.md`), or deploy your own from the GPL source. Two consenting parties choose their contracts freely. |
| Sponsored-claim tip (1.5b) | Contract-enforced payment to an arbitrary claimer | Claim yourself if you have gas; set tip to zero. |
| Order book charge (1.3) | Conventional only | Read the book, coordinate on Discord; run a mirror; the server cannot verify payment without becoming custodial or on-chain-aware, which its design forbids. |
| Lock-time contract fee (1.1) | Contract-enforced on that deployment | Same bypass as 1.2, plus it is strictly worse (fees on failed swaps). |

The structural reality: **users can always deploy their own fee-free HTLC.** The v1 source is GPL-3.0, 166 lines, one `hypc` compile away, and the already-deployed v1 instances can never be paused or removed. A contract fee therefore only captures users who arrive through the hosted frontend and accept its default contract addresses. That is exactly the "interface fee" model (Metamask Swaps, Uniswap Labs interface): it monetizes convenience and distribution, not the protocol. It works commercially, but it means the fee-aware HTLC is a frontend-default question, not a protocol question, and it costs the "zero rake protocol" narrative if applied to protocol mode.

Conclusion: only 1.4 has real teeth. 1.2 is a legitimate optional add-on for solver mode (on-chain fee transparency) and a poor fit for protocol mode.

## 3. Recommended model

### 3.1 Who pays what

| Mode | Fee | Level | Capture |
|---|---|---|---|
| Protocol mode | None, permanently | 0 bps | n/a. This is the trust anchor and the audit-friendly baseline. Both parties already pay 2x gas and hold option risk; charging them anything they can trivially bypass buys pennies and costs the story. |
| Solver mode, launch | Spread only | 40-80 bps effective, dynamic | Solver inventory, swept to treasury |
| Solver mode, later | Spread + explicit protocol fee | Spread 30-60 bps + 10-20 bps protocol fee | Spread in inventory; protocol fee accrued in HTLC v2, withdrawn by treasury |

Comparables that anchor the range:

| Service | Type | Fee |
|---|---|---|
| Stargate | Message bridge | ~6 bps |
| Across | Intent bridge | ~5-10 bps + relayer fee |
| Hop | Bridge | ~4 bps + bonder fee |
| Uniswap Labs interface | DEX frontend fee | 15-25 bps |
| Metamask Swaps | Wallet aggregator | 87.5 bps |
| Komodo AtomicDEX | Atomic swap DEX | 13 bps taker |
| Boltz | LN/BTC submarine swaps | 10-50 bps |
| THORChain | Cross-chain native swaps | slip-based, typically 30-100+ bps effective |
| Instant exchangers (ChangeNOW etc.) | Custodial spread | 50-100+ bps |

QuantaSwap solver mode is closest to THORChain/Boltz/instant-exchanger territory: cross-chain, native coins both sides, hours-long timelocks, thin QRL liquidity, and the solver bearing the abandonment option. 40-80 bps effective at launch is defensible and still undercuts custodial exchangers; tighten as volume, shorter timelocks (better finality data), and competition allow. The spread must be dynamic: floor bps + volatility term (option premium over the quote-to-lock window) + inventory skew term + fixed gas recovery (four transactions worth, including the sponsored claim).

### 3.2 Fees and the timelock/refund paths

Rule: **a refund never pays a fee.** Justification: a refunded swap delivered nothing; charging on it converts the counterparty's silence into a griefing weapon (lock against someone, never respond, they pay fees to get their own money back) and makes the fee a tax on the protocol's own safety mechanism. Every fee in this design triggers only on `claim`:

- Claim-time fee (1.2): deducted from the claim payout, `refund` returns the full amount.
- Solver spread (1.4): if the swap aborts, both legs refund in full; the solver earned nothing and the user lost nothing but time. Correct by construction.
- Quote expiry interacts cleanly: an expired quote the user never locked against costs nobody anything; a lock after expiry is simply not responded to and refunds in full.

The one deliberate exception to consider later: an initiator abandonment bond (ARCHITECTURE section 2, free-option mitigation 3) is forfeited on refund by design. That is a penalty, not a fee, it goes to the injured counterparty, not the treasury, and it is out of scope here.

### 3.3 Treasury handling on two chains

- Ethereum leg (mainnet later, Sepolia now): treasury = Safe multisig (2-of-3 minimum) at mainnet; plain EOA acceptable on Sepolia only.
- QRL leg: no Safe deployment exists on QRL v2. Options: (a) a minimal Hyperion 2-of-N multisig vault (new audited surface), or (b) a single ML-DSA-87 cold address with the hexseed in offline storage, upgraded to (a) when fee balances justify it. Recommend (b) at mainnet launch, (a) within the first quarter of real revenue.
- In HTLC v2, `treasury` is an immutable constructor argument pointing at a **FeeVault** contract per chain, not at a key directly. The vault holds a rotatable `withdrawer` (two-step transfer). This confines the only admin key in the whole system to accrued fees; user funds remain admin-key-free. Rotating the withdrawer needs no HTLC redeploy.
- Solver sweep: the TEE solver's sweep policy (threshold, destination = FeeVault or treasury address, frequency) is part of the attested build, so operators cannot silently redirect revenue.

## 4. Contract changes: fee-aware HTLC v2

Only needed for the explicit protocol fee (3.1, "later" row) and the optional claim tip. Hyperion-style pseudocode, deltas from v1 only:

```
// contracts/hyperion/HTLCv2.hyp (sketch)
contract HTLCv2 {
    // Immutable fee policy: no owner, no setter, a change is a redeploy.
    address public immutable treasury;   // FeeVault address on this chain
    uint16  public immutable feeBps;     // e.g. 15 = 0.15%; hard cap enforced
    uint16  private constant MAX_FEE_BPS = 100; // constructor reverts above 1%

    struct Swap {
        // ... v1 fields unchanged ...
        uint256 claimTip;   // optional, locker-funded, paid to claim caller
    }

    // Fees accrue pull-based so claim() can never be bricked by a
    // reverting treasury: claim only does internal accounting for the fee.
    mapping(address token => uint256) public accruedFees;

    function lockNative(bytes32 hashlock, address recipient, uint256 timeout,
                        uint256 claimTip) external payable {
        // amount = msg.value - claimTip; both recorded; rest as v1 _lock
    }

    function claim(bytes32 hashlock, bytes32 preimage) external {
        // v1 checks unchanged, then:
        uint256 fee = (s.amount * feeBps) / 10000;   // rounds down; dust pays 0
        accruedFees[s.token] += fee;
        _payout(s.token, s.recipient, s.amount - fee);
        if (s.claimTip != 0) _payout(address(0), msg.sender, s.claimTip);
    }

    function refund(bytes32 hashlock) external {
        // v1 unchanged PLUS returns claimTip to initiator: full amount,
        // never a fee, never a tip kept.
    }

    function withdrawFees(address token, address to) external {
        require(msg.sender == treasury);
        uint256 bal = accruedFees[token];
        accruedFees[token] = 0;
        _payout(token, to, bal);
    }
}
```

Design notes:

- `feeBps` and `treasury` immutable preserves the no-admin-keys invariant over user funds. `MAX_FEE_BPS` in the constructor caps what any future deployment can claim to be "the official HTLC".
- Pull-based `accruedFees` + `withdrawFees` means a broken or compromised FeeVault can never block claims or refunds; worst case the fees sit unclaimed.
- Same artifact still deploys to both chains (constructor args differ per chain: each chain's vault address).
- `getSwap` keeps returning gross `amount`; clients verify gross and display net (`amount * (10000 - feeBps) / 10000`).
- Hashlock single-use stays per contract instance, so v1 and v2 hashlock namespaces are independent; a secret used on v1 must still never be reused on v2 (client rule already exists).

### Migration and coexistence

- v1 stays deployed and referenced forever; it is the protocol-mode default and the fallback if v2 has an issue.
- `frontend/src/config.ts` legs grow a per-mode contract selection: protocol mode pins v1 addresses, solver mode pins whichever deployment the current quote references.
- Order book schema (`server/src/store.ts` `Order`) gains an optional `htlcVersion` (or explicit per-leg contract addresses) so maker and taker deterministically agree on which deployment both legs use; clients reject a counterparty lock found on a different contract than agreed (they already reject wrong recipient/amount/timeout, this is one more field in the same on-chain verification).
- Solver quotes are signed and include the exact HTLC addresses for both legs; the frontend verifies the user's lock target against the quote before signing.
- No state migrates: an HTLC swap lives and dies on one contract pair; in-flight v1 swaps finish on v1.

## 5. Attack and abuse surface of the fee mechanism

| Vector | Analysis | Mitigation |
|---|---|---|
| Fee evasion via direct contract use | Users call v1 (fee-free) directly or deploy their own HTLC; only hosted-frontend flows pay a contract fee | Accepted by design: protocol mode is free anyway, and solver spread is not evadable. Do not build enforcement; it cannot work. |
| Fee evasion inside solver mode | User takes the solver's quote info but locks on v1 hoping the solver responds anyway | Solver only responds to locks on the exact contract, amount, recipient and hashlock in a live signed quote; anything else lapses harmlessly (quote lifecycle, ARCHITECTURE section 4) |
| Dust griefing on the order book | Spam orders to fill `MAX_OPEN_ORDERS` (200) and DoS listing; charging per-order would require custody or on-chain awareness | Existing guards: 0.001 minimum, per-IP rate limits, TTL sweeps, Cloudflare. If pressure appears: per-maker open-order cap keyed by address, then optional proof-of-lock (order surfaces only after the maker's on-chain lock exists), never a fee |
| Griefing the fee itself | Counterparty stalls to force fee payment | Impossible by construction: fees trigger only on successful claim; refund is always whole |
| Solver front-running its own users | Solver sees the user's lock in the mempool or post-lock price move and reneges (inverse free option), or shades quotes using pending-flow knowledge | TEE attestation binds quoting and respond-or-lapse policy to the published build; quote expiry bounds the window; publish solver fill-rate metrics; later: solver bond slashed on attributable reneges |
| Treasury/FeeVault key compromise | Attacker drains accrued fees | Blast radius is fees only, never user funds (pull-based accrual, immutable HTLC). Vault withdrawer is rotatable two-step; sweep thresholds keep at-risk balances small; multisig at mainnet |
| Malicious "official" redeploy | A rogue deploy with 99% feeBps posing as v2 | `MAX_FEE_BPS` constructor cap, addresses pinned in signed frontend releases and `docs/DEPLOYMENTS.md`; clients hard-code, never fetch contract addresses from the order book |
| Rounding abuse | Amounts sized so fee rounds to 0 | Floor rounding means sub-`10000/feeBps` wei swaps pay nothing; economically irrelevant above the existing 0.001 dust minimum. Accept |
| claimTip theft | Relayer races a claim purely for the tip | That is the feature working: recipient is fixed, any claimer completes the swap. No harm |

## 6. Phased rollout

Aligned to the existing roadmap (Phase 2 protocol mode live on testnet, Phase 3 solver, Phase 4 audit + mainnet). Testnet value is play money: nothing charged before mainnet matters, so testnet is for wiring and measuring, not earning.

### Now, Phase 2 tail (testnet, protocol mode live)

- No fees anywhere. Publish the fee policy (this document's section 3 table) in the frontend FAQ so the zero-rake protocol-mode commitment is on record early.
- Instrumentation only: index `Locked`/`Claimed`/`Refunded` events on both legs (completed volume, abandonment rate, time-to-claim). Abandonment rate directly prices the free-option premium in the solver spread later.
- Decision checkpoint: confirm protocol mode stays free permanently (recommended) so Phase 3 and 4 scope is fixed.

### Phase 3 (solver mode, testnet)

- Build the spread engine into the TEE solver: floor bps + volatility term + inventory skew + gas recovery, all parameters in the attested config. Target the 40-80 bps effective envelope with fake prices.
- Quote UI shows an explicit breakdown: mid rate, spread, "you receive". No hidden pricing even though it is spread-based.
- Sponsored claim gas priced into the spread; verify the accounting closes (solver inventory delta = sum of spreads - gas) over a testnet campaign.
- Implement and exercise the sweep-to-treasury path with a testnet FeeVault.
- Optional: deploy HTLCv2 + FeeVault to Sepolia + QRL testnet behind a feature flag to soak-test the claim-fee path and the `htlcVersion` plumbing, even if mainnet launches spread-only.

### Phase 4 (audit + mainnet)

- Audit scope: v1 HTLC (already deployed pattern), HTLCv2 + FeeVault if adopted, and the solver's respond-or-lapse and sweep logic as part of the attested build review.
- Mainnet deploys: v1 fee-free HTLC on both chains (protocol mode), HTLCv2 only if the explicit protocol fee is going live; otherwise defer, spread needs no new contract.
- Treasury: Safe multisig on Ethereum, cold ML-DSA-87 address (upgrading to a Hyperion multisig vault) on QRL, FeeVault withdrawer pointed at them.
- Turn on solver spread at launch (40-80 bps envelope); add the explicit 10-20 bps protocol fee via HTLCv2 only once volume justifies the extra audited surface and the transparency/accounting benefit is wanted.

## 7. Key recommendation and open decisions

**Recommendation**: protocol mode is free forever on the immutable v1 HTLCs; all revenue comes from solver mode as a dynamic spread (40-80 bps effective at launch) embedded in TEE-attested quotes, requiring zero contract changes; an immutable-parameter, claim-time-only, pull-accrual HTLC v2 (capped at 100 bps, refunds always whole) is specced and optionally soak-tested on testnet, but ships to mainnet only if an explicit on-chain protocol fee line is later wanted on top of the spread. Fees are never charged on refunds, full stop.

**Open decisions for the maintainer**:

1. Ratify "protocol mode free permanently" as policy. Everything else in this document assumes it; reversing later costs the trust story more than the revenue gained.
2. Spread-only vs spread + explicit protocol fee at mainnet. Spread-only is simpler and audit-cheaper; the explicit fee (HTLCv2) buys on-chain revenue transparency and a future hook for token/DAO value accrual. Can be deferred past mainnet launch.
3. Launch spread envelope and dynamics: accept the 40-80 bps target, or start wider given zero-day QRL mainnet liquidity, and who sets the attested config parameters.
4. QRL-side treasury custody at mainnet: single cold ML-DSA-87 address first (fast) vs building the Hyperion multisig vault before launch (slower, stronger).
5. Whether to add `claimTip` to v2: pure protocol-mode UX (open relayer market for gasless claims), no revenue, small extra audit surface.
6. Whether to soak-test HTLCv2 on testnet during Phase 3 even if the mainnet decision (2) is spread-only.
