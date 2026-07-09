# QuantaSwap Architecture

Status: design draft, July 2026. No code exists yet; this document is the build spec for Phases 1-3.

## 1. Goal and constraints

Swap WETH (Ethereum) and native QRL (QRL v2 / Zond, EVM-compatible) with atomic settlement and no custodian.

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

- `lock(...)` pulls funds in (ERC-20 `transferFrom`, or `msg.value` for native QRL) and stores the record under `swapId = sha256(hashlock, initiator, recipient, token, amount, timeout)`.
- `claim(swapId, secret)` verifies `sha256(secret) == hashlock`, pays `recipient`, stores the revealed secret in the record, emits it in the event. **Permissionless**: anyone may call it; the payout target is fixed at lock time. This is what enables sponsored claims (section 5).
- `refund(swapId)` after `timeout`, pays `initiator`.
- **Hashlock freshness**: the contract rejects a `lock` whose `hashlock` matches any prior swap on that contract. Reusing a secret whose preimage is already public would let anyone race the claim; clients must generate a fresh 32-byte CSPRNG secret per swap, and the contract enforces it defensively.

### Hash function

`sha256`, not `keccak256`. Both EVMs expose the sha256 precompile, cost is negligible, and sha256 keeps the door open to non-EVM counterparties (BTC-family HTLCs) later. 32-byte preimage gives 128-bit post-quantum preimage resistance.

### Timelock asymmetry

The initiator (first locker, secret holder) gets the **longer** timeout.

```
T2 (responder leg)  >= claim window + finality margin on both chains
T1 (initiator leg)  >= 2 * T2
```

Rationale: the secret is revealed on the responder's leg at claim time. The responder then needs the remaining `T1 - now` to claim the initiator's leg. If `T1` were short, a claim near `T2` would leave the responder unable to collect. Testnet defaults: T2 = 2h, T1 = 4h. Finality margin covers Ethereum's ~13 min (2-epoch) finality and the equivalent on QRL v2 (qrysm Gasper); deep-reorg risk on either chain is why margins are hours, not minutes.

### Known protocol weakness: the free option

Between locking and `T2`, the initiator holds a free option: if price moves against the swap, they can simply never reveal the secret, and both sides refund. The responder loses nothing but time-value of locked funds. Mitigations, in build order:

