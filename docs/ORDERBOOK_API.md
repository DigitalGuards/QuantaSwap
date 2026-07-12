# Order Book API

Wire-level reference for the QuantaSwap order book service (`server/`). This is
the coordination layer for protocol-mode swaps: makers list orders, takers
reserve them, and the maker announces the hashlock that both sides feed into
their on-chain HTLC `lock` calls. Reference clients:
`frontend/src/lib/orderbook.ts` (browser) and `marketmaker/src/orderbook.ts`
(headless). How to run the maker side end-to-end:
[LIQUIDITY_PROVIDERS.md](LIQUIDITY_PROVIDERS.md).

## Trust model (read this first)

**The order book is coordination only, never custody.** Nothing it returns is
trusted for fund movement. It carries order parameters, the taker's addresses
and the maker's hashlock announcement; both clients re-verify recipients,
amounts, token addresses and timeouts against on-chain HTLC state before
committing funds or revealing a secret. A malicious or corrupted order book can
waste your time; it cannot redirect a swap. Losing it strands no funds.
(Details: [ARCHITECTURE.md](ARCHITECTURE.md), section 3.)

Consequences for integrators:

- Orders carry asset **symbols**, never token addresses. Resolve the symbol
  against your own compiled-in registry (`config/tokens.json`) and verify the
  escrowed token address on-chain before acting.
- Never move funds on the basis of a book read alone. Verify the counterparty's
  lock on-chain, at your confirmation depth, before responding or claiming.

## Transport

- Base URL: `https://quantaswap.io/api` (same-origin `/api` proxy in front of
  the service).
- JSON over HTTP. Request bodies must be JSON objects; anything else is a
  `400 body must be a JSON object`. Bodies are capped at **4096 bytes**
  (`413 body too large`).
- Every error response is `{ "error": "<message>" }` with an appropriate HTTP
  status. Success shapes are given per endpoint below.
- Responses are `Cache-Control: no-store`.

## Authentication: per-order bearer tokens

There is no registration, no accounts, no API keys. Authorization is by
per-order capability tokens (64 hex chars, 32 CSPRNG bytes):

- **Maker token**: returned once by `POST /orders`. Authorizes `heartbeat`,
  `hashlock` and `cancel` on that order.
- **Taker token**: returned once by `POST /orders/:id/accept` or
  `POST /orders/take`. Authorizes `release` on that order.
- **Share token** (private orders only): returned once by `POST /orders` when
  `visibility` is `private`. It is the capability that reads
  (`GET /orders/:id`, `X-Share-Token` header) and accepts
  (`POST /orders/:id/accept`, `shareToken` body field) the order; the maker
  hands it to the intended counterparty, typically inside a share link's URL
  fragment so it never touches server logs.

The server stores only the sha256 of each token; if you lose a token it cannot
be recovered. Treat tokens as secrets for the lifetime of the order (leaking a
maker token lets someone cancel your listing or announce a bogus hashlock;
never funds, per the trust model, but it can grief the swap).

## The order object

All read and mutation endpoints return orders in this public shape (token
hashes and taker-IP bookkeeping are never serialized):

```jsonc
{
  "id": "a1b2c3d4e5f60718",        // 16 lowercase hex chars
  "direction": "eth->qrl",          // or "qrl->eth"; the maker escrows the from side
  "asset": "ETH",                   // ETH-leg asset symbol: ETH | USDC | tUSDT.
                                    // Absent means ETH (rows predating stable pairs).
  "fromAmount": "20000000000000000",// base units of the maker leg, decimal string
  "toAmount": "2000000000000000000",// base units of the taker leg, decimal string
  "makerEthAccount": "0x…",         // 0x + 40 hex
  "makerQrlAccount": "Q…",          // Q + 40 hex
  "status": "open",                 // open | accepted | locking | cancelled
  "takerEthAccount": null,          // set once accepted
  "takerQrlAccount": null,
  "hashlock": null,                 // set by the maker's hashlock announcement
  "initiatorTimeout": null,         // unix seconds, set with the hashlock
  "responderTimeout": null,
  "released": false,                // taker walked away after the maker locked
  "makerSeen": true,                // maker heartbeated within the presence TTL (90s)
  "visibility": "public",           // public | private (see Private orders)
  "allowedTakerEth": "0x…",         // present only on restricted private orders
  "allowedTakerQrl": "Q…",          // present only on restricted private orders
  "createdAt": 1752300000,          // unix seconds
  "updatedAt": 1752300000
}
```

