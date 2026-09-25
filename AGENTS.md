# QuantaSwap Repository Guide

## Scope and layout

QuantaSwap is a public GPL-3.0 testnet project for atomic swaps between
Sepolia assets and native QRL v2 testnet QRL. The main cells are:

- `contracts/`: Hyperion HTLC sources and artifact tests.
- `frontend/`: React and TypeScript browser client.
- `server/`: coordination-only orderbook and mirror feed.
- `marketmaker/`: reproducible self-hosted LP kit.
- `docs/`: architecture, wire protocol, deployment, and operator guidance.

Read `CLAUDE.md` and `docs/ARCHITECTURE.md` before protocol changes. Treat
`docs/ORDERBOOK_API.md` as the wire reference.

## Core protocol rules

- HTLCs have no owner, pause, or upgrade path.
- Clients verify recipients, assets, amounts, hashlocks, timeouts, and finality
  on-chain before moving funds. An orderbook is never settlement authority.
- Hashlocks use SHA-256 over fresh 32-byte WebCrypto or Node CSPRNG secrets.
- The initiator timeout window is at least twice the responder window.
- New portable orders are single-use: OrderV1 produces one maker-signed FillV1
  or CancelV1. ReleaseV1 never reopens that OrderV1.
- FillIntentV1 is a short-lived taker proposal. The maker persists its secret,
  selected intent, and exact terminal proof before publishing or funding.
- Contradictory signed terms are equivocation evidence. Retain and quarantine
  them; do not resolve them by arrival order.
- Public signed events may federate. Private orders, bearer capabilities,
  unsigned compatibility rows, presence, and IP metadata remain origin-local.

## Commands

- Root contract gate: `npm test`.
- Frontend: `cd frontend && npm test && npm run build`.
- Server: `cd server && npm test`.
- Market maker: `cd marketmaker && npm test`.

Run the relevant full gate before committing. Cross-package wire changes must
also keep deterministic digest vectors aligned in browser, server, and LP kit.

## Code and writing conventions

Follow each package's strict TypeScript, ESLint, and formatting configuration.
Use WebCrypto only for browser secrets. Keep irreversible market-maker actions
behind the decision policy and persist recovery material before network sends.

Never write Unicode em dashes (U+2014) in code, comments, UI text,
documentation, commit messages, or pull request text. Use ordinary punctuation
or an ASCII hyphen. Scan the complete outgoing diff before finalizing.

## Git and public-repository safety

Integration targets `dev`; code changes use a pull request. Use Conventional
Commit prefixes and keep one behavior per commit. Do not commit generated build
output, secrets, wallet material, private endpoints, host addresses, access
tokens, local state, backup artifacts, or operational runbooks. Preserve
unrelated user changes and never rewrite shared history without explicit
authorization.
