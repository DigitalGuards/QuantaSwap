# QuantaSwap Architecture

Status: build spec, July 2026. Phase 1 HTLC contracts and the original protocol UI are live at quantaswap.io. The signed federated Phase 2 order book, frontend flow, and self-hosted LP kit are implemented for testnet review and still await rollout plus independent operators. Solver mode (Phase 3) is not built yet.

## 1. Goal and constraints

Swap WETH or a supported stablecoin (USDC, USDT) on Ethereum against native QRL (QRL v2 / Zond, EVM-compatible) with atomic settlement and no custodian.

Constraints that shape the design:

- **QRL v2 testnet (chain ID 1337) fully supports contracts** (staking is the only feature not enabled there, and this project does not need it), so both HTLC legs are deployable and usable today against Sepolia + QRL v2 testnet. Real-value swaps additionally need QRL v2 mainnet, since legacy QRL mainnet has no smart contracts and cannot host an HTLC leg.
- **Both chains are EVM-compatible.** Contract sources are Hyperion-only (`.hyp`, compiled with the native `hypc`); the exact same artifact deploys to both legs, so the two chains run byte-identical bytecode. The canonical test gate runs that artifact on a throwaway anvil (`npm test`); there is no Solidity mirror and no Foundry suite.
- **QRL-side signing is post-quantum** (ML-DSA-87 via MyQRLWallet). The swap primitive itself is hash-based (sha256 preimage), which holds up post-quantum. The Ethereum leg inherits Ethereum's ECDSA assumptions; that risk belongs to the WETH holder, not to the protocol.
- **Zero-maintenance floor.** Protocol mode must remain usable if every QuantaSwap operator and server disappears: contracts only, order discovery degradable to out-of-band.

## 2. The HTLC core

One source, `contracts/hyperion/HTLC.hyp`, compiled once with `hypc` and deployed to both chains. Live testnet addresses: `docs/DEPLOYMENTS.md`.

### Swap record

```solidity
struct Swap {
    bytes32 hashlock;    // sha256(secret), secret is 32 random bytes
    address initiator;   // funds this leg, can refund after timeout
    address recipient;   // fixed payout target of claim()
    address token;       // ERC-20 address, or address(0) for native coin
    uint256 amount;
    uint256 timeout;     // unix time after which refund() opens
    Status  status;      // Open -> Claimed | Refunded
}
```

- `lock(...)` pulls funds in (ERC-20 `transferFrom`, or `msg.value` for native QRL) and stores the record under `swapId = sha256(hashlock, initiator, recipient, token, amount, timeout)`. For ERC-20 locks the contract verifies its balance grew by exactly `amount` and rejects the lock otherwise (`UnsupportedToken`): a fee-on-transfer or rebasing token could otherwise record a swap whose later payout would be funded by other swaps' escrow.
- `claim(swapId, secret)` verifies `sha256(secret) == hashlock`, pays `recipient`, stores the revealed secret in the record, emits it in the event. **Permissionless**: anyone may call it; the payout target is fixed at lock time, or, for open-recipient locks (below), at the initiator's one-time `assign()`, and `claim` reverts while it is unset. Either way a sponsored claim (section 5) can only pay the target the fund-owner chose.
- `refund(swapId)` after `timeout`, pays `initiator`.
- **Hashlock freshness**: the contract rejects a `lock` whose `hashlock` matches any prior swap on that contract. Reusing a secret whose preimage is already public would let anyone race the claim; clients must generate a fresh 32-byte CSPRNG secret per swap, and the contract enforces it defensively.

### Open-recipient locks (prelock)

`lockNativeOpen`/`lockTokenOpen` escrow with `recipient = address(0)`: a pre-funded listing made before any counterparty exists. Two functions complete the lifecycle:

