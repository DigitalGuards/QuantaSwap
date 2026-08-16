# QuantaSwap

Trust-minimized cross-chain swaps between Ethereum and QRL. Domain:
[quantaswap.io](https://quantaswap.io). Isolated development build:
[dev.quantaswap.io](https://dev.quantaswap.io) (testnet, no market maker,
`noindex`).

Part of the MyQRLWallet ecosystem (MyQRLWallet, QuantaPool, zondscan, QNS). Open source under GPL-3.0.

## Why

QRL needs exchange options that do not depend on centralized listings. There is standing OTC demand today, and listing status is outside the community's control. QuantaSwap is a standing, self-custodial venue to swap WETH or major stablecoins (USDC, USDT) against QRL directly: no custodian, no wrapped-asset bridge, no operator that can steal funds.

## How it works

Every swap settles through Hashed Timelock Contracts (HTLCs) deployed on both chains. No party ever holds both legs at once: a swap either completes atomically (the same secret unlocks both sides) or both sides refund after their timeouts.

```
Alice (has WETH, wants QRL)                Bob (has QRL, wants WETH)

1. Alice picks secret s, computes h = sha256(s)
2. Alice locks WETH on Ethereum   -> HTLC(h, recipient: Bob,   timeout: T1)
3. Bob   locks QRL  on QRL v2     -> HTLC(h, recipient: Alice, timeout: T2), T2 < T1
4. Alice claims QRL on QRL v2 by revealing s (s becomes public on-chain)
5. Bob   claims WETH on Ethereum using s, before T1
   (if anything stalls: Bob refunds after T2, Alice refunds after T1)
```

Two modes share the same on-chain core:

| Mode | UX | Trust assumptions | Order |
|---|---|---|---|
| Protocol mode | Order book; both parties sign on both chains | Contracts only, zero operators, zero maintenance | Built first |
| Solver mode | Uniswap-style single-sided swap against solver liquidity | TEE-attested solver (Phala) as counterparty; settlement still HTLC-atomic | Built second |

The WETH in the diagram stands for any supported Ethereum-leg asset: the same `lockToken` path carries WETH, USDC and USDT (asset registry: [`config/tokens.json`](config/tokens.json), including USDT's non-standard ERC-20 behavior and issuer blocklist analysis).

Details, timelock math, and threat analysis: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Order book wire reference: [docs/ORDERBOOK_API.md](docs/ORDERBOOK_API.md). Running the maker side yourself: [docs/LIQUIDITY_PROVIDERS.md](docs/LIQUIDITY_PROVIDERS.md).

Protocol-mode discovery is portable and mirrorable. Makers sign complete
OrderV1 terms with ML-DSA-87, takers sign short-lived FillIntentV1 proposals,
and each order terminates in one maker-signed FillV1 or CancelV1. Browsers
verify and aggregate configured mirrors locally. Private and unsigned legacy
orders remain on their origin, and every funding decision still depends on
verified HTLC state rather than an orderbook response.

Portable order ids bind the maker QRL account and nonce under a fixed SHA-256
domain, so independent mirrors converge on the same identity without allowing
another signer to claim a copied nonce. Federation is replicated discovery,
not consensus: observed equivocation is quarantined, and HTLC state remains the
authority for funds.

Signed makers generate per-order capabilities before wallet authorization and
commit their domain-separated SHA-256 digests inside OrderV1. The browser and
headless LP stage the exact signed create envelope before its first POST, so an
uncertain result can be retried without changing the order or losing access.
Raw capabilities stay on the origin path and never enter federation events.

## Wallet integration

- **QRL side**: MyQRLWallet via [`@qrlwallet/connect`](https://github.com/DigitalGuards/myqrlwallet-connect), the MyQRLWallet extension, or the official QRL Web3 Wallet. Interactive makers sign the complete OrderV1 terms with ML-DSA-87 (`qrl_signTypedData` for MyQRLWallet, `qrl_signTypedData_v4` for the official wallet). Users keep their own keys; the connected account auto-fills the recipient address.
- **Ethereum side**: any EIP-6963 injected wallet (MetaMask, Rabby, etc.).
- **No generated custodial wallets.** HTLC claims are permissionless with a fixed recipient, so the QRL leg can be claim-sponsored: a WETH-to-QRL swapper does not need a funded QRL gas wallet.

## Repo layout

```
contracts/
  hyperion/    HTLC source (.hyp, compiled with hypc, deployed to BOTH chains)
  test/        Test-only mock tokens (never deployed)
  testnet/     tUSDT faucet token (Sepolia stand-in for USDT)
config/        tokens.json: Ethereum-leg asset registry (WETH, USDC, USDT)
scripts/       compile, anvil test suite, deploy + live smoke tooling
frontend/      React + Vite swap UI (order book market + both-sides sandbox)
server/        Self-hostable federated signed mirror (coordination only)
marketmaker/   Reproducible self-hosted protocol-mode LP kit
solver/        Solver service for solver mode (Phala TEE target), planned
docs/          Architecture, deployments, order book API, LP guide
```

Contracts are Hyperion-only; [QuantaPool](https://github.com/DigitalGuards/QuantaPool) is the reference for live Hyperion contracts on this stack. Both legs run byte-identical hypc bytecode (both chains are EVM-compatible), and the compiled artifact itself is exercised on a throwaway anvil as the canonical test gate (`npm test`). Frontend gates will mirror QuantaPool: `lint` (zero warnings) + `build`.

## Status

Phase 1 complete (July 2026): the HTLC is deployed and live smoke-tested on both testnets, Sepolia + QRL v2 testnet (chain ID 1337). Addresses: [docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md). Real-value launch waits on QRL v2 mainnet.

| Phase | Scope | Status |
|---|---|---|
| 0 | Repo bootstrap, architecture | done |
| 1 | HTLC on both chains, local test gate, testnet deploys + smokes | done |
| 2 | Protocol UI, signed mirror federation, and self-hosted LP kit | implemented; testnet rollout and independent operator network pending |
| 3 | Solver service + Phala TEE attestation, single-sided UX | planned |
| 4 | Audit pass, mainnet readiness (waits on QRL v2 mainnet) | planned |

## Provenance

The concept follows community work by charlie (QRL Discord, July 2026), who demonstrated a passkey-based WETH/QRL HTLC swap on testnet ("quantumSwap") and intends to open-source it. QuantaSwap adapts the idea to the MyQRLWallet ecosystem: self-custodial wallets through `@qrlwallet/connect` instead of generated passkey wallets, and sponsored claims instead of requiring funded wallets on both chains. If and when charlie's contracts are published, they will be evaluated for adoption or cross-audit.

## License

GPL-3.0. See [LICENSE](LICENSE).
