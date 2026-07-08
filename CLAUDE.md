# CLAUDE.md - QuantaSwap

Operating rules for Claude sessions in `/home/waterfall/myqrlwallet/QuantaSwap`. The workspace-wide rules at `/home/waterfall/myqrlwallet/CLAUDE.md` still apply; this file adds QuantaSwap-specific context.

## What this repo is

Cross-chain HTLC atomic swaps between Ethereum (WETH) and QRL v2 (native QRL). Two modes: protocol mode (pure HTLC + order book, zero operators) and solver mode (Phala TEE-attested solver, uniswap-style single-sided UX). Read `docs/ARCHITECTURE.md` before touching anything; it is the build spec.

Domain quantaswap.io (Cloudflare zone active, nothing deployed yet). Will be public OSS under DigitalGuards, GPL-3.0. No GitHub remote yet.

## Chain facts

- QRL v2 testnet: chain ID `1337`, `qrl_*` RPC namespace, Q-prefix addresses. Proxy `https://qrlwallet.com/api/qrl-rpc/testnet`, direct node `http://78.47.166.153:8545`.
- Ethereum testnet: Sepolia (`11155111`).
- QRL v2 testnet fully supports contracts (staking is the only gap, irrelevant here); real-value production waits on QRL v2 mainnet.

## Conventions

- Contracts are **Hyperion-only** (user mandate, 2026-07-08): `contracts/hyperion/*.hyp` compiled with the native `hypc` (build instructions in QuantaPool's CLAUDE.md). NO Solidity mirrors, NO Foundry; the same artifact deploys to both chains (both are EVM-compatible, byte-identical bytecode).
- Canonical test gate: `npm test` (compiles with hypc, runs the artifact on a throwaway anvil). `npm run compile` writes `build/hyperion/*.json` (gitignored).
- Live testnet addresses + smoke commands: `docs/DEPLOYMENTS.md`.
- Deploy/live-smoke env in gitignored `.env` (`.env.example` documents the shape). The QRL hexseed and Sepolia key never enter tracked files.
- Frontend: React + Vite, hardened TS, zero-warning lint, secret generation fenced in a `crypto/` module (WebCrypto only).
- Integration branch: `dev`. PRs for code; docs-only changes commit straight to `dev`.

## Invariants (treat regressions as high priority)

- HTLC contracts have no owner, no pause, no upgrade path.
- `claim()` is permissionless with recipient fixed at lock time (sponsored claims depend on this).
- Timelock asymmetry: initiator leg timeout >= 2x responder leg timeout.
- sha256 hashlocks, 32-byte CSPRNG secrets, contract-enforced hashlock freshness.
- The swap secret never leaves the client in protocol mode.
