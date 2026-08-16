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
card walks you through the signed intent, terminal fill, lock, claim, or refund
flow with secrets generated and held in the browser. MyQRLWallet Extension is
the recommended portable typed-data signer; the official QRL wallet's
`qrl_signTypedData_v4` scheme is also verified.

The catch: **maker presence is tied to the open tab.** Your client heartbeats
the listing while its card is open; close the tab and after 90 seconds the
order is dimmed in the book and skipped by take-by-terms matching (it stays
takeable by explicit id). Fine for occasional liquidity; not for an
always-on book.

### 2. Headless (always-online liquidity)

Run a client against the order book API. You have two starting points:

- **Run or adapt `marketmaker/`**: the reference implementation used to stock
  the public book. The [self-hosted LP kit](../marketmaker/README.md) includes a
  digest-pinned container, Compose runtime, independent wallet bootstrap,
  persistent recovery state and a sanitized health endpoint. Hardened
  TypeScript with direct QRL signing and verification dependencies. It signs
  portable orders, independently verifies taker intents, and runs the whole
  lifecycle unattended: fill, lock, depth-verified
  claim, refund, repost, plus a price ladder tracking a CoinGecko cross rate,
  inventory reserves and reprice-on-drift. Every irreversible action flows
  through the pure decision core in `marketmaker/src/policy.ts` (tested by
  `npm test`). Configuration is documented in `marketmaker/.env.example`; the
  packaged runtime mounts the two signing secrets from untracked mode-0600
  files and never copies them into the image.
- **Write your own**: the API is small. Portable authority is ML-DSA-87 signed;
  bearer capabilities remain only for origin-local presence and private rows.
  `marketmaker/src/orderbook.ts` and
  `frontend/src/lib/orderbook.ts` are compact client references.

## The maker lifecycle

The maker is always the **initiator**: after selecting a taker's signed
proposal, you generate the secret, publish the terminal fill, lock first, and
your claim of the taker's leg reveals the secret that lets the taker claim
yours.

1. **Create, commit, sign, and stage**: generate a fresh raw 32-byte maker
   capability. A private browser order also generates a fresh 32-byte share
   capability. Sign OrderV1 over direction, asset, amounts, both maker accounts,
   deployment, expiry, a fresh nonce, and the two domain-separated SHA-256
   capability commitments. Public orders sign a zero share commitment; private
   orders sign a nonzero one. Persist the exact `{order, auth, makerToken}`
   request, plus `shareToken` when private, before the first
   `POST /orders/signed`. The stable cross-mirror id is SHA-256 over the fixed
   OrderV1 id domain, your raw 20-byte QRL account, and the raw 32-byte nonce.
   Keep the staged envelope until the origin returns the same authenticated
   OrderV1. Retry it without changing any field after an uncertain response.
2. **Heartbeat**: `POST /orders/:id/heartbeat` at least every 90 s per open
   listing (the reference maker beats every tick). It communicates origin
   liveness and keeps legacy rows eligible for take-by-terms matching.
3. **Verify proposals**: poll `GET /orders/:id/intents`. Independently verify
   every FillIntentV1 signature, deployment, order digest, taker accounts,
   release commitment, and expiry. Discard future-issued proposals, then select
   by signed `auth.issuedAt` and semantic `intentDigest`. Never use mirror-local
   `receivedAt` as a tie-breaker. Persist that exact proposal before making a
   terminal decision.
4. **Generate and persist**: generate a fresh 32-byte CSPRNG secret, compute
   `hashlock = sha256(secret)`, choose safe T1/T2, and persist the secret and
   terms. Never reuse a secret across swaps or chains.
5. **Sign the terminal fill**: sign FillV1 over the selected intent digest,
   taker accounts, release commitment, hashlock, timeouts, deployment, and a
   short `respondBy`. Persist the exact proof before
   `POST /orders/:id/fill`. If the response says `released: true`, stop before
   funding. Authenticate the returned OrderV1, FillV1, selected intent,
   semantic digests, status, and absence of cancellation or conflict evidence.
   Persist a separate `fillAcknowledged` flag only after authenticating that
   exact locking response, and make the acknowledgment durable before changing
   the live decision state. The reference maker requires this flag before its
   first lock; the locally persisted FillV1 proof alone is insufficient. A fill
   never reopens; use a fresh OrderV1 to quote again.
6. **Lock first**: lock your leg on-chain with the selected taker as recipient
   and the FillV1 initiator timeout. The contract enforces hashlock freshness.
7. **Verify the taker's lock, then claim**: wait for the taker's HTLC lock,
   re-read it on-chain **at your confirmation depth** (the reference maker
   re-reads at `head - N`), and verify recipient, amount, token address and
   timeout against your own registry, never against book data. Only then
   claim the taker's leg, which publishes the secret.
8. **Or refund**: if the taker never locks (or locks wrong), do nothing until
   your initiator timeout passes, then refund. Walk-away is always safe;
   abandonment costs only time.
9. **Cancel or repost**: before selecting an intent, a maker may sign and
   persist CancelV1, then `POST /orders/:id/cancel/signed`. A filled or
   cancelled listing is terminal. Authenticate the exact CancelV1 and digest
   in the response before deleting local state. Sign a fresh OrderV1 to stay in
   the book.