1. Short responder timelocks (bounds the option's duration).
2. Solver mode: quotes carry an expiry and the solver prices the option into the spread.
3. Optional later: initiator bond forfeited on abandonment.

## 3. Protocol mode (Phase 1-2)

Pure HTLC. Order discovery is an order book; matching produces the parameters both parties feed to their `lock` calls.

- v1 order book (implemented, `server/`) is a dedicated zero-dependency node service; it is **coordination only**, never custody. It carries order parameters, the taker's addresses and the maker's hashlock announcement; clients re-verify recipients, amounts and timeouts against on-chain HTLC state before committing funds or revealing the secret, so a malicious order book can waste time but cannot redirect a swap. Losing it degrades the protocol to out-of-band coordination, it does not strand funds.
- Both parties need gas on both chains (ETH for the Ethereum leg, QRL for the Zond leg). This is the mode's known UX cost and the reason solver mode exists.
- Acceptance flow: taker accepts a maker order, maker (initiator) locks first, taker responds after observing the initiator's lock with adequate confirmations.

## 4. Solver mode (Phase 3)

A solver (market maker) provides the QRL-side inventory and quotes uniswap-style single-sided swaps.

- User locks WETH; solver observes, locks QRL with `recipient = user's Q address`; user's secret is revealed via a sponsored claim (section 5); solver collects the WETH. Reverse direction is symmetric.
- The solver runs in a **Phala TEE with remote attestation**. The attestation binds the running code to the published open-source solver build, so operating the service does not require trusting the operator's honesty for quoting/execution logic, and the operation survives a change of operator without a change of trust. Settlement is still HTLC-atomic; the TEE protects quote integrity and the solver's own keys, it never custodies user funds.
- Quote lifecycle: quote(pair, size) -> signed quote with expiry -> user locks within expiry -> solver responds or the quote lapses harmlessly.
- Fee model: spread on the quote. No protocol fee in v1.

## 5. Wallet integration and sponsored claims

- **QRL side**: `@qrlwallet/connect` 3.x. Pairing via `qrlconnect://` QR/deep link, ML-KEM-768 + AES-256-GCM session, transactions signed in MyQRLWallet (web, mobile, desktop). The dApp requests `lock`/`claim`/`refund` contract calls through the SDK; the connected account auto-fills recipient fields.
- **Ethereum side**: EIP-6963 discovery, standard injected wallets. The connect SDK already announces via EIP-6963 and coexists with other wallets in pickers.
- **Sponsored claims**: because `claim` is permissionless with a fixed recipient, a swapper receiving QRL does not need QRL gas. The claim can be submitted by the solver or a relayer once the secret is disclosed to it; funds can only go to the recipient fixed at lock time. Disclosure order is safe: by the time the user discloses the secret, the QRL leg is locked in their favor, and the WETH leg is what the solver is owed anyway. This replaces the "generated passkey wallet + faucet funding" approach from the community prototype with plain self-custody.

## 6. Frontend

React + Vite, mirroring QuantaPool frontend conventions (hardened TS, zero-warning lint, `crypto/` fence for secret generation via WebCrypto `getRandomValues`).

- **Swap card**: from/to amounts, quote display, recipient auto-fill from connected wallet.
- **Market panel**: last price, order book (protocol mode), depth visualization. Chart work follows the workspace dataviz procedure (palette validation etc.) when built.
- **Swap status tracker**: a swap in flight spans two chains and up to four transactions; the UI must persist swap state locally (secret NEVER leaves the client in protocol mode) and resume cleanly after refresh, including surfacing refund eligibility. Secret persistence until claim/refund resolution is safety-critical: losing the secret after the counterparty locked means waiting out the refund path.

## 7. Security considerations

- **Secret handling**: 32 bytes from WebCrypto CSPRNG, generated and held client-side (protocol mode) or user-side until claim (solver mode). Fenced crypto module, per workspace mandate.
- **Reorg safety**: respond/claim only after finality-grade confirmations on the observed leg; timelock margins sized accordingly (section 2).
- **Hashlock reuse**: enforced fresh per contract (section 2); clients also never reuse secrets across chains or swaps.
- **Griefing**: lock dust limits (minimum amounts) to prevent order-book spam with unclaimable dust swaps.
- **WETH approvals**: exact-amount approvals per swap in the UI, no unlimited allowances.
- **Solver key management**: solver's chain keys live inside the TEE; attestation covers the code that uses them.
- **No admin keys in the HTLC contracts**: no pause, no upgrade, no owner. What is deployed is final; fixes ship as new deployments.

## 8. Deployment

- **Domain**: quantaswap.io, Cloudflare zone active (DigitalGuards account). Origin CA cert pattern per workspace CLAUDE.md 7b when a host is chosen; likely co-located with QuantaPool on the consolidated box.
- **Testnets**: Sepolia (11155111) + QRL v2 testnet (1337). QRL RPC: `https://qrlwallet.com/api/qrl-rpc/testnet` proxy, direct node `http://78.47.166.153:8545` as fallback. `qrl_*` namespace, Q-prefix addresses.
- **Toolchain**: native `hypc` binary (build instructions in QuantaPool's CLAUDE.md) via `npm run compile`; anvil-based integration tests via `npm test`; deploys via `npm run deploy:qrl` / `npm run deploy:eth`; live smokes via `scripts/smoke-{qrl,eth}.js`.

## 9. Open questions

1. Adopt/cross-audit charlie's contracts when published, or clean-room? (Decide when the code drops.)
2. Ethereum-side asset set: WETH only at launch, or ETH + USDC?
3. ~~Order book transport for protocol mode~~ Resolved July 2026: dedicated lightweight service (`server/`, plain node:http, JSON-file persistence, same-origin `/api` proxy). On-chain orders remain a possible zero-infra upgrade later.
4. Phala deployment specifics: contract vs Phat Contract vs dstack-style CVM; attestation verification surface in the frontend.
5. Solver inventory sourcing and rebalancing across chains.
6. QRL v2 mainnet timing (external; gates Phase 4).
