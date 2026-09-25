# QuantaSwap self-hosted LP kit

This package runs the reference QuantaSwap protocol-mode market maker with
operator-owned wallets and inventory. It uses the same public order-book and
HTLC protocol as the browser maker. It does not grant an operator any protocol
privilege, custody user funds, or share keys with another LP.

**Testnet only.** QuantaSwap has not completed a real-value deployment review.
Use only Sepolia ETH/tokens and private QRL v3 testnet funds until that milestone is
explicitly closed in the project release notes.

## Quote admission and retained proofs

New quotes expire after five minutes by default (`MM_ORDER_LIFETIME_S`, integer
180 through 1800 seconds). Existing signed records keep their original expiry.
The maker durably accounts for each quote through the book's cancellation grace
and for filled orders through their recovery retention horizon. A local budget
of 60 retained records leaves headroom below the book's unchanged 64-record
public, maker, and source limits. Fast price moves can temporarily thin quoted
depth until retained records expire. Cancellation, claim, and refund handling
continue throughout admission pressure.

Rate limits and unavailable create responses use a shared bounded retry delay.
Retries reuse the exact persisted order proof and capability. `/health` includes
sanitized `quoteAdmission` state; upstream admission backoff reports degraded
health, while a normal local retention wait is visible as `waiting-retention`.
The ledger is part of the atomic state file and survives restarts and terminal
order cleanup. Preserve it with the rest of the recovery state. Upgrading an
existing state file cannot erase already retained book artifacts or shorten
their signed validity. A saturated existing identity may need to wait for its
previous proofs to expire.

The maker reads existing version-1 state and writes version 2 with its admission
ledger on the next normal save. Older binaries refuse version 2. Preserve a
pre-upgrade backup and settle any newer swaps before a deliberate rollback;
never strip the ledger or relabel recovery state to make a downgrade load.

## What the kit provides

- a multi-stage image built from a digest-pinned Node base and `npm ci` lockfile;
- a non-root, read-only runtime with all Linux capabilities dropped;
- independent ETH and QRL wallet generation without printing either secret;
- read-only secret mounts instead of secrets baked into the image;
- a persistent, deployment-bound state volume for swap recovery;
- portable OrderV2 listings plus deterministic verification and selection of
  short-lived taker FillIntentV2 proofs;
- crash-safe persistence of the exact FillV2 or CancelV2 terminal proof before
  publication, with no order reopening after either decision;
- exact authentication of create, fill, cancel, and recovery responses before
  funding or deleting state, plus a durable FillV2 acknowledgment and sticky
  release observation;
- an exclusive process lease bound to the state path, deployment fingerprint,
  and operator accounts;
- a localhost-only health endpoint that reports progress without addresses,
  balances, endpoint URLs, order ids, raw errors, or key material.

The portable coordination layer changes no pricing, reserve, confirmation, or
on-chain swap decision behavior. It replaces mirror-local accept tokens for new
listings with independently verifiable ML-DSA-87 protocol messages.
The headless kit publishes public signed orders only. It creates each raw maker
capability before signing, commits its domain-separated SHA-256 digest inside
OrderV2, and persists the raw capability with the proof before the first POST.
An uncertain create can retry the exact request without minting a new order or
losing administrative access. Private signed orders remain a browser flow until
the kit has an allowed-taker policy and operator interface.

For raw maker token `m`, serialized as 64 lowercase hex characters without
`0x`, the signed field is:

```text
makerTokenCommitment = sha256(
  UTF8("QuantaSwap Maker capability V2\0") || m as 32 raw bytes
)
```

The kit signs the public-order zero value for `shareTokenCommitment`. It writes
the complete `{order, auth, makerToken}` create envelope to mode-0600 state
before transport. An exact retry receives the existing authenticated OrderV2
and the same raw maker token it supplied again. The mirror keeps only the signed
commitment. The raw token never enters federation or kit logs.

## QRL network compatibility gate