- `direction` is from the maker's perspective: `eth->qrl` means the maker
  escrows the ETH-leg asset (`fromAmount` in that asset's base units) and wants
  QRL (`toAmount` in QRL wei); `qrl->eth` is the mirror.
- The QRL leg is always native QRL, 18 decimals.

### Amount bounds

Amounts are decimal base-unit strings (1-30 digits, no sign, no decimals).
Per-asset bounds (server: `server/src/assets.ts`, mirrored in
`frontend/src/config.ts`):

| Asset | Decimals | Min | Max |
|---|---|---|---|
| QRL (native) | 18 | 0.001 QRL (`10^15` wei) | `10^24` wei |
| ETH | 18 | 0.001 ETH (`10^15` wei) | `10^24` wei |
| USDC | 6 | 1 USDC (`10^6`) | `10^13` |
| tUSDT | 6 | 1 tUSDT (`10^6`) | `10^13` |

Out-of-bounds or malformed amounts are `400` with a field-specific message.

### Order lifecycle

```
open ──accept/take──> accepted ──hashlock (maker locked first)──> locking
 │  ^                    │                                          │
 │  └──taker release─────┘ (pre-lock walk-away: order relists)      │
 └─cancel/expiry─> cancelled <──cancel (listing only; funds stay   │
                                        governed on-chain) ────────┘
```

Server-side expiry (sweep) keeps the book readable; chain state remains the
source of truth for funds:

- `open` orders auto-cancel after **48 h** without updates.
- `accepted` orders that never reach a hashlock auto-cancel after **1 h**.
- `cancelled` records are purged after **1 h**.
- `locking` records are purged **24 h after the initiator timeout** (they
  linger for audit; the book never learns the on-chain outcome).

The book holds at most **200 open orders**; `POST /orders` returns
`503 order book is full` beyond that.

### Maker presence

Makers heartbeat their open listings. An order whose maker has not been seen
within the **90 s** presence TTL has `makerSeen: false`: the UI dims it and
take-by-terms matching skips it (it stays takeable by explicit id). Presence is
in-memory only; after a server restart every loaded open order gets one TTL
window of grace to re-heartbeat.

### Private orders

For OTC trades where the two parties already found each other and only need
trustless execution. A private order (`"visibility": "private"` on create):

- never appears in `GET /orders` or the SSE stream, and take-by-terms never
  matches it, even at exact terms;
- is readable and acceptable only with its share token. Without a valid token,
  reads and accepts answer the same `404` as a nonexistent id, so an id alone
  (which transits URLs and access logs) confirms nothing;
- may carry `allowedTakerEth`/`allowedTakerQrl`: then accept additionally
  rejects any other taker addresses with `403`, so even a leaked link cannot
  be sniped. The restriction is a convenience filter; the maker's client
  re-verifies the taker before locking, and the HTLC fixes the recipient at
  lock time (the trust model is unchanged).

Everything after accept (hashlock announce, locking, release, cancel, TTLs) is
identical to a public order.

## Rate limits

Per-IP, fixed one-minute windows, split by class so a burst of one cannot
starve the other (`429 rate limited, slow down`):

| Class | Limit | Notes |
|---|---|---|
| Reads (`GET`) | 1440/min | heartbeats count as reads despite being `POST` |
| Mutations (other `POST`) | 120/min | |

Take caps, per IP (fairness for shared demo liquidity, not sybil resistance):

- **4 concurrent takes**: a take occupies a slot through the `accepted` phase
  and the `locking` phase up to the initiator timeout; releasing frees it
  (`429 you already have swaps in progress; finish or let them expire`).
- **24 takes per rolling 24 h**
  (`429 daily take limit reached; leave some liquidity for others`).

SSE stream: at most **200 concurrent connections** overall and **4 per IP**;
beyond that the endpoint answers `503` and you should fall back to polling.

## Endpoints

### `GET /health`

Liveness probe. → `200 {"status":"ok"}`.

### `GET /orders`

The open book, newest first. → `200 {"orders": [Order, …]}`. Only `open`
**public** orders are listed; fetch other statuses (and private orders, with
their share token) by id.

### `GET /orders/stream`

Server-Sent Events push of the open book. On connect and after every
observable change the server emits:

```
event: book
data: {"orders":[…]}
```

Comment pings (`: ping`) flow roughly every 15 s to hold idle proxies open.
`503` (JSON body) when the connection caps are hit; keep a slow `GET /orders`
poll as fallback. Browser `EventSource` reconnects on its own.

### `GET /orders/:id`

One order, any status. → `200 {"order": Order}`. `404 order not found` for
unknown/expired ids (ids are 16 lowercase hex chars; anything else is a 404).

Private orders additionally require the share token in the `X-Share-Token`
header; without a valid token the response is the same `404` as an unknown id.

### `POST /orders`: list an order (maker)

```jsonc
{
  "direction": "eth->qrl",           // required
  "asset": "USDC",                   // optional, default ETH
  "fromAmount": "5000000",           // required, base units of the maker leg
  "toAmount": "2000000000000000000", // required, base units of the taker leg
  "makerEthAccount": "0x…",          // required
  "makerQrlAccount": "Q…",           // required
  "visibility": "private",           // optional, default public
  "allowedTakerEth": "0x…",          // optional, private orders only
  "allowedTakerQrl": "Q…"            // optional, private orders only
}
```

→ `201 {"order": Order, "makerToken": "<64 hex>"}`, plus
`"shareToken": "<64 hex>"` when the order is private. Tokens are shown exactly
once. Creation counts as a heartbeat.

Errors: `400` per-field validation (including taker restrictions on a public
order), `503 order book is full`.

### `POST /orders/take`: take by terms (taker)

Atomically fills the **best** open order matching the caller's bounds: "I pay
at most `maxPay` (the order's `toAmount`) to receive at least `minReceive`
(the order's `fromAmount`)". Two takers racing for one displayed row both fill
while depth exists, and a stale click can only fill at the terms the taker saw
or better. Matching is asset-scoped, skips offline makers
(`makerSeen: false`) and never matches private orders. Best taker rate wins,
then larger fill, then FIFO.

```jsonc
{
  "direction": "eth->qrl",
  "asset": "ETH",                    // optional, default ETH
  "maxPay": "2000000000000000000",
  "minReceive": "20000000000000000",
  "takerEthAccount": "0x…",
  "takerQrlAccount": "Q…"
}
```

→ `200 {"order": Order, "takerToken": "<64 hex>"}`.

Errors: `400` validation, `409 no open order matches those terms; the book may
have moved`, `429` take caps.

### `POST /orders/:id/accept`: take by id (taker)

Reserves a specific order (including offline-maker orders take-by-terms would
skip).

```jsonc
{
  "takerEthAccount": "0x…",
  "takerQrlAccount": "Q…",
  "shareToken": "<64 hex>"           // required for private orders
}
```

→ `200 {"order": Order, "takerToken": "<64 hex>"}`.

Errors: `404` (also a private order without a valid `shareToken`),
`403 this order is reserved for a specific taker`,
`409 order is no longer open`, `429` take caps.

### `POST /orders/:id/hashlock`: announce the swap parameters (maker)

Called after the maker (always the initiator) has locked on-chain. Moves the
order `accepted -> locking` and publishes what the taker needs to verify the
lock and respond.

```jsonc
{
  "token": "<makerToken>",
  "hashlock": "0x<64 lowercase hex>",  // sha256 of the maker's 32-byte secret
  "initiatorTimeout": 1752307200,      // unix seconds, maker leg
  "responderTimeout": 1752303600       // unix seconds, taker leg
}
```

Enforced (mirroring the contract-level invariant; clients still re-verify
on-chain): `responderTimeout > now + 600`, and
`initiatorTimeout - now >= 2 * (responderTimeout - now)`: the initiator's
window must cover the responder's twice over.

→ `200 {"order": Order}`.

Errors: `403 invalid maker token`, `409 order is not awaiting a hashlock`,
`400` hashlock/timeout validation.

### `POST /orders/:id/heartbeat`: maker presence ping (maker)

```jsonc
{ "token": "<makerToken>" }
```

→ `200 {"order": Order}`. In-memory only (no disk write), read-class rate
limit: deliberately cheap to call every few seconds. Beat at least once per
90 s per open listing to stay matchable.

Errors: `404`, `403 invalid maker token`.

### `POST /orders/:id/cancel`: pull a listing (maker)

```jsonc
{ "token": "<makerToken>" }
```

→ `200 {"order": Order}` (idempotent). Cancelling only removes the listing;
funds already locked on-chain remain governed by the HTLC claim/refund paths.

Errors: `404`, `403 invalid maker token`.

### `POST /orders/:id/release`: taker walk-away (taker)

```jsonc
{ "token": "<takerToken>" }
```

→ `200 {"order": Order}` (idempotent). Semantics depend on phase:

- **Before the maker locks** (`accepted`): the order returns to the book
  untouched, taker fields cleared, and the take stops counting against the
  taker's caps entirely.
- **After the maker locks** (`locking`): the listing stays as-is (chain state
  governs the funds) and the order is flagged `released: true`; the maker
  should not commit further funds. The take stops occupying a concurrency slot,
  but still counts against the daily cap (it already cost the maker gas and a
  lockup).

Book-keeping only, so clients may fire and forget it on abandon/finish.

Errors: `404`, `403 invalid taker token`.

## Error status summary

| Status | Meaning |
|---|---|
| 400 | Malformed body or field validation failure |
| 403 | Missing/wrong maker or taker token |
| 404 | Unknown, malformed or expired order id / unknown route |
| 409 | Wrong order state for the action, or no match for take-by-terms |
| 413 | Body over 4096 bytes |
| 429 | Rate limit or per-IP take caps |
| 503 | Book full, or SSE connection caps |
| 500 | Unhandled server error |
