# CLAUDE.md - QuantaSwap

Operating rules for Claude sessions in `/home/waterfall/myqrlwallet/QuantaSwap`. The workspace-wide rules at `/home/waterfall/myqrlwallet/CLAUDE.md` still apply; this file adds QuantaSwap-specific context.

## What this repo is

Cross-chain HTLC atomic swaps between Ethereum (WETH) and QRL v2 (native QRL). Two modes: protocol mode (pure HTLC + order book, zero operators) and solver mode (Phala TEE-attested solver, uniswap-style single-sided UX). Read `docs/ARCHITECTURE.md` before touching anything; it is the build spec.

Domain quantaswap.io (Cloudflare zone active, nothing deployed yet). Will be public OSS under DigitalGuards, GPL-3.0. No GitHub remote yet.

## Chain facts

- QRL v2 testnet: chain ID `1337`, `qrl_*` RPC namespace, Q-prefix addresses. Proxy `https://qrlwallet.com/api/qrl-rpc/testnet`, direct node `http://78.47.166.153:8545`.
- Ethereum testnet: Sepolia (`11155111`).
- Production is gated on QRL v2 mainnet (does not exist yet).

## Conventions (mirror QuantaPool)

- Solidity sources in `contracts/solidity/` are canon; `contracts/hyperion/*.hyp` are line-mirrors compiled with `hypc` (build instructions in QuantaPool's CLAUDE.md).
- Foundry (`forge test`) is the canonical test harness.
- Frontend: React + Vite, hardened TS, zero-warning lint, secret generation fenced in a `crypto/` module (WebCrypto only).
- Integration branch: `dev`. PRs for code; docs-only changes commit straight to `dev`.

## Invariants (treat regressions as high priority)

- HTLC contracts have no owner, no pause, no upgrade path.
- `claim()` is permissionless with recipient fixed at lock time (sponsored claims depend on this).
- Timelock asymmetry: initiator leg timeout >= 2x responder leg timeout.
- sha256 hashlocks, 32-byte CSPRNG secrets, contract-enforced hashlock freshness.
- The swap secret never leaves the client in protocol mode.
