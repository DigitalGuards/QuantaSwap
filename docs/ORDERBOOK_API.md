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

- Primary base URL: `https://quantaswap.io/api` (same-origin `/api` proxy in
  front of the service). Independent mirrors expose the same API and are
  configured by clients with stable local ids.
- JSON over HTTP. Every POST requires `Content-Type: application/json`; other
  content types receive `415`. Request bodies must be JSON objects. Ordinary
  bodies are capped at **4096 bytes**; endpoints carrying ML-DSA-87 proofs use
  a **32 KiB** cap (`413 body too large`).
- Every error response is `{ "error": "<message>" }` with an appropriate HTTP
  status. Success shapes are given per endpoint below.
- Responses are `Cache-Control: no-store`.
- `GET /orders`, `GET /orders/stream`, and the federation feed allow wildcard
  CORS because they contain public data. Mutations and capability-gated reads
  echo only exact origins configured in `ORDERBOOK_CORS_ORIGINS`. Cookies and
  credentialed CORS are not used.

## Authentication and capabilities

There is no registration, no accounts, no API keys. Authorization uses
per-order capability tokens serialized as 64 lowercase hex characters without
`0x`, representing exactly 32 CSPRNG bytes:

- **Maker token**: authorizes `heartbeat` and the legacy `hashlock`/`cancel`
  lifecycle. On a private signed order it also proves access to origin-local
  intent, fill, and cancel routes. Legacy create mints it at the server. Signed
  create generates it at the client before signing and submits it as an outer
  request preimage.
- **Taker token**: returned once by legacy `POST /orders/:id/accept` or
  `POST /orders/take`. Authorizes `release` on that order.
- **Share token** (private orders only): gates reads and acceptance on the
  origin. Legacy create mints it at the server. Signed create generates it at
  the client before signing. The maker normally passes it in a share-link URL
  fragment, which keeps it out of HTTP requests until the taker deliberately
  uses it.

Signed OrderV1 binds the raw maker token and, for private orders, the raw share
token through separate domain-separated commitments:

```text
makerTokenCommitment = sha256(
  UTF8("QuantaSwap Maker capability V1\0") || makerToken as 32 raw bytes
)

shareTokenCommitment = sha256(
  UTF8("QuantaSwap Share capability V1\0") || shareToken as 32 raw bytes
)
```

Commitments are `0x` plus 64 lowercase hex characters. The maker commitment is
always nonzero. A public OrderV1 signs an all-zero share commitment and its
outer create request has no `shareToken`. A private OrderV1 signs a nonzero
share commitment and its outer request must provide the matching `shareToken`.

The service stores only the legacy SHA-256 token hash or the signed
domain-separated commitment. It never stores a signed create's raw preimage.
Raw maker and share tokens never enter federation events or application logs.
Deployments must also keep request bodies and capability headers out of reverse
proxy and observability logs. Losing every local copy leaves no recovery path.

These capabilities authorize origin-local operations and never federate.
Portable protocol authority comes from ML-DSA-87 proofs: FillIntentV1 is signed
by the taker, while FillV1 and CancelV1 are signed by the OrderV1 maker. Any
mirror or client can verify those proofs without trusting the server.

## The order object

All read and mutation endpoints return orders in this public shape (token
hashes and taker-IP bookkeeping are never serialized):

```jsonc
{
  "id": "a1b2c3d4e5f60718",        // 16 hex legacy id, or 64 hex signed derived id
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
  "released": false,                // authorized taker release observed
  "makerSeen": true,                // maker heartbeated within the presence TTL (90s)
  "visibility": "public",           // public | private (see Private orders)
  "allowedTakerEth": "0x…",         // present only on restricted private orders
  "allowedTakerQrl": "Q…",          // present only on restricted private orders
  "prelocked": true,                // present only on pre-funded orders (see below);
                                    // hashlock/initiatorTimeout are then set while open
  "createdAt": 1752300000,          // unix seconds
  "updatedAt": 1752300000,
  "makerAuth": {                    // present on portable OrderV1 listings
    "version": "1",
    "scheme": "qrl-sign-typed-v1", // or qrl-eip712-v4
    "issuedAt": 1752300000,
    "expiresAt": 1752472800,
    "nonce": "0x<64 lowercase hex>",
    "signature": "0x<9254 lowercase hex>",
    "publicKey": "0x<5184 lowercase hex>",
    "descriptor": "0x010000",
    "makerTokenCommitment": "0x<64 lowercase hex, nonzero>",
    "shareTokenCommitment": "0x<64 lowercase hex>"
  }
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

Legacy origin-local rows retain the original reservation flow:

```
open ──accept/take──> accepted ──hashlock (maker locked first)──> locking
 │  ^                    │                                          │
 │  └──taker release─────┘ (pre-lock walk-away: order relists)      │
 └─cancel/expiry─> cancelled <──cancel (listing only; funds stay   │
                                        governed on-chain) ────────┘
