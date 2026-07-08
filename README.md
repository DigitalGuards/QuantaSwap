# QuantaSwap

Trust-minimized cross-chain swaps between Ethereum and QRL. Domain: [quantaswap.io](https://quantaswap.io).

Part of the MyQRLWallet ecosystem (MyQRLWallet, QuantaPool, zondscan, QNS). Open source under GPL-3.0.

## Why

QRL needs exchange options that do not depend on centralized listings. There is standing OTC demand today, and listing status is outside the community's control. QuantaSwap is a standing, self-custodial venue to swap WETH and QRL directly: no custodian, no wrapped-asset bridge, no operator that can steal funds.

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

Details, timelock math, and threat analysis: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Wallet integration

- **QRL side**: MyQRLWallet via [`@qrlwallet/connect`](https://github.com/DigitalGuards/myqrlwallet-connect) (post-quantum relay protocol, ML-DSA-87 transaction signing). Users keep their own keys; the connected account auto-fills the recipient address.
- **Ethereum side**: any EIP-6963 injected wallet (MetaMask, Rabby, etc.).
- **No generated custodial wallets.** HTLC claims are permissionless with a fixed recipient, so the QRL leg can be claim-sponsored: a WETH-to-QRL swapper does not need a funded QRL gas wallet.

## Repo layout (planned)

```
contracts/
  solidity/    Canonical Solidity sources + Foundry tests (Ethereum leg)
  hyperion/    .hyp mirrors compiled with hypc (QRL v2 leg)
frontend/      React + Vite swap UI (swap card, order book, market panel)
solver/        Solver service for solver mode (Phala TEE target)
docs/          Architecture, deployment, threat notes
```

Conventions mirror [QuantaPool](https://github.com/DigitalGuards/QuantaPool): Foundry is the canonical test harness, Hyperion sources are line-mirrors of the Solidity, frontend gates are `lint` (zero warnings) + `build`.

## Status

Design phase (July 2026). Testnet-first: Sepolia + QRL v2 testnet (chain ID 1337). Production launch is gated on QRL v2 mainnet.

| Phase | Scope |
|---|---|
| 0 | Repo bootstrap, architecture (this) |
| 1 | HTLC contracts on both chains, Foundry suite, testnet deploys |
| 2 | Frontend MVP: protocol mode, connect SDK + EIP-6963 integration |
| 3 | Solver service + Phala TEE attestation, single-sided UX |
| 4 | Audit pass, mainnet readiness (blocked on QRL v2 mainnet) |

## Provenance

The concept follows community work by charlie (QRL Discord, July 2026), who demonstrated a passkey-based WETH/QRL HTLC swap on testnet ("quantumSwap") and intends to open-source it. QuantaSwap adapts the idea to the MyQRLWallet ecosystem: self-custodial wallets through `@qrlwallet/connect` instead of generated passkey wallets, and sponsored claims instead of requiring funded wallets on both chains. If and when charlie's contracts are published, they will be evaluated for adoption or cross-audit.

## License

GPL-3.0. See [LICENSE](LICENSE).