- `assign(hashlock, recipient)`: initiator-only and **write-once**. It sets the payout target; from that moment the swap is indistinguishable from a classic lock (refund only at timeout). Assign closes at `timeout` alongside `claim`: past it, refund is already open and a payout target would only create ambiguity.
- `release(hashlock)`: initiator-only, valid **only while unassigned**, with no timeout gate (it is the initiator's own unencumbered money; post-timeout it merely duplicates the permissionless refund). It returns the escrow on demand and emits the ordinary `Refunded` event. Release and a nonzero recipient are mutually exclusive by construction, so the recipient's claim guarantee begins the moment `assign` lands.

`claim` reverts (`NotAssigned`) while the recipient is unset; without that guard a native claim would burn the funds to `address(0)`.

Client rules the contract cannot enforce (the frontend's swap machine gates all three):

- announce (freeze the taker pairing on the book) **before** assigning: assign is one-time, and assigning a taker who then walks away strands the escrow until T1;
- never assign while the shared hashlock is already used on the responder chain: records there are permanent, a dust-cost squat is enough, and assigning would trade the on-demand release for a forced wait until T1 (release instead, relist with a fresh secret);
- never reveal the secret while the own escrow is unassigned: with the preimage public, an unassigned lock could still be released, taking both sides.

Capital note, extending the free-option analysis below: a prelocked maker widens their own commitment from lock-at-match to lock-at-post, in exchange for a provably funded listing and a one-transaction match step; the exposure is bounded by `release()` while untaken. The taker-side option is unchanged.

### Hash function

`sha256`, not `keccak256`. Both EVMs expose the sha256 precompile, cost is negligible, and sha256 keeps the door open to non-EVM counterparties (BTC-family HTLCs) later. 32-byte preimage gives 128-bit post-quantum preimage resistance.

### Timelock asymmetry

The initiator (first locker, secret holder) gets the **longer** timeout.

```
T2 (responder leg)  >= claim window + finality margin on both chains
T1 (initiator leg)  >= 2 * T2
```

Rationale: the secret is revealed on the responder's leg at claim time. The responder then needs the remaining `T1 - now` to claim the initiator's leg. If `T1` were short, a claim near `T2` would leave the responder unable to collect. Testnet defaults: T2 = 2h, T1 = 4h. Finality margin covers Ethereum's ~13 min (2-epoch) finality and the equivalent on QRL v2 (qrysm Gasper); deep-reorg risk on either chain is why margins are hours, not minutes.

### Ethereum-leg asset set: WETH, USDC, USDT

The HTLC is token-agnostic (`lockToken` takes any ERC-20 address), so adding an asset is a client/registry decision, not a contract change. The launch set is WETH, USDC and USDT, declared in `config/tokens.json`: the registry carries each token's verified address per chain, decimals, dust minimum, and quirk flags, and is validated by the test gate. Order-book pairs in protocol mode: QRL/WETH, QRL/USDC, QRL/USDT.

What the stablecoins require beyond vanilla ERC-20:

- **Decimals.** USDC/USDT use 6 decimals, WETH 18. All protocol math is in base units; clients format amounts using the registry's `decimals`, never a hardcoded 18.
- **USDT's non-standard surface.** `approve`/`transfer`/`transferFrom` return no data; the HTLC's `_transferCall` accepts empty return data (and still rejects a returned `false`). USDT also enforces an approval race guard: a nonzero allowance cannot be changed, only reset. The client rule (already policy for WETH) is exact-amount approvals per swap: `transferFrom` then consumes the allowance back to zero, so the next approve is a fresh `0 -> amount`. If an approve happened but the lock never did, clients must reset the stale allowance to zero before re-approving (`scripts/smoke-eth-erc20.js` shows the flow).
- **USDT's dormant fee switch.** Mainnet USDT ships a fee-on-transfer mechanism currently set to zero. If it ever activates, `lockToken`'s received-amount check rejects new USDT locks outright rather than silently under-collateralizing the escrow. Swaps already open at that moment still settle from the balance actually held.
- **Issuer centralization (blocklist/freeze).** Circle and Tether can block addresses. A blocked *recipient* makes `claim` revert; a blocked *initiator* can strand the refund until the issuer unblocks them; a blocked *HTLC contract address* freezes every open swap in that token. A reverted secret-bearing claim is especially dangerous because its calldata can publish the preimage while the escrow remains `Open`, allowing the counterparty to claim the other leg. Every browser and market-maker claim therefore runs the exact HTLC call from the actual sender at `latest` immediately before submission and refuses to broadcast on any simulation error. This closes already-present payout failures, and the blocklist and native nonpayable-recipient cases are exercised in the test suite. It cannot close the issuer race between simulation and mining: a centralized issuer that changes policy in that interval can still break cross-leg atomicity. Stablecoin pairs therefore retain explicit issuer trust and are not equivalent to native-asset swaps.

Testnet mapping: Circle operates official Sepolia USDC (fundable at faucet.circle.com); Tether publishes no Sepolia deployment, so the QRL/USDT pair uses `tUSDT` (`contracts/testnet/TestStable.hyp`, deployed via `npm run deploy:test-stable`), which replicates USDT's 6 decimals, missing return values and approval race guard.

### Known protocol weakness: the free option

Between locking and `T2`, the initiator holds a free option: if price moves against the swap, they can simply never reveal the secret, and both sides refund. The responder loses nothing but time-value of locked funds. Mitigations, in build order:

1. Short responder timelocks (bounds the option's duration).
2. Solver mode: quotes carry an expiry and the solver prices the option into the spread.
3. Optional later: initiator bond forfeited on abandonment.

## 3. Protocol mode (Phase 1-2)

Pure HTLC. Order discovery is an order book; matching produces the parameters both parties feed to their `lock` calls.

- The order book (`server/`) is **coordination only**, never custody. New listings are portable ML-DSA-87 OrderV1 objects. Takers propose a short-lived signed FillIntentV1; the maker signs exactly one terminal FillV1, which selects the taker and announces the hashlock and timeouts, or CancelV1. A release-secret commitment lets the taker withdraw without another wallet prompt, but a release never reopens OrderV1. Clients verify the proof chain and still re-verify recipients, amounts, token addresses, and timeouts against on-chain HTLC state before committing funds or revealing a secret.
- OrderV1 also signs origin capability commitments. The maker creates a raw 32-byte maker token and, for a private order, a raw 32-byte share token before wallet authorization. Separate NUL-terminated SHA-256 domains commit those raw bytes. Public orders sign a zero share commitment; private orders sign a nonzero commitment. The client stages the exact signed request and raw preimages before its first POST, then retries that same envelope until its origin authenticates the response. Raw tokens remain local and never enter public proofs, federation events, or application logs.
- Public signed events are pulled between at most 16 explicitly configured mirrors through a durable content-addressed feed. Cursors are mirror-local and intentionally in memory; a restart requests a reset snapshot that reconstructs current orders and terminal evidence. Exact replays are idempotent. A two-worker pool gives each peer sync one total deadline, validates cursor continuity and duplicate ids, and checkpoints completed incremental pages. A bounded causal queue retries a child that arrives before its signed prerequisite. Conflicting OrderV1 terms under one signer-bound id, two fills, or fill plus cancel are retained as equivocation evidence and suppressed. Unsigned compatibility rows, private orders, bearer capabilities, maker presence, and IP metadata never federate. Sanitized status exposes public peer labels, state, counters, and timestamps without URLs, cursors, feed ids, proofs, accounts, capabilities, or raw errors.
- Retention admits at most 64 public portable orders within the 256-order global retained-state bound, including at most 48 federated rows and 16 first supplied by one direct peer. With eight intents and bounded conflict evidence per order, a current reset contains at most 1,472 records. Every federation response is capped at 32 MiB, and incremental pages stop at 4 MiB as well as 256 records. Public readers share a four-request global concurrency lane with one request per source. Operators may exchange 32-byte lowercase-hex bearer tokens to give configured peer pulls an independent reserved rate and concurrency lane. The signed feed remains publicly readable.
- Federation improves discovery and availability without creating consensus. A Byzantine maker can sign contradictory terminal artifacts during a partition. Mirrors detect that evidence when observed, clients stop new funding, and already funded parties follow independently verified HTLC state. The protocol makes equivocation detectable and preserves fund routing; it cannot make a dishonest maker globally single-writer without an on-chain or consensus sequencer.
- Both parties need gas on both chains (ETH for the Ethereum leg, QRL for the Zond leg). This is the mode's known UX cost and the reason solver mode exists.
- Portable acceptance flow: a taker signs a FillIntentV1 against the exact OrderV1 digest. Every mirror and maker selects deterministically by signed issuance time and semantic intent digest, independent of arrival order. The maker persists its secret and exact terminal proof before publish, then durably records an authenticated FillV1 acknowledgment before its first lock. The taker funds only after independently verifying FillV1, its response deadline, and the initiator escrow at the configured confirmation depth.
- Portable release: the taker commits a random release secret in FillIntentV1. Revealing it marks the intent or selected fill released and tells the maker to stop. The reference LP persists an authenticated release observation as sticky. It never starts or repeats a lock afterward. If a prior lock attempt may have landed, the LP retains recovery state and continues chain-authorized claim or refund handling. The consumed OrderV1 remains terminal; continued quoting requires a fresh signed order. Legacy origin-local rows retain bearer-token release and take-by-terms only for compatibility.
- Maker presence: makers heartbeat their listings (maker-token authed, in-memory only). Orders whose maker has not been seen within the presence TTL (90s) are dimmed in the UI and skipped by take-by-terms matching, so takers stop reserving orders whose maker cannot respond; they remain takeable by explicit id. The browser maker beats while its order card is open; the market maker beats every tick.
- Live book: browsers aggregate bounded HTTP snapshots from at most 16 mirrors including the same-origin primary, and keep SSE only for that primary. Signed rows are verified locally and deduplicated by order id plus semantic digest; duplicate ids invalidate the source snapshot, and same-id digest conflicts are hidden with an id quarantine that persists across browser reloads. HTTP responses are capped at 4 MiB before parsing and snapshots at 200 rows, with one bad mirror isolated from the others. A failed source loses its stale snapshot and is polled with one in-flight request plus exponential retry from 10 seconds through 5 minutes while the primary stream continues. Per-source generations prevent a slow poll from overwriting a newer stream snapshot. A 1,024-entry, expiry-aware verification cache avoids repeating ML-DSA verification for identical signed envelopes. Signed rows select only currently available sources, so another verified source can take over without changing the proof. Unsigned rows are accepted only from the primary mirror. Every in-flight record persists its chosen `bookId`, so all later reads and mutations return to the same origin.
- Full wire-level reference for the order book service: [ORDERBOOK_API.md](ORDERBOOK_API.md). Guide for running the maker side (browser or headless): [LIQUIDITY_PROVIDERS.md](LIQUIDITY_PROVIDERS.md).

## 4. Solver mode (Phase 3)

A solver (market maker) provides the QRL-side inventory and quotes uniswap-style single-sided swaps.

- User locks WETH; solver observes, locks QRL with `recipient = user's Q address`; user's secret is revealed via a sponsored claim (section 5); solver collects the WETH. Reverse direction is symmetric.
- The solver runs in a **Phala TEE with remote attestation**. The attestation binds the running code to the published open-source solver build, so operating the service does not require trusting the operator's honesty for quoting/execution logic, and the operation survives a change of operator without a change of trust. Settlement is still HTLC-atomic; the TEE protects quote integrity and the solver's own keys, it never custodies user funds.
- Quote lifecycle: quote(pair, size) -> signed quote with expiry -> user locks within expiry -> solver responds or the quote lapses harmlessly.
- Fee model: spread on the quote. No protocol fee in v1.

## 5. Wallet integration and sponsored claims

- **QRL side**: `@qrlwallet/connect` 4.x. Pairing via `qrlconnect://` QR/deep link, ML-KEM-768 + AES-256-GCM session, transactions signed in MyQRLWallet (web, mobile, desktop). The dApp requests `lock`/`claim`/`refund` contract calls through the SDK; the connected account auto-fills recipient fields.
- **Ethereum side**: EIP-6963 discovery, standard injected wallets. The connect SDK already announces via EIP-6963 and coexists with other wallets in pickers.
- **Sponsored claims**: because `claim` is permissionless with a fixed recipient, a swapper receiving QRL does not need QRL gas. The claim can be submitted by the solver or a relayer once the secret is disclosed to it; funds can only go to the recipient fixed at lock time. Disclosure order is safe: by the time the user discloses the secret, the QRL leg is locked in their favor, and the WETH leg is what the solver is owed anyway. This replaces the "generated passkey wallet + faucet funding" approach from the community prototype with plain self-custody.

## 6. Frontend

React + Vite, mirroring QuantaPool frontend conventions (hardened TS, zero-warning lint, `crypto/` fence for secret generation via WebCrypto `getRandomValues`).

- **Swap card**: from/to amounts, quote display, recipient auto-fill from connected wallet.
- **Market panel**: last price, order book (protocol mode), depth visualization. Chart work follows the workspace dataviz procedure (palette validation etc.) when built.
- **Swap status tracker**: a swap in flight spans two chains and up to four transactions; the UI must persist swap state locally (secret NEVER leaves the client in protocol mode) and resume cleanly after refresh, including surfacing refund eligibility. Secret persistence until claim/refund resolution is safety-critical: losing the secret after the counterparty locked means waiting out the refund path.

## 7. Security considerations

- **Secret handling**: 32 bytes from WebCrypto CSPRNG, generated and held client-side (protocol mode) or user-side until claim (solver mode). Fenced crypto module, per workspace mandate.
- **Reorg safety**: respond/claim only after the counterparty lock is visible at confirmation depth on the observed leg; timelock margins sized accordingly (section 2). Implemented client-side: the frontend re-reads the swap struct at `head - N` and gates the taker's lock and the maker's secret reveal on that snapshot, fail-closed when the historical read fails. The current testnet configuration deliberately uses `N=0` for speed and therefore accepts a depth-1 reorg risk. A real-value deployment must use the `finalized` tag or a separately reviewed nonzero finality policy.
- **Hashlock reuse**: enforced fresh per contract (section 2); clients also never reuse secrets across chains or swaps.
- **Griefing**: lock dust limits (minimum amounts) to prevent order-book spam with unclaimable dust swaps.
- **ERC-20 approvals**: exact-amount approvals per swap in the UI, no unlimited allowances. Stale nonzero allowances are reset to zero before re-approving (required by USDT's approval race guard, harmless elsewhere).
- **Order-book term binding**: the row a taker approves, the accept response, the maker's locally authored handle, every retry, and the locking announcement are bound across direction, asset, amounts, parties, and prelock H/T1 semantics. Persisted order-book swaps carry a binding version; older unmarked state is recovery-only and cannot create a new lock or reveal a new secret.
- **Portable order single use**: OrderV1, FillIntentV1, FillV1, and CancelV1 bind both accounts, deployment, nonces, deadlines, and scheme-independent semantic digests. Order ids bind the maker QRL account and nonce under the `QuantaSwap OrderV1 id` SHA-256 domain. OrderV1 additionally binds domain-separated maker and share capability commitments. A maker's FillV1 or CancelV1 is terminal. A terminal proof may use either supported wallet scheme as long as it derives the same maker QRL account. Contradictory signed children quarantine the order. ReleaseV1 reveals only a committed cancellation capability and cannot authorize funds or reopen a listing.
- **Loss-safe signed create**: browser and headless makers persist the complete create envelope, including raw capability preimages, before transport. An exact retry returns the same authenticated order and echoes only the preimages submitted again by that client. The mirror stores commitments rather than signed-create preimages. A lost local stage is unrecoverable. Earlier pre-capability signed artifacts are rejected at startup because this is a predeployment schema; legacy unsigned rows remain origin-local compatibility data.
- **Federation boundary**: mirrors are untrusted relays. They verify every event, require exact transport envelopes and canonical content hashes, reject cross-page duplicate ids and cursor discontinuities, and retain signed tombstones. Feed history, event size, pages, reset snapshots, response bytes, configured peers, rejected records, deferred dependencies, retained orders, intents, and conflict proofs are bounded. The dependency queue has both global and per-peer quotas; only an offending peer's source claims and cursor are reset. A peer reaching eight rejected records in one sync is degraded and backed off. Peer failures and repeated reset churn back off independently. Private capabilities and unsigned liquidity stay origin-local. Partitioned maker equivocation remains possible and is handled as detectable evidence without arrival-order resolution.
- **Federation availability limit**: federation provides replicated discovery rather than consensus or global finality. A configured peer can omit valid events, delay them, exhaust bounded relay capacity, or remain partitioned. Clients aggregate independent mirrors, persist signed evidence, quarantine observed conflicts, and use on-chain HTLC state for every fund decision. A current reset snapshot repairs recoverable feed gaps after restart; artifacts outside retention horizons require another mirror or an out-of-band copy.
- **Permissionless admission limit**: signatures authenticate protocol artifacts but do not make order creation Sybil-resistant. Multiple maker keys and source addresses can occupy the bounded public listing capacity until expiry, and legacy unsigned listings retain their existing wider abuse surface. The current quotas contain memory and reset size for testnet operation. A real-value permissionless deployment still needs a separately reviewed economic, stake, proof-of-work, or allowlisted admission policy.
- **Reference LP response authentication**: the headless maker accepts create, fill, cancel, and later order views only when the response reproduces its exact signed OrderV1 and terminal artifacts, semantic digests, terms, and expected state without conflict evidence. A malformed or contradictory 2xx response leaves recovery state intact and blocks funding. A first lock requires a persisted authenticated FillV1 acknowledgment. Authenticated release observation is sticky. During a book outage, chain actions continue only after that acknowledgment, a prior lock attempt, or observed HTLC exposure. A prior lock attempt is never automatically abandoned while inclusion remains ambiguous.
- **Claim preflight and RPC trust**: every secret-bearing claim is simulated from the actual sender at `latest` immediately before submission. Errors are sanitized so calldata is not reflected into logs. The same configured RPC sees the preimage during simulation and broadcast, so that endpoint is inside the secret-release trust boundary; a malicious provider can withhold or leak it. Issuer or recipient state can also change after simulation. These residuals require trusted, redundant or private broadcast infrastructure before a real-value deployment.
- **Stablecoin issuer risk**: blocklist/freeze scenarios and the USDT fee switch are analyzed in section 2 ("Ethereum-leg asset set"). Exact claim preflight reduces current-state failures but cannot remove centralized issuer control or the simulation-to-mining race.
- **Market-maker recovery identity**: every managed order and state envelope is bound to canonical ETH/QRL chain IDs and HTLC addresses through a SHA-256 deployment fingerprint. Runtime RPC chain IDs are checked before book or transaction work. A nonempty legacy or mismatched state file is preserved byte-for-byte and startup is refused for manual recovery under its original deployment.
- **Solver key management**: solver's chain keys live inside the TEE; attestation covers the code that uses them.
- **No admin keys in the HTLC contracts**: no pause, no upgrade, no owner. What is deployed is final; fixes ship as new deployments.

## 8. Deployment

- **Domain**: quantaswap.io, Cloudflare zone active (DigitalGuards account). Origin CA cert pattern per workspace CLAUDE.md 7b when a host is chosen; likely co-located with QuantaPool on the consolidated box.
- **Testnets**: Sepolia (11155111) + QRL v2 testnet (1337). QRL RPC: `https://qrlwallet.com/api/qrl-rpc/testnet` proxy. `qrl_*` namespace, Q-prefix addresses.
- **Toolchain**: native `hypc` binary (build instructions in QuantaPool's CLAUDE.md) via `npm run compile`; anvil-based integration tests via `npm test`; deploys via `npm run deploy:qrl` / `npm run deploy:eth`; live smokes via `scripts/smoke-{qrl,eth}.js`.

## 9. Open questions

1. Adopt/cross-audit charlie's contracts when published, or clean-room? (Decide when the code drops.)
2. ~~Ethereum-side asset set: WETH only at launch, or ETH + USDC?~~ Resolved 2026-07: WETH + USDC + USDT from launch, registry-driven (`config/tokens.json`, section 2). Raw ETH stays out: one code path (`lockToken`) for every Ethereum-leg asset, and wrapping is a solved UX problem.
3. ~~Order book transport for protocol mode~~ Resolved July 2026: dedicated lightweight service (`server/`, plain node:http, JSON-file persistence, same-origin `/api` proxy). On-chain orders remain a possible zero-infra upgrade later.
4. Phala deployment specifics: contract vs Phat Contract vs dstack-style CVM; attestation verification surface in the frontend.
5. Solver inventory sourcing and rebalancing across chains.
6. QRL v2 mainnet timing (external; gates Phase 4).