```

New portable OrderV1 rows are single-use. A short-lived taker FillIntentV1 is
a proposal only. The maker then signs exactly one terminal child:

```
open ──FillIntentV1 proposal──> open ──FillV1──> locking
  └───────────────────────────────CancelV1──> cancelled
```

A FillV1 selects one intent and carries the hashlock and both timeouts. It
never reopens. A release-secret preimage may mark the proposal or terminal fill
released, after which the maker must stop and post a fresh OrderV1 if it still
wants to quote. Exact proof replays are idempotent. Distinct fills, a fill plus
a cancellation, or two OrderV1 term sets under one derived id are signed
equivocation: mirrors retain bounded proof evidence and suppress the order.

Server-side expiry (sweep) keeps the book readable; chain state remains the
source of truth for funds:

- `open` orders auto-cancel after **48 h** without updates.
- Signed `open` orders also auto-cancel at `makerAuth.expiresAt`, whichever is
  earlier.
- `accepted` orders that never reach a hashlock auto-cancel after **1 h**.
- Legacy `cancelled` records are purged after **1 h**. Signed cancellations
  remain through OrderV1 expiry plus a short clock-skew grace period.
- `locking` records are purged **24 h after the initiator timeout** (they
  linger for audit; the book never learns the on-chain outcome).
- FillIntentV1 and any associated ReleaseV1 are retained until **20 min after
  the intent expiry** while their order record exists. This covers the maximum
  15 min FillV1 response window plus a 5 min terminal grace, including a fill
  published near the end of a 120 s intent.

The book holds at most **200 open orders**, **40 open orders per ETH/QRL maker
address pair**, and **50 open orders per source IP**. Create endpoints return
`503 order book is full` at the global bound and `429` at either narrower
bound. Signed maker addresses are authenticated, but one actor can still own
many keys, so the source and global caps remain necessary.

Retained terminal and expiry artifacts have separate bounds: **256 orders
globally**, **64 per maker pair**, **64 per local source IP**, and **128 total
from federation**. Public portable orders have an additional **64-order global
bound** across local and federated sources, with at most **48 federated public
portable orders** and **16 first supplied by one direct peer**. These bounds are
also checked while loading persisted state. Each order retains at most **8
FillIntentV1 proposals** and **2 conflicting proof artifacts** per conflict
class. A full retained store rejects new creates while preserving active
recovery evidence.

These are resource ceilings, not Sybil resistance. A public client with enough
maker keys and source addresses can occupy available listing slots until the
orders expire. Testnet operators should monitor capacity and restrict access
when abused. A real-value permissionless deployment needs an economic or
identity-based admission policy reviewed separately from this transport.

### Portable OrderV1 maker proofs

`POST /orders/signed` accepts one canonical economic order plus an ML-DSA-87
proof. The server reconstructs the payload; it never trusts a client-supplied
typed-data document. OrderV1 commits to direction, asset and amounts, both
maker accounts, visibility and private taker restrictions, any pre-funded
hashlock/T1, issuance, expiry, a 32-byte nonce, both capability commitments,
both chain IDs, and both HTLC deployments. Its typed-data field order is part
of the protocol and must be reproduced exactly:

```text
direction:string
asset:string
fromAmount:uint256
toAmount:uint256
makerEthAccount:string
makerQrlAccount:string
visibility:string
allowedTakerEth:string
allowedTakerQrl:string
prelocked:bool
hashlock:bytes32
initiatorTimeout:uint64
issuedAt:uint64
expiresAt:uint64
nonce:bytes32
makerTokenCommitment:bytes32
shareTokenCommitment:bytes32
ethChainId:uint256
ethHtlc:string
qrlChainId:uint256
qrlHtlc:string
```

The 64-hex order id is signer-bound:

```text
sha256(
  UTF8("QuantaSwap OrderV1 id\0") ||
  makerQrlAccount[1..] as 20 raw bytes ||
  nonce as 32 raw bytes
)
```

The digest is returned as 64 lowercase hex characters without `0x`. This keeps
the identity stable across mirrors and prevents another signer from claiming a
victim's bare nonce. Fixed interoperability vector:

```text
makerQrlAccount = Q2222222222222222222222222222222222222222
nonce            = 0x4242424242424242424242424242424242424242424242424242424242424242
id               = cd84c99465b251d67a23548932b13fe84caa67d28c8331686e91774343552e0e
```

The domain is `QuantaSwap` version `1`, QRL testnet chain `1337`, plus a
deployment salt bound to the current Sepolia and QRL HTLCs. Two explicit,
non-interchangeable schemes are supported:

- `qrl-sign-typed-v1`: MyQRLWallet's SHAKE256 `QRLDomain` typed-data scheme,
  requested with `qrl_signTypedData` and verified with the QRL Connect SDK.
- `qrl-eip712-v4`: the official QRL Web3 Wallet's EIP-712 compatibility
  scheme, requested with `qrl_signTypedData_v4`, then wrapped with the
  wallet's QRL signed-message hash and verified under ML-DSA context `ZOND`.

Ethereum values inside string fields use a CAIP-style
`eip155:11155111:0x...` representation. This is deliberate: the official QRL
web3 ABI treats a bare `0x...` string as bytes while standard EIP-712 treats it
as UTF-8. The prefixed representation is byte-identical in both encoders; a
fixed interoperability vector is covered by server and browser tests.

Capability and digest interoperability vectors use the canonical fixtures in
the server, browser, and headless-maker tests:

| Value | Golden vector |
|---|---|
| Maker capability, raw `00` repeated 32 bytes | `0x9ca8274349471eadc293ebb7690d81e64ce538ad0d9d65646f9ff1af227709e6` |
| Share capability, raw `11` repeated 32 bytes | `0xe0e4441fa2456254d19815bb0b962e160e06027efe181f8f8887292f527590e2` |
| OrderV1 semantic and EIP-712 digest | `0x5a76e96bdd26891fc5b28848ed2f519a9fee5d8bdc7614692b71a3431c085a48` |
| Official-wallet signed-message wrapper digest | `0xc305e6936db7a0b374f936cb7058fde90963e39896f5d127f25bd87c147211d3` |
| ReleaseV1 commitment | `0xa786c492a3707147bfa3277ddf44d49af0c794252e42dd05379f04b8c4621e0e` |
| FillIntentV1 semantic digest | `0x48f387eff4522d99a48f52ec0e9e8b146fa0deb119383c53ffbb7d134ca00a2b` |
| FillV1 semantic digest | `0x6d4d7d0a3fb70062fc6897c9f402353536e3ffeefe7a6e698b5db78cedcb3c13` |
| CancelV1 semantic digest | `0xde9d19dc6dd94501ea1fb23ac89295ce139cc2f8566aee99f5b5ca5f83769214` |

Exact input terms are pinned in
[`server/src/order-signing.test.ts`](../server/src/order-signing.test.ts) and
cross-checked by
[`marketmaker/src/protocol-signing.test.ts`](../marketmaker/src/protocol-signing.test.ts)
plus [`frontend/src/lib/orderSigning.test.ts`](../frontend/src/lib/orderSigning.test.ts).

Unsigned rows remain available as origin-local compatibility data and never
enter federation. This capability-aware signed schema is predeployment, so
there is no signed-artifact migration path. Startup rejects persisted signed
rows missing either capability commitment, including earlier bare-nonce
OrderV1 experiments. Recreate those test orders under the current schema.

### Portable terminal proofs

All replay identities are scheme-independent semantic EIP-712 digests over
fixed fields and deployment bindings. The actual proof may use either wallet
scheme described above.

- **FillIntentV1 body**: `orderDigest`, taker ETH and QRL accounts, and
  `releaseCommitment`. Its auth nonce is `requestNonce`; lifetime is at most
  120 seconds and cannot exceed the OrderV1 validity window.
- **FillV1 body**: `orderDigest`, `intentDigest`, both taker accounts,
  `releaseCommitment`, `hashlock`, `initiatorTimeout`, and `responderTimeout`.
  Its proof must derive the OrderV1 maker QRL account. It may use either
  supported scheme even when OrderV1 used the other scheme. `respondBy` is the
  auth expiry, 60 to 900 seconds after issuance, no later than OrderV1 expiry,
  and more than 600 seconds before T2. T2 is at most 2 h after FillV1 issuance.
  A classic T1 is at most 4 h after issuance and its window is at least twice
  the T2 window.
- **CancelV1 body**: `orderDigest` and an unsigned-byte `reasonCode`. Maker
  authorization derives the same maker QRL account, may use either supported
  scheme, and has an auth expiry equal to OrderV1 expiry.
- **ReleaseV1**: a 32-byte preimage, without another wallet prompt. Its
  commitment is SHA-256 over the fixed `QuantaSwap ReleaseV1` prefix plus the
  OrderV1 digest, request nonce, and release secret. Revealing it is terminal
  for that proposal or fill and never reopens OrderV1.

FillV1 embeds the selected intent and proof when published, so a new mirror can
verify the entire chain without trusting another book's local intent state.

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
- is readable and usable by a taker only with its share token. Without a valid
  token, reads, legacy accepts, and signed intent submission answer the same
  `404` as a nonexistent id, so an id alone (which transits URLs and access
  logs) confirms nothing;
- may carry `allowedTakerEth`/`allowedTakerQrl`: both legacy acceptance and
  signed FillIntentV1 verification reject any other taker addresses, so even a
  leaked link cannot be sniped. The maker's client still verifies the taker
  before locking, and the HTLC fixes the recipient at lock time;
- remains origin-local for every lifecycle. Signed intent reads and maker
  terminal mutations also require the origin's maker token. No private order,
  protocol proof, release capability, or presence state enters federation.

### Pre-funded (prelocked) orders

A maker may escrow on-chain at post time with an open-recipient lock (HTLC v2
`lockNativeOpen`/`lockTokenOpen`) and list the order with
`prelock: { hashlock, initiatorTimeout }`. The book then:

- carries `prelocked: true` plus the anchored `hashlock` and
  `initiatorTimeout` while the order is still `open` (for every other order,
  a non-null hashlock implies status `locking`);
- rejects a create whose `initiatorTimeout` is closer than **3 h** or further
  than **72 h** out, or whose hashlock collides with another live order. For a
  signed order this window is measured from signed issuance and OrderV1 expiry
  cannot outlive the prelock;
- stops offering the order (list, take-by-terms, accept all skip or `409`)
  once less than **2 h 30 m** of the fixed T1 remains: below that a fresh 1 h
  responder window plus the clients' claim margin no longer fits;
- requires a legacy hashlock announcement or portable FillV1 to echo the
  stored `hashlock` and `initiatorTimeout` verbatim (`400` on mismatch: a
  desynced maker cannot produce a matching escrow).

The book cannot verify the escrow (it has no RPC on purpose). Clients treat
`prelocked` as a hint and verify the open lock on-chain: status Open, agreed
token and amount, recipient still unset, enough T1 runway. The maker's client
assigns the taker as recipient at match (`assign`), and can reclaim an
untaken escrow at any moment with `release`.

## Rate limits

Per-IP, fixed one-minute windows, split by class so a burst of one cannot
starve the other (`429 rate limited, slow down`):

| Class | Limit | Notes |
|---|---|---|
| Reads (`GET`) | 1440/min | heartbeats count as reads despite being `POST` |
| Mutations (other `POST`) | 120/min | |

Take and FillIntent caps, per IP (fairness for shared demo liquidity, not
sybil resistance):

- **4 concurrent actions**: an unreleased portable intent occupies a slot until
  its signed expiry. A legacy take occupies a slot through `accepted` and, once
  `locking`, through the earlier of T1 or two hours after acceptance. Release
  frees the slot.
- **24 actions per rolling 24 h**: portable intents count by mirror receipt
  time and legacy takes by acceptance time.

SSE stream: at most **200 concurrent connections** overall and **4 per IP**;
beyond that the endpoint answers `503` and you should fall back to polling.

Federation feed reads use dedicated fixed one-minute windows. They bypass the
general read counter above, preserving order-view and heartbeat capacity:

| Lane | All feed reads | Reset reads | Concurrent responses |
|---|---:|---:|---:|
| Public | 240/source, 3840 global | 4/source, 64 global | 1/source, 4 global |
| Authenticated peer | 240/source, 3840 global | 4/source, 64 global | 1/source, 16 global |

`source` is the resolved client IP within that lane. A request consumes its
concurrency slot before either rate counter, and a reset consumes both the feed
and reset counters. Excess traffic receives `429`.

The feed remains publicly readable. A mirror may set one 32-byte lowercase-hex
`ORDERBOOK_FEDERATION_READ_TOKEN`; an exact `Authorization: Bearer <token>`
selects the independent authenticated lane. Pulling mirrors put the remote
tokens, aligned one-for-one with `ORDERBOOK_FEDERATION_PEERS`, in
`ORDERBOOK_FEDERATION_PEER_TOKENS`. Setting the outbound variable requires one
64-character token for every configured peer. Token comparison is constant
time, and tokens stay out of status, logs, events, and state files.

## Endpoints

### `GET /health`

Storage-aware readiness probe. → `200 {"status":"ok"}` while the service is
accepting work and both order and federation state paths are readable and
writable; otherwise `503 {"status":"degraded"}`.

Peer availability deliberately does not change this readiness result. A mirror
can continue serving verified local evidence while one of its pull peers is
offline.

### `GET /status`

Sanitized operator diagnostics. The response uses `200` while local storage and
the feed are ready, or `503` for the same local failures as `/health`:

```jsonc
{
  "schemaVersion": 1,
  "status": "ok",
  "uptimeS": 3600,
  "feed": {
    "ready": true,
    "retainedEvents": 42,
    "oldestSequence": 1,
    "latestSequence": 42,
    "lastEventAt": 1786924800000
  },
  "federation": {
    "enabled": true,
    "state": "healthy",
    "running": false,
    "configuredPeers": 2,
    "healthyPeers": 2,
    "deferredEvents": 0,
    "lastCompletedAt": 1786924800000,
    "peers": [
      {
        "id": "community-1",
        "state": "healthy",
        "consecutiveFailures": 0,
        "resetStreak": 0,
        "lastAttemptAt": 1786924800000,
        "lastSuccessAt": 1786924800000,
        "nextAttemptAt": null
      }
    ]
  }
}
```

All `*At` fields are Unix milliseconds. Federation-wide state is `disabled`,
`starting`, `healthy`, or `degraded`; a peer is `pending`, `syncing`, `healthy`,
`degraded`, or `stale`. The peer id is the public label at the same position in
`ORDERBOOK_FEDERATION_PEER_IDS`, or `peer-N` when no labels are configured.
Status omits peer URLs, raw cursors, feed ids, errors, file paths, orders,
accounts, and capabilities. `GET /status` allows wildcard read CORS and uses
`Cache-Control: no-store`.

### `GET /federation/v1/events`: mirror pull feed

```text
GET /federation/v1/events?cursor=<feedId>:<sequence>&limit=256
```

The cursor belongs only to the serving mirror. A valid cursor returns ordered
content-addressed events after that sequence. A missing, stale, foreign, or
future cursor returns `reset: true` plus an atomic snapshot and a new cursor:

```jsonc
{
  "reset": false,
  "cursor": "<32 lowercase hex>:42",
  "hasMore": false,
  "events": [
    {
      "seq": 42,
      "eventId": "<64 lowercase hex sha256>",
      "event": { "kind": "order-v1", "payload": { "order": {}, "auth": {} } }
    }
  ]
}
```

Kinds are `order-v1`, `fill-intent-v1`, `fill-v1`, `cancel-v1`, and
`release-v1`. Event ids hash canonical JSON, allowing loop-safe relay across
peer topologies. Every receiver verifies protocol proofs before persistence.
The feed excludes unsigned rows, every private row, all bearer tokens, IP
metadata, presence, and other mirror-local state.

Transport is deliberately bounded. One event is at most **64 KiB**, a normal
page contains at most **256 events** and **4 MiB** of serialized response data,
the durable feed ring retains **4096 events**, and one peer sync reads at most
**16 pages**. At most **64 public portable orders** are retained within the
global **256-order** retained-state bound. Per order, three OrderV1 proofs,
eight intent/release pairs, three terminal proofs, and one terminal release
make 23 records. The largest current reset is therefore **1,472 records**.
Receivers retain a separate hard rejection ceiling of 6,144 snapshot records.
Every federation response, including a reset, is capped at **32 MiB** after
decompression and during local serialization. Peer responses must be
`application/json`, and redirects are rejected. The serving mirror reuses
identical serialized pages for five seconds in a 128-entry, 64 MiB response
cache, while every request still consumes its lane limits.

A reset is one atomic page. Incremental pages are applied and their cursor is
checkpointed one page at a time, so a later timeout resumes after the last
completed page. The configured request timeout is one total deadline for all
pages, parsing, and application work for that peer. At most **16 peers** may be
configured, and a two-worker pool keeps slow peers from serializing the whole
sync cycle.

Receivers require exact page, record, and event fields; canonical bounded
cursors; contiguous sequences; event ids matching canonical event content;
and unique event ids within and across pages. Applied event ids are reused
only within the current sync cycle. Every record supplied by a later reset is
revalidated against current store state, allowing valid evidence swept since an
earlier cycle to be reconstructed. The duplicate checks prevent a peer from
replaying the same expensive proof through a different page position in one
sync.

Transport cursors may advance while a child arrives before its prerequisite.
The receiver keeps up to **4096 dependency-missing events** in memory, with a
**512-event quota per peer**, retries them after all peers in as many as **8
causal passes**, and retains them across ordinary authoritative resets because
local state is a verified merge. A quota offender has only its source claims
removed and its cursor forced to reset. Shared events remain queued through any
other peer that supplied them. Encountering the global bound applies the same
offending-source reset. Deferred retries back off to **60 seconds**. An entry
expires after **one hour** or **512 attempts**, resetting every associated
source cursor. Invalid proofs are rejected immediately. Fetched and deferred
rejections share an **8-record per-peer sync budget**; reaching it degrades and
backs off that peer. A restart discards the in-memory dependency queue and
requests reset snapshots again.

Peer transport failures and repeated reset churn use independent exponential
backoff from **10 seconds** through **5 minutes**. The first bootstrap reset is
normal and does not count as churn. Healthy peers continue through the
two-worker pool while an affected peer waits.

### `GET /orders`

The open book, newest first. → `200 {"orders": [Order, …]}`. Only `open`
**public** orders are listed; fetch other statuses (and private orders, with
their share token) by id.

The reference browser accepts at most **16 mirrors** including its same-origin
primary. Configuration permits 15 additional exact `{id, apiBase}` entries and
rejects duplicate ids or normalized API bases. Each HTTP response is capped at
**4 MiB** before parsing and each snapshot at **200 rows**. Duplicate ids or any
malformed signed row invalidate only that source snapshot. The browser opens
SSE only to its trusted same-origin primary because native `EventSource`
buffers a complete event before application code can enforce a byte bound.
Independent mirrors use bounded HTTP polling with one in-flight request per
source and exponential retry from **10 seconds** through **5 minutes**.

Every signed row is verified locally. Identical signed envelopes share an
expiry-aware verification cache capped at **1,024 entries**. A same-id signed
digest conflict creates a persistent local quarantine, capped at 1,024 ids and
retained for 49 hours, so its disappearance from one later snapshot cannot
silently restore the order. Per-source generations prevent a slow HTTP result
from overwriting a newer primary SSE snapshot.

### `GET /orders/stream`

Server-Sent Events push of the open book. On connect and after every
observable change the server emits:

```
event: book
data: {"orders":[…]}
```

Comment pings (`: ping`) flow roughly every 15 s to hold idle proxies open.
`503` (JSON body) when the connection caps are hit; keep a slow `GET /orders`
poll as fallback. The reference browser's same-origin primary `EventSource`
reconnects on its own.

### `GET /orders/:id`

One order, any status. → `200 {"order": Order}`. `404 order not found` for
unknown/expired ids (legacy ids are 16 lowercase hex; signed OrderV1 ids are
64 lowercase hex; anything else is a 404).

Private orders additionally require the share token in the `X-Share-Token`
header; without a valid token the response is the same `404` as an unknown id.

### `POST /orders`: list an order (maker)

Unsigned compatibility endpoint for legacy origin-local clients. Current
interactive wallets and the reference headless maker use
`POST /orders/signed` below.

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
  "allowedTakerQrl": "Q…",           // optional, private orders only
  "prelock": {                       // optional: pre-funded listing
    "hashlock": "0x<64 lowercase hex>",
    "initiatorTimeout": 1752472800   // unix seconds, now+3h .. now+72h
  }
}
```