The private v3 deployment uses chain ID `3151909`, 64-byte Q-prefixed addresses,
and `@theqrl/web3` 1.0.3. Its exact genesis and fresh HTLC addresses are pinned in
`config/protocol-v2.json`. RPC reads and signing verify the network identity.
The same extended seed derives a different full-length account, so fund its v3
address explicitly with testnet inventory.

Portable V2 uses canonical, deployment-bound message bytes through SDK 5 message
signing. Legacy V1 proofs and deployment-bound recovery state are rejected.
Drain an old maker and preserve its original recovery environment before starting
with fresh v3 state. Existing locks must settle on their original contracts.
Build the container from the repository root context through the provided Compose
file; both Node packages require the sibling `config/protocol-v2.json` at runtime.

## Prerequisites

- Docker Engine with Compose 2.24 or newer;
- Node.js 20 or newer for the one-time key bootstrap;
- reachable order-book, Ethereum RPC, and QRL RPC endpoints;
- independent testnet capital for both legs and gas (see "Funding" below);
- for release verification: cosign 3.0 or newer and GitHub CLI 2.49 or newer.

Use RPC endpoints you trust. Claim simulation necessarily discloses a preimage
to the configured RPC immediately before broadcast. The order book remains a
coordination service and must never be trusted as proof of on-chain state.

### Funding

With the defaults (ETH pair only, two rungs per direction, 0.02 ETH rung-0
size, rung n sized n+1 times), quoting the full ladder in both directions needs
about 0.11 Sepolia ETH (0.06 listed plus the 0.05 gas reserve) and the QRL
value of 0.06 ETH plus the 5 QRL reserve (roughly 260 QRL at 4,200 QRL/ETH). A
smaller trial profile such as `MM_ORDERS_PER_DIRECTION=1` with
`MM_ETH_ORDER_WEI=5000000000000000` (0.005 ETH) needs about 0.055 ETH and
26 QRL. The maker logs one line per pair and direction when inventory or gas
keeps a rung unlisted, and another when quoting resumes.