A taker can reveal the release preimage committed in FillIntentV1. It marks the
proposal or selected fill released and means commit no further funds. It never
relists the consumed OrderV1. If you already locked, follow the refund path.

## Pre-funded listings (prelock)

Instead of locking at match time, a maker may escrow up front with the HTLC's
open-recipient lock (`lockNativeOpen`/`lockTokenOpen`, recipient unset) and
list with `prelock: { hashlock, initiatorTimeout }` (see
[ORDERBOOK_API.md](ORDERBOOK_API.md#pre-funded-prelocked-orders)). The browser
flow is the *Pre-fund* checkbox on the post card. What changes:

- your listing is provably funded (takers verify the escrow on-chain before
  reserving), and your only match-time transaction is a one-time
  `assign(hashlock, taker)`;
- you can reclaim the escrow **on demand** with `release(hashlock)` at any
  moment before assigning; after assign, the escrow behaves exactly like a
  classic lock (refund only at T1);
- the escrow's T1 is fixed at post (the frontend uses 48 h, matching the
  listing TTL), and the book stops offering the order once less than 2 h 30 m
  of runway remains: release and relist at that point;
- order of operations at match is publish FillV1 first, assign second, and **never
  assign while the shared hashlock already exists on the responder chain**
  (a dust-cost squat there would strand your escrow until T1: release and
  relist with a fresh secret instead). Never reveal the secret while your own
  escrow is unassigned.

The reference market maker intentionally does **not** prelock: it is always
online, so lock-at-match costs its takers nothing, and unfunded listings keep
its inventory fungible across the whole ladder instead of parked per rung.

Portable timing bounds are enforced by the signer and verifier. FillIntentV1
lasts at most 120 s. FillV1 `respondBy` is 60 to 900 s after issuance and leaves
more than 600 s before T2. T2 is at most 2 h after FillV1 issuance. A classic
T1 is at most 4 h after issuance and provides at least twice the T2 window. A
signed prelock anchors T1 from 3 h through 72 h after OrderV1 issuance, cannot
expire before OrderV1, and must retain at least 2 h 30 m when matched.

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
- **Claim preflight**: simulate the exact claim calldata from the actual
  sender at `latest` immediately before submission, and never broadcast if
  it fails. This prevents publishing a secret for an already-reverting
  token or native payout. Issuer state can still change before mining, and
  the RPC sees the secret, so centrally controlled assets and the configured
  RPC remain explicit trust boundaries.

## Operational notes

- **Rate limits** (per IP): 1440 reads + 120 mutations per minute; heartbeats
  count as reads. Budget roughly two reads per open listing per tick when
  sizing a ladder. Full numbers in
  [ORDERBOOK_API.md](ORDERBOOK_API.md#rate-limits).
- **Gas on both chains**: protocol-mode makers need ETH for the Ethereum leg
  and QRL for the QRL leg (approve + lock + claim/refund). Keep reserves; the
  reference maker refuses to list below its configured floors.
- **Book capacity**: 200 open orders globally; listings expire after 48 h
  without updates, so long-lived makers repost rather than rely on stale rows.
  The mirror also retains at most 256 order artifacts, 64 per maker pair, 64
  per local source, and 8 signed intents per order. Capacity errors are normal
  backpressure: preserve local signed state and retry or use another mirror.
- **One active process per state and key set**: the reference maker acquires an
  exclusive mode-0600 `state.json.lock` lease before reading state. The lease
  binds the deployment fingerprint and both operator accounts, identifies the
  Linux boot plus process start time, refuses a live second process, and safely
  recovers a stale file after a crash or reboot. Distinct LP instances still
  need distinct state volumes and keys.
- **Authenticated book responses**: the reference maker checks exact signed
  order, fill, cancel, selected intent, semantic digests, terminal state, and
  conflict absence before funding or deleting state. Preserve this gate in
  custom integrations and treat a contradictory success response as hostile.
  An authenticated `released: true` observation is persisted and sticky, so a
  later stale or unavailable response cannot authorize a new lock.
- **Book-outage continuity**: a portable first lock requires a durably
  authenticated FillV1 acknowledgment. During a book outage, the reference
  maker continues chain settlement only when it already has that acknowledgment,
  a persisted lock attempt, or observed exposure on either HTLC leg. A prior
  lock attempt is never abandoned merely because an RPC currently reports
  `None` or the timeout passed. Released records with possible exposure stay
  managed for claim or refund, and they never re-lock.
- **Capability recovery**: signed creates are client-authored. The mirror stores
  the signed commitments and echoes the raw preimages supplied by an exact
  retry; it cannot reconstruct them. The browser stages one unresolved create
  in local storage, and the headless kit writes its envelope to mode-0600 state
  before transport. Never place maker or share preimages in federation payloads,
  application logs, reverse-proxy logs, or metrics.
- **State recovery identity**: the reference maker binds its state envelope
  and every order to both chain IDs and both HTLC addresses. It refuses a
  nonempty legacy or mismatched file without changing it. Recover those
  orders with their original configuration; never delete or reset the file
  merely to make the daemon start.
- **Operator independence**: each LP needs distinct keys, capital, host, RPC
  trust choices, policy, monitoring and encrypted backups. Do not clone the
  original operator's secret files, state volume or server access.
- **Testnet only for now**: real-value production waits on QRL v2 mainnet.
  Current contract addresses and faucet notes: [DEPLOYMENTS.md](DEPLOYMENTS.md).