→ `201 {"order": Order, "makerToken": "<64 hex>"}`, plus
`"shareToken": "<64 hex>"` when the order is private. Tokens are shown exactly
once. Creation counts as a heartbeat.

Errors: `400` per-field validation (including taker restrictions on a public
order and the prelock window), `409 an order with this hashlock already
exists`, `503 order book is full`.

### `POST /orders/signed`: list a portable signed order (maker)

```jsonc
{
  "order": {
    "direction": "eth->qrl",
    "asset": "ETH",
    "fromAmount": "1000000000000000",
    "toAmount": "2000000000000000000",
    "makerEthAccount": "0x…",
    "makerQrlAccount": "Q…",
    "visibility": "public"
  },
  "auth": {
    "version": "1",
    "scheme": "qrl-sign-typed-v1",
    "issuedAt": 1752300000,
    "expiresAt": 1752472800,
    "nonce": "0x<64 lowercase hex>",
    "signature": "0x<9254 lowercase hex>",
    "publicKey": "0x<5184 lowercase hex>",
    "descriptor": "0x<6 lowercase hex>",
    "makerTokenCommitment": "0x<domain-separated makerToken digest>",
    "shareTokenCommitment": "0x0000000000000000000000000000000000000000000000000000000000000000"
  },
  "makerToken": "<64 lowercase hex preimage>"
}
```