Testnet sources: QRL from the [zondscan faucet](https://zondscan.com/faucet)
(100 QRL per address per 24 hours, so the default ladder takes about three
days of claims; start with the trial profile), Sepolia ETH from any public
Sepolia faucet, and Sepolia USDC from [faucet.circle.com](https://faucet.circle.com).

## Verified image releases

Maintainers publish `linux/amd64` and `linux/arm64` images to
`ghcr.io/digitalguards/quantaswap-marketmaker` from exact
`marketmaker-vMAJOR.MINOR.PATCH` tags. The tag must match the version in
`package.json`, and its commit must already be reachable from `dev`. The release
workflow reruns the locked tests and dependency audit before publishing. It
attaches an SBOM and maximum-mode build provenance, creates a GitHub artifact
attestation, and signs the immutable image digest with Sigstore keyless signing.

For production-like testing, pin the digest printed in the successful release
workflow. Releases are signed with cosign 3 and carry OCI 1.1 referrer
bundles: cosign 2.x reports `no signatures found`, and `gh attestation` needs
GitHub CLI 2.49 or newer.

```bash
docker pull ghcr.io/digitalguards/quantaswap-marketmaker@sha256:<digest>
cosign verify \
  --certificate-identity-regexp '^https://github\.com/DigitalGuards/QuantaSwap/\.github/workflows/marketmaker-release\.yml@refs/tags/marketmaker-v[0-9]+\.[0-9]+\.[0-9]+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/digitalguards/quantaswap-marketmaker@sha256:<digest>
gh attestation verify \
  oci://ghcr.io/digitalguards/quantaswap-marketmaker@sha256:<digest> \
  --repo DigitalGuards/QuantaSwap
```

The local Compose file builds from source by default. After reviewing the
release digest, signature identity, attestation, SBOM, and migration notes,
run the published image with the release overlay, which drops the local build:

```bash
LP_IMAGE=ghcr.io/digitalguards/quantaswap-marketmaker@sha256:<digest> \
  docker compose -f compose.yaml -f compose.release.yaml up -d
```

### Compose variables

| Variable | Default | Purpose |
|---|---|---|
| `LP_IMAGE` | (required by `compose.release.yaml`) | Verified release image, pinned by digest |
| `LP_KIT_VERSION` | `local` | Tag for a locally built image |
| `LP_COMPOSE_PROJECT` | `quantaswap-lp` | Compose project name; set per instance |
| `LP_STATE_VOLUME` | `quantaswap-lp-state` | Named volume holding recovery state; one per instance |
| `LP_HEALTH_PORT` | `8092` | Host loopback port for `/health` |

## First boot

Run these commands from `marketmaker/` at a reviewed release tag or commit:

```bash
npm ci
npm run init:keys -- ./secrets
cp .env.example .env
```

The initializer prints the two public funding addresses and writes only these
untracked files:

- `secrets/eth-private-key`, mode `0600`;
- `secrets/qrl-hexseed`, mode `0600`.

It refuses to overwrite either file. Back them up before funding the addresses.
Edit `.env` and review every endpoint, chain id, HTLC address, asset, reserve,
order size, price source, and timeout. The example points to the current public
testnet services, but an independent operator should use RPC infrastructure it
controls or independently trusts. `MM_ORDERBOOK_URL` defaults to the public
book at `https://quantaswap.io/api`; for a dry run, point it at the staging book
`https://dev.quantaswap.io/api` first.

Fund the printed addresses with testnet inventory and gas, then start:

```bash
docker compose build --pull
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:8092/health
docker compose logs --tail=100 marketmaker
```

The endpoint returns `503` while starting or degraded and `200` after chain-id
verification and a clean completed tick. Docker marks the container unhealthy
after repeated failed checks, but Compose does not restart it merely for being
unhealthy. Inspect the logs and recovery state before intervening.

### Single active process

Run one active process for each state volume and wallet pair. The maker creates
a mode-0600 `state.json.lock` lease before it reads recovery state. It records
the deployment and account identity digest, Linux boot id, PID, process start
time, PID namespace, and a random lease id. A live holder makes a second process
fail closed; a stale main lease from a crash or reboot is atomically replaced
while a separate recovery guard is held. A stale recovery guard causes fail-safe
refusal for manual inspection. Shutdown removes only the lease id it acquired,
so it cannot delete a newer holder's file. Use distinct volumes and keys for
distinct LP instances.

A holder in another PID namespace, which is what a second container on the same
state volume looks like, is judged by the lease heartbeat alone. Its PID and
process start time carry no meaning outside its own namespace. The running maker
refreshes the lease file's timestamp every 10 s, and every observer treats the
lease as live for 90 s after the last refresh. That gives three properties:

- a second container on one state volume fails closed while the first one runs,
  with a refusal that names the situation;
- after a container crashes, is killed, or the host reboots, its replacement
  waits for the heartbeat to expire and then takes the lease over
  automatically. Startup refuses during that window, so keep a restart policy on
  the container or supervisor. With Compose `restart: unless-stopped`, the
  restart backoff adds to the 90 s heartbeat lifetime, so unattended recovery
  takes up to roughly two minutes;
- a maker that loses the lease refuses every further state write, logs the
  displacement, and exits non-zero so its supervisor restarts it. It also stops
  writing when a beat cannot read or stamp the lease file for long enough that a
  peer would see its heartbeat expire.

This covers containers on **one host**, which share a clock and a kernel boot id.
A state volume shared between machines is not supported: the heartbeat comparison
is only as good as the two clocks agreeing, and no part of this design
coordinates across hosts. Give each machine its own volume and keys.

A lease record written before this change carries no PID namespace and keeps the
original PID-based semantics, which is correct for a single-host deployment.
Restart such a maker once so it writes the current record format.

**Manual recovery of a stale guard.** Startup refuses with
`state lease recovery guard ... is stale` when `state.json.lock.recovery`
outlived the starter that created it, which a hard kill during acquisition can
cause. Confirm no market maker process runs on that state volume (`docker
compose ps`, and check any other supervisor sharing the volume), then remove
`state.json.lock.recovery` by hand and start the maker again. Orphaned
`state.json.lock.next.*` staging files are swept automatically once they are
older than the heartbeat lifetime.

## State and recovery

The named volume `quantaswap-lp-state` contains `state.json`. That file can hold
live origin capability preimages, unrevealed swap preimages, selected taker
proofs, and the exact maker-signed OrderV2, FillV2, or CancelV2 artifacts needed
for safe retry. Treat it as a secret. Every record is bound to both chain ids
and both HTLC addresses. Protocol proofs are cryptographically reverified during
hydration, and a mismatch is refused without modifying the file.
If an atomic state rename succeeds and the following directory sync fails, the
state object becomes permanently poisoned and the process exits. This prevents
the running process from rolling memory back after the new file may have become
durable.

Order-book responses are also authenticated against this state. The maker
requires the exact OrderV2, selected FillIntentV2, FillV2 or CancelV2, semantic
digests, expected terminal status, and no equivocation evidence. A malformed or
contradictory success response blocks funding and leaves recovery state intact.

For portable fills, the kit persists `fillAcknowledged` only after authenticating
the exact locking response. The state write completes before the live decision
object changes, and its first on-chain lock requires that acknowledgment. An
unacknowledged local FillV2 proof does not grant funding authority. An
authenticated release observation is persisted as a sticky fact and
permanently blocks a new or repeated lock for that fill.

If the book becomes unavailable, the kit proceeds with chain settlement only
after a durable fill acknowledgment, a persisted lock attempt, or observed
exposure on either HTLC leg. Claim and refund remain driven by verified chain
state. Once a lock send has been attempted, the record is never automatically
abandoned because the current read says `None` or a timeout passed. A release
after possible exposure prevents re-locking while preserving claim and refund
recovery.

Never delete the volume, replace `state.json`, regenerate wallets, or change the
chain/HTLC identity while an order may be open, locked, claimable, or refundable.
To update the image safely:

1. set `MM_DRAIN=true` in `.env` and apply it with `docker compose up -d`;
2. keep the service online until `/health` reports `"draining":true` and
   `"managedOrders":0`; this cancels unfunded listings while continuing every
   accepted or locking swap through settlement or refund;
3. stop the service with `docker compose stop marketmaker`;
4. back up the wallet secret files and the state volume to encrypted storage;
5. build the reviewed new tag, run its tests, and start it with the same secrets,
   state volume, and deployment identity;
6. confirm `/health`, logs, balances, and open orders, then set `MM_DRAIN=false`
   when the operator deliberately wants to quote again.

For a state snapshot while stopped:

```bash
mkdir -p ./backups
docker compose cp marketmaker:/var/lib/quantaswap-marketmaker/state.json ./backups/state.json
```

Encrypt that snapshot and `secrets/` to your own GPG recipient in a private
backup location. Do not commit the encrypted artifacts to this source repository
unless repository access, key rotation, retention, and recovery have been
deliberately designed for that purpose. Test a restore with testnet-only funds
before relying on the backup.

## Operator independence

Each LP should use its own keys, host, RPC trust choices, capital, policy, logs,
monitoring, and encrypted backups. Sharing this image is useful. Sharing the
original operator's `.env`, state volume, wallet files, server access, or market
making account is not decentralization.

The complete policy and endpoint reference is in [`.env.example`](.env.example).
Protocol invariants and API details live in
[`../docs/LIQUIDITY_PROVIDERS.md`](../docs/LIQUIDITY_PROVIDERS.md) and
[`../docs/ORDERBOOK_API.md`](../docs/ORDERBOOK_API.md).
