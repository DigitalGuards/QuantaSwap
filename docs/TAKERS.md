# Taking orders on QuantaSwap without a browser

Anyone can be a taker in protocol mode. A taker reads the coordination-only
order book, proposes a signed fill, and settles the swap through the on-chain
HTLCs, which have no owner, no pause and no upgrade path. The browser at
[quantaswap.io](https://quantaswap.io) does this interactively. This guide
covers the scripted taker in `marketmaker/`, for bots, aggregators and
arbitrage traders.

Wire-level details for every endpoint used here:
[ORDERBOOK_API.md](ORDERBOOK_API.md). Protocol background:
[ARCHITECTURE.md](ARCHITECTURE.md). The maker side:
[LIQUIDITY_PROVIDERS.md](LIQUIDITY_PROVIDERS.md).

**Testnet only.** QuantaSwap has not completed a real-value deployment review.
Use Sepolia assets and private QRL v3 testnet funds until that milestone is
explicitly closed in the project release notes.

## The taker lifecycle

The maker is always the initiator. A taker is always the responder, which is
the safer seat: you fund only after the maker's escrow exists on chain and
verifies against terms the maker signed, and your own escrow refunds to you if
the maker then walks away.

1. **Verify the order locally.** Every open row carries the maker's OrderV2
   proof. The client reconstructs the signed economic body from the row,
   recomputes the digest and the deterministic order id, and checks the
   ML-DSA-87 signature against the maker's full 64-byte QRL account. A row the
   book altered fails this, so nothing downstream trusts the book.
2. **Propose.** Generate a 32-byte release secret, commit it under the
   ReleaseV2 domain, and sign a FillIntentV2 valid for at most 120 seconds.
   The proposal and its secret reach disk before the book sees them, so the
   walk-away path survives a crash. `POST /orders/:id/intents`.
3. **Wait for the maker's terminal FillV2.** The maker selects one proposal
   first-come and publishes a single terminal fill carrying the hashlock and
   both timeouts. The client re-reads the order, authenticates the FillV2 proof
   chain against its own saved proposal, and persists that acknowledgment
   before it will fund anything. A proposal that expires unfilled is replaced
   by a fresh one.
4. **Verify the maker escrow on chain.** Read at the configured confirmation
   depth, the escrow must hold the agreed asset (resolved from the local
   registry this client compiles in), pay your account, hold the exact amount,
   and carry a timeout that outlives your own deadline by at least
   `TAKER_CLAIM_SAFETY_S`. A shallow escrow at the head stays unverified until
   it reaches that depth, and any mismatch ends the take with nothing funded.
5. **Fund your leg.** Escrow the amount you agreed to pay, with the maker as
   recipient and the signed responder timeout. A token leg approves the exact
   amount first, resetting a stale allowance when the asset needs it.
6. **Claim.** The maker's claim of your escrow publishes the preimage. The
   client then claims the maker escrow, which is your payout. A claim that
   lost the race because the maker sponsored it already paid you, so an
   escrow found `Claimed` counts as success.
7. **Or refund.** If the maker never claims, your escrow refunds to you after
   its own on-chain timeout. Walking away costs only gas.

Every irreversible step runs through one pure decision function
(`marketmaker/src/taker-policy.ts`) and every piece of recovery material is
written to disk before the send that needs it, so `resume` continues an
interrupted swap without repeating a transaction.

## Install

The taker ships inside the LP kit package, so it shares the chain clients,
signing and state lease with the maker.

```bash
cd marketmaker
npm ci
npm run build
node dist/taker-cli.js --help
```

`npm run taker -- <command>` builds first and forwards the arguments, which is
convenient during development.

## Keys and funding

```bash
npm run init:keys -- ./secrets
```

This prints two public funding addresses and writes only
`secrets/eth-private-key` and `secrets/qrl-hexseed`, both mode `0600`. It
refuses to overwrite either file. Back them up before funding.

Use a dedicated taker key pair. Reusing a maker's keys works, but then one
compromise costs both roles and the two processes compete for the same
nonces.

```bash
cp .env.taker.example .env.taker
# review every endpoint, chain id, HTLC address and safety window
set -a; . ./.env.taker; set +a
```

Fund both printed addresses:

- the leg you pay from needs the amount you intend to escrow, plus native gas
  for the lock and the claim;
- the leg you receive on needs only gas, and often not even that: makers that
  sponsor claims submit your payout claim themselves. Keep a small balance
  anyway so you can always claim and refund on your own.

Testnet sources: QRL from the [zondscan faucet](https://zondscan.com/faucet),
Sepolia ETH from any public Sepolia faucet, Sepolia USDC from
[faucet.circle.com](https://faucet.circle.com).

## Commands

### `list`

```bash
node dist/taker-cli.js list
node dist/taker-cli.js list --json
```

Open public orders whose maker proof verifies locally. Each line shows the
pair and direction, what you would lock, what you would receive, the price,
the order proof's expiry, the maker account, and whether the maker is present.
Rows without a valid portable proof are counted and skipped, and the summary
reports how many. No keys are needed.

### `quote <orderId>`

```bash
node dist/taker-cli.js quote <orderId> --max-in 250
```

Fetches one order, verifies the maker signature and terms, and prints exactly
what the taker would lock and receive, the price, the maker accounts, the
proof expiry, and the safety windows this client will enforce on the maker's
timeouts. With `--max-in` or `--min-out` it also reports whether the order
sits inside those limits. Read only: it signs nothing and sends nothing, and
needs no keys. Exit status is 1 when the order cannot be taken.

### `take <orderId>`

```bash
node dist/taker-cli.js take <orderId> --max-in 250 --min-out 0.02 --yes
```

Runs the whole swap. It verifies the order, checks the limits and your funding
balances, records the take, proposes, waits for the maker's FillV2, verifies
the maker escrow at depth, funds your leg, claims when the preimage appears,
and refunds if the maker abandons the swap. Exit status is 0 on a completed
claim, 1 when the take ended without funding, and 2 on an uneven settlement
that needs attention.

Limits are whole units of the asset on that leg: `--max-in 250` means at most
250 QRL when you pay the QRL leg, and `--min-out 0.02` means at least
0.02 ETH when you receive the Ethereum leg.

### `resume` and `status`

```bash
node dist/taker-cli.js status
node dist/taker-cli.js resume
```

`status` lists every recorded take with its phase, hashlock and deadline.
`resume` advances each unsettled take one pass, which is what a cron job or a
supervisor restart should call after a crash. Both read the same durable state
file the swap loop writes.

### `release <orderId>`

```bash
node dist/taker-cli.js release <orderId>
```

Reveals the committed release secret so the maker stops waiting and can quote
again. Only meaningful before you funded anything; after that the chain
governs, and the refund path applies.

## Safety flags

| Flag | Effect |
|---|---|
| `--dry-run` | Prints the action each step would take and sends nothing, signs nothing and writes no state. Available on `take`, `resume` and `release`. |
| `--yes` | Skips the interactive confirmation before the first funding decision. Required for non-interactive runs, which otherwise refuse to start. |
| `--max-in <amount>` | Refuses the take when the order asks for more than this on the leg you pay. |
| `--min-out <amount>` | Refuses the take when the order pays less than this on the leg you receive. |
| `--once` | A single pass, for cron-style operation. |
| `--json` | Machine-readable output for `list`, `quote` and `status`. |

Independent of any flag, this client refuses to fund when the maker escrow
mismatches in any field, when its timeout leaves less than
`TAKER_CLAIM_SAFETY_S` beyond your own deadline, when the escrow is only
visible at the head before reaching `TAKER_CONFIRMATIONS` depth, when your own
deadline is within `TAKER_LOCK_RUNWAY_S`, and when the order, the proposal or
the fill was released, cancelled or contradicted by conflicting maker
messages.

## State, recovery and single ownership

`TAKER_STATE_FILE` (default `./data/taker-state.json`) holds release secrets
and the exact signed proofs a retry needs. It is written `0600` and atomically,
and it must be treated as a secret. Every record is bound to both chain ids
and both HTLC addresses, and every proof is cryptographically re-verified when
the file is read: a record this build cannot authenticate stops the run, and
nothing on disk is reinterpreted.

One active process per state file. The taker takes the same exclusive lease the
maker uses (`<state file>.lock`), bound to the deployment fingerprint and the
operator accounts, so a second process on the same file fails closed while the
first one runs. Give each instance its own file and keys.

Never delete the state file, replace it, or change the chain and HTLC identity
while a take may be open, locked, claimable or refundable. Settle first, with
`status` reporting nothing unsettled.

## Container use

The published LP image carries the taker as a second entry point, so no extra
image or release workflow is involved:

```bash
docker run --rm \
  -e TAKER_ORDERBOOK_URL=https://dev.quantaswap.io/api \
  ghcr.io/digitalguards/quantaswap-marketmaker@sha256:<digest> \
  node dist/taker-cli.js list
```

A real `take` additionally needs the two secret files mounted read-only and a
persistent volume for `TAKER_STATE_FILE`, exactly like the maker's state
volume. Verify the image digest, signature and attestation first
([marketmaker/README.md](../marketmaker/README.md)).

## Writing your own taker

The API is small and the client modules are compact references:

- `marketmaker/src/taker-proofs.ts`: parse and authenticate an untrusted row,
  a maker FillV2 and a maker CancelV2.
- `marketmaker/src/taker-policy.ts`: the pure decision core, including the
  escrow verification rules and the funding refusals.
- `marketmaker/src/taker-orderbook.ts`: the three taker routes over the shared
  transport.
- `frontend/src/components/signedOrderFlow.ts` and
  `frontend/src/lib/swapMachine.ts`: the browser taker's equivalents.

The rules that matter, whatever you build: verify the maker proof yourself,
resolve asset symbols against your own registry, read counterparty escrow at a
confirmation depth you chose, gate every claim on the escrow's own on-chain
timeout, and persist recovery material before each
send.