The `order` shape is otherwise the same as `POST /orders`, but signed orders
must make `visibility` explicit and use canonical lowercase addresses and
amounts. Lifetime is at most 48 hours; issuance more than five minutes in the
future, expiry with less than one minute remaining, a signer/public-key
mismatch, or any changed term fails closed. Signed order, prelock, intent,
fill, cancel, and auth objects reject unknown or missing fields so every
implementation hashes the same semantic object.

The public request has exactly the outer fields `auth`, `makerToken`, and
`order`. A private request has exactly `auth`, `makerToken`, `order`, and
`shareToken`, with a nonzero signed share commitment matching that raw
preimage. Unknown outer fields fail closed. JSON member order is irrelevant.

The client must generate the raw capabilities first, commit them in OrderV1,
sign, and durably stage the complete outer request before its first POST. The
browser keeps one unresolved stage in local storage; the headless LP persists
the same envelope in its mode-0600 state. Neither creates a different order
until that stage is resolved.

→ `201 {"order": Order, "makerToken": "<same submitted preimage>"}`, plus the
same submitted `shareToken` for a private order. An exact retry after a timeout
or lost response returns the existing authenticated order and echoes the
preimages supplied again in that retry. The server does not recover raw tokens
from storage. Existing-order replay is checked before admission and retained
state capacity, so an exact recovery retry still succeeds when the book fills
after the first write. Preserve the stage until the response reproduces the
expected OrderV1 digest and authentication, then promote it to durable
active-order state.

