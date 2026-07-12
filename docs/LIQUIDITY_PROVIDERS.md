# Providing liquidity on QuantaSwap

Anyone can be a liquidity provider (maker) in protocol mode. There is no
registration, no permission, no operator to ask: you post orders to the
coordination-only order book and settle every fill through the on-chain HTLCs,
which have no owner, no pause and no upgrade path. This guide covers both ways
to do it and the rules that keep you safe.

Wire-level details for every endpoint mentioned here:
[ORDERBOOK_API.md](ORDERBOOK_API.md). Protocol background:
[ARCHITECTURE.md](ARCHITECTURE.md).

## Two ways to make markets

### 1. Browser (casual / one-off liquidity)

The frontend at [quantaswap.io](https://quantaswap.io) has the full maker flow
built in: post an order from the *Post order* card with your connected
Ethereum (EIP-6963) and QRL (MyQRLWallet connect) accounts, and your listing
card walks you through the swap when a taker arrives (lock, hashlock
announcement, claim or refund) with secrets generated and held in the browser.

The catch: **maker presence is tied to the open tab.** Your client heartbeats
the listing while its card is open; close the tab and after 90 seconds the
order is dimmed in the book and skipped by take-by-terms matching (it stays
takeable by explicit id). Fine for occasional liquidity; not for an
always-on book.

### 2. Headless (always-online liquidity)

Run a client against the order book API. You have two starting points:

- **Run or adapt `marketmaker/`**: the reference implementation used to stock
  the public book. Hardened TypeScript, deps only `ethers` + `@theqrl/web3`.
  It runs the whole maker lifecycle unattended: announce, lock, depth-verified
  claim, refund, repost, plus a price ladder tracking a CoinGecko cross rate,
  inventory reserves and reprice-on-drift. Every irreversible action flows
  through the pure decision core in `marketmaker/src/policy.ts` (tested by
  `npm test`). Configuration is documented in `marketmaker/.env.example`; the
  two signing keys live only in your untracked `.env`.
- **Write your own**: the API is small and unauthenticated beyond per-order
  bearer tokens. `marketmaker/src/orderbook.ts` and
  `frontend/src/lib/orderbook.ts` are compact client references.

## The maker lifecycle

The maker is always the **initiator**: after a taker reserves your order, you
generate the secret, lock first, and your claim of the taker's leg is what
reveals the secret that lets the taker claim yours.

1. **Post**: `POST /orders` with direction, asset, both amounts (base units)
   and your two addresses. Store the returned `makerToken`; it is shown once.
2. **Heartbeat**: `POST /orders/:id/heartbeat` at least every 90 s per open
   listing (the reference maker beats every tick). Offline listings are
   skipped by take-by-terms matching.
3. **Watch for a take**: poll `GET /orders/:id` or subscribe to
   `GET /orders/stream`. A take moves the order to `accepted` and fills in the
   taker's addresses.
4. **Lock first**: generate a fresh 32-byte CSPRNG secret, compute
   `hashlock = sha256(secret)`, and lock your leg on-chain with the taker as
   recipient and the initiator timeout. The contract enforces hashlock
   freshness, so never reuse a secret across swaps or chains.
5. **Announce**: `POST /orders/:id/hashlock` with the hashlock and both
   unix-second timeouts. The book enforces (and the contracts embody) the
   timelock asymmetry: your initiator window must be at least **2×** the
   responder window, so the taker can never claim your leg while you can no
   longer claim theirs.
6. **Verify the taker's lock, then claim**: wait for the taker's HTLC lock,
   re-read it on-chain **at your confirmation depth** (the reference maker
   re-reads at `head - N`), and verify recipient, amount, token address and
   timeout against your own registry, never against book data. Only then
   claim the taker's leg, which publishes the secret.
7. **Or refund**: if the taker never locks (or locks wrong), do nothing until
   your initiator timeout passes, then refund. Walk-away is always safe;
   abandonment costs only time.
8. **Repost**: a filled or cancelled listing is gone; post a new order to
   stay in the book. `POST /orders/:id/cancel` pulls a live listing (funds
   already locked stay governed on-chain).

A taker can also walk away: pre-lock their release relists your order
untouched; post-lock the order shows `released: true`, meaning commit no
further funds and take the refund path if you already locked.

## Safety rules (non-negotiable)

These mirror the repo's core invariants; a maker that skips them is the one at
risk:

- **Never trust the book for fund movement.** It is coordination only. Verify
  every recipient, amount, token address and timeout on-chain before locking,
  claiming or revealing anything.
- **Secrets**: 32 bytes from a CSPRNG, fresh per swap, held only by you until
  your claim reveals them.
- **Hashlocks**: `sha256(secret)`, enforced fresh by the contracts.
- **Timelock asymmetry**: initiator window ≥ 2× responder window, always.
- **Reorg safety**: act on counterparty locks only at confirmation depth,
  fail-closed when the historical read fails.
- **Token resolution**: orders carry symbols, not addresses. Resolve symbols
  against your own registry (`config/tokens.json`) and verify the escrowed
  token on-chain.

## Operational notes

- **Rate limits** (per IP): 720 reads + 120 mutations per minute; heartbeats
  count as reads. Budget roughly two reads per open listing per tick when
  sizing a ladder. Full numbers in
  [ORDERBOOK_API.md](ORDERBOOK_API.md#rate-limits).
- **Gas on both chains**: protocol-mode makers need ETH for the Ethereum leg
  and QRL for the QRL leg (approve + lock + claim/refund). Keep reserves; the
  reference maker refuses to list below its configured floors.
- **Book capacity**: 200 open orders globally; listings expire after 48 h
  without updates, so long-lived makers repost rather than rely on stale rows.
- **Testnet only for now**: real-value production waits on QRL v2 mainnet.
  Current contract addresses and faucet notes: [DEPLOYMENTS.md](DEPLOYMENTS.md).