A same-id request with a different OrderV1 digest returns `409`. Stored
commitments that differ from the retried proof, reuse of either commitment by
another retained signed order, and ordinary capacity limits also fail closed.
Raw preimages that do not match their signed commitments return `401`.

### `POST /orders/:id/intents`: propose a signed fill (taker)

```jsonc
{
  "intent": {
    "orderDigest": "0x<64 lowercase hex>",
    "takerEthAccount": "0x<40 lowercase hex>",
    "takerQrlAccount": "Q<40 lowercase hex>",
    "releaseCommitment": "0x<64 lowercase hex>"
  },
  "auth": {
    "version": "1",
    "scheme": "qrl-sign-typed-v1",
    "issuedAt": 1752300000,
    "expiresAt": 1752300120,
    "nonce": "0x<64 lowercase hex>",
    "signature": "0x<lowercase hex>",
    "publicKey": "0x<lowercase hex>",
    "descriptor": "0x<6 lowercase hex>"
  }
}
```

For a private order, send the origin's share capability in `X-Share-Token`
or `shareToken`. → `201 {"intent": {"intentDigest", "intent", "auth",
"receivedAt"}}`. Exact retries are idempotent. The order remains open until
the maker publishes FillV1. At most 8 pending intents are retained per order.

### `GET /orders/:id/intents`: read pending proposals (maker)

→ `200 {"intents": [...]}` ordered by signed `auth.issuedAt`, then semantic
`intentDigest`. Mirror-local `receivedAt` never decides the winner. Proposals
issued in the future, expired proposals, and released proposals are omitted.
Public portable proposals are public data. A private order additionally
requires `X-Maker-Token` and remains origin-local.

### `POST /orders/:id/fill`: terminal match and hashlock (maker)

```jsonc
{
  "fill": {
    "orderDigest": "0x<64 lowercase hex>",
    "intentDigest": "0x<64 lowercase hex>",
    "takerEthAccount": "0x<40 lowercase hex>",
    "takerQrlAccount": "Q<40 lowercase hex>",
    "releaseCommitment": "0x<64 lowercase hex>",
    "hashlock": "0x<64 lowercase hex>",
    "initiatorTimeout": 1752307200,
    "responderTimeout": 1752303600
  },
  "auth": { "version": "1", "scheme": "qrl-sign-typed-v1", "...": "..." },
  "intent": { "...": "the exact selected FillIntentV1 body" },
  "intentAuth": { "...": "the exact selected taker auth" }
}
```

For a private order, also send `X-Maker-Token` or `token`. →
`200 {"order": Order}` with status `locking`. This is the maker's terminal
single-use decision and the hashlock announcement. Clients independently
verify the full proof chain and the on-chain initiator lock before funding.
An exact replay is idempotent. A distinct valid terminal proof quarantines the
order and exposes its digest in `conflictDigests` on an id lookup. The returned
order includes the exact `fill`, `fillAuth`, `fillDigest`, and `selectedIntent`
so clients can authenticate the response without trusting HTTP status alone.
The reference LP durably records its FillV1 acknowledgment only after this
authentication and requires that record before its first on-chain lock.

### `POST /orders/:id/cancel/signed`: terminal cancellation (maker)

```jsonc
{
  "cancel": {
    "orderDigest": "0x<64 lowercase hex>",
    "reasonCode": 1
  },
  "auth": { "version": "1", "scheme": "qrl-sign-typed-v1", "...": "..." }
}
```

For a private order, also send `X-Maker-Token` or `token`. →
`200 {"order": Order}` with status `cancelled`. The proof is a permanent
tombstone through OrderV1 validity and exact retries are idempotent. The
returned order includes `cancelProof`, `cancelAuth`, and `cancelDigest`.

### `POST /orders/take`: take by terms (taker)

Legacy-only endpoint. Atomically fills the **best unsigned** open order
matching the caller's bounds: "I pay
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

Legacy-only endpoint. Reserves a specific unsigned order, including an
offline-maker order that take-by-terms would skip. New portable rows return
`409 signed orders require a FillIntentV1 request`.

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
`409 order is no longer open`,
`409 this pre-funded order has too little time left to swap safely`,
`429` take caps.

### `POST /orders/:id/hashlock`: announce the swap parameters (maker)

Legacy-only endpoint. Called after the maker (always the initiator) has locked
on-chain. Moves the
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

On a pre-funded order the maker locked at POST time, not here; `hashlock` and
`initiatorTimeout` must echo the values anchored at create (`400` on
mismatch), and only `responderTimeout` is new.

→ `200 {"order": Order}`.

New portable rows use FillV1 and reject this endpoint. Errors:
`403 invalid maker token`, `409 order is not awaiting a hashlock`,
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

Legacy-only endpoint. Portable rows use `cancel/signed`.

```jsonc
{ "token": "<makerToken>" }
```

→ `200 {"order": Order}` (idempotent). Cancelling only removes the listing;
funds already locked on-chain remain governed by the HTLC claim/refund paths.

Errors: `404`, `403 invalid maker token`.

### `POST /orders/:id/release`: taker walk-away (taker)

Legacy accepted rows use their bearer token:

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

Portable rows instead reveal the committed release preimage:

```jsonc
{
  "releaseSecret": "0x<64 lowercase hex>",
  "intentDigest": "0x<64 lowercase hex>" // before or racing FillV1
}
```

After observing FillV1, use `fillDigest` instead of `intentDigest`. Exactly one
reference is required. A private order also carries `shareToken` and remains on
its origin. The server verifies the commitment, marks the intent or fill
released, and relays public ReleaseV1. A release racing a matching FillV1 also
marks that selected fill released. OrderV1 never reopens; a maker that still
wants to quote signs a fresh order with a fresh nonce.

The reference LP persists an authenticated `released: true` observation as a
sticky safety fact. It never starts or repeats a lock for that fill afterward.
If an earlier lock attempt may have landed, it retains the record and follows
verified on-chain claim or refund state instead of abandoning recovery.

Errors: `404`, `403 invalid taker token` or release preimage, `409` unknown
signed intent/fill reference.

## Error status summary

| Status | Meaning |
|---|---|
| 400 | Malformed body or field validation failure |
| 401 | Signed proof authentication or signed capability-preimage check failed |
| 403 | Missing/wrong maker or taker token |
| 404 | Unknown, malformed or expired order id / unknown route |
| 409 | Wrong state, conflicting replay, reused capability, or no terms match |
| 413 | Body over 4096 bytes, or signed-protocol body over 32 KiB |
| 415 | POST content type is not `application/json` |
| 429 | Rate limit, take caps, or per-maker/per-source open-order cap |
| 503 | Book full, SSE connection cap, shutdown, or unavailable storage |
| 500 | Unhandled server error |
