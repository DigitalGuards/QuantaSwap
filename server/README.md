# QuantaSwap self-hosted order book

This package runs the protocol-mode coordination service. It discovers and
reserves orders but never holds funds, signs transactions, chooses recipients,
or decides whether an on-chain lock is valid. Every client must continue to
verify all economic and settlement facts against the HTLCs.

**Testnet only.** This image packages one independent mirror. It verifies and
stores the full single-use OrderV1, FillIntentV1, FillV1, CancelV1, and
ReleaseV1 proof chain. Mirrors relay signed public events through an optional
pull federation; private and unsigned rows stay origin-local.

## What the package provides

- a multi-stage image built from a digest-pinned Node base and npm lockfile;
- a non-root, read-only runtime with all Linux capabilities dropped;
- a persistent named volume for atomic mode-0600 order state;
- fail-closed startup if persisted JSON is unreadable or structurally invalid;
- bounded SSE backpressure, request deadlines, and graceful shutdown;
- explicit reverse-proxy trust instead of unconditional forwarded headers;
- global, per-maker, per-source, rate, take, and stream-connection limits;
- a storage-aware `/api/health` endpoint;
- dual-scheme ML-DSA-87 protocol verification for MyQRLWallet and the official
  QRL Web3 Wallet, with independent browser and headless LP verification;
- a durable content-addressed event feed with reset snapshots and cursors;
- explicit peer lists, loop-safe replay deduplication, narrow CORS, and
  origin-local private capabilities;
- bounded peer pages, response bodies, snapshots, retained state, intent sets,
  conflict evidence, and causal dependency retries.

## First boot

From `server/` at a reviewed release tag or commit:

```bash
cp .env.example .env
docker compose build --pull
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:8091/api/health
docker compose logs --tail=100 orderbook
```

The published port is host-loopback-only. Put a TLS reverse proxy in front of
it rather than exposing port 8091 publicly.

To federate mirrors, set `ORDERBOOK_FEDERATION_PEERS` to comma-separated API
bases such as `https://book-a.example/api,https://book-b.example/api`. Configure
the exact browser origins allowed to mutate this mirror in
`ORDERBOOK_CORS_ORIGINS`. Peer and origin lists are operator policy, not data
learned from untrusted events.

Each peer cursor belongs to that serving mirror. Missing, stale, foreign, and
future cursors produce an atomic reset snapshot. The durable ring holds 4096
events; a page holds at most 256 events, one sync reads at most 16 pages, and a
reset holds at most 6144 events. One event is capped at 64 KiB. Peer responses
must be `application/json`, cannot redirect, and are capped at 64 MiB after
decompression.

A terminal or release event may arrive before its OrderV1 or FillV1 when peers
sync concurrently. The receiver retains up to 4096 dependency-missing events
in memory, with at most 512 attributed to any one peer, and retries them after
all peers in up to eight causal passes. Ordinary authoritative resets retain
deferred entries because the local store is a verified merge. A peer that
exhausts its quota has only its source claims removed and its cursor forced to
reset; an event also supplied by another peer remains queued. The same
offending-source reset applies when a new event encounters the 4096 global
bound. Deferred retries back off to 60 seconds. After one hour or 512 attempts,
the entry expires and every associated source cursor resets. Restarting the
mirror clears the in-memory queue and obtains fresh reset snapshots.

Transport failures and repeated reset churn back off each affected peer
independently, starting at 10 seconds and doubling to a 5 minute ceiling. An
initial bootstrap reset is expected. Healthy peers keep syncing while a failing
or reset-looping peer waits.

## Signed create capabilities

For `POST /api/orders/signed`, the maker generates each raw 32-byte capability
before signing. OrderV1 includes:

```text
makerTokenCommitment = sha256(
  UTF8("QuantaSwap Maker capability V1\0") || raw maker token bytes
)

shareTokenCommitment = sha256(
  UTF8("QuantaSwap Share capability V1\0") || raw share token bytes
)
```

The raw tokens are 64 lowercase hex characters without `0x`; commitments are
`0x` plus 64 lowercase hex characters. The maker commitment is always nonzero.
A public order signs a zero share commitment and submits exactly `auth`,
`makerToken`, and `order`. A private order signs a nonzero share commitment and
also submits `shareToken`. The raw values are outer request preimages, outside
the signed economic order object, while their commitments are signed OrderV1
fields immediately after `nonce` and before the deployment fields.

Clients persist the complete signed request before its first POST. An exact
retry returns the existing order and echoes the raw capabilities supplied
again by that request. The server stores commitments and cannot reconstruct a
lost preimage. A different digest under the same id, a mismatched preimage, or
capability reuse fails closed. Pre-capability signed state is rejected on
startup because this schema has not been deployed yet.

Federation events contain signed commitments and public proofs only. Raw maker
and share tokens stay on their origin, and the service never writes them to its
logs. Keep request bodies and capability headers out of proxy and telemetry
logs as well.

Federation replicates signed discovery evidence. It is not consensus: peers
may omit or delay events, partitions can expose maker equivocation later, and
bounded history can discard old transport records. Clients aggregate multiple
mirrors, quarantine observed conflicts, preserve their own signed artifacts,
and use HTLC state for every fund decision.

## Verified image releases

Maintainers publish `linux/amd64` and `linux/arm64` images to
`ghcr.io/digitalguards/quantaswap-orderbook` from exact
`orderbook-vMAJOR.MINOR.PATCH` tags. The tag must match `package.json` and its
commit must already be reachable from `dev`. The workflow reruns all tests and
the dependency audit, attaches an SBOM and maximum-mode provenance, creates a
GitHub artifact attestation, and signs the immutable digest with GitHub OIDC.

Pin and verify the digest reported by a successful release:

```bash
docker pull ghcr.io/digitalguards/quantaswap-orderbook@sha256:<digest>
cosign verify \
  --certificate-identity-regexp '^https://github\.com/DigitalGuards/QuantaSwap/\.github/workflows/orderbook-release\.yml@refs/tags/orderbook-v[0-9]+\.[0-9]+\.[0-9]+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/digitalguards/quantaswap-orderbook@sha256:<digest>
gh attestation verify \
  oci://ghcr.io/digitalguards/quantaswap-orderbook@sha256:<digest> \
  --repo DigitalGuards/QuantaSwap
```

## Reverse proxies and client identity

`ORDERBOOK_TRUST_PROXY=none` ignores forwarding headers and is correct for a
direct deployment. The native non-container default is `loopback`, matching the
existing nginx-to-127.0.0.1 deployment.

A host reverse proxy reaches the Compose container through Docker's bridge, not
through container loopback. In that layout, keep the Compose port bound to
`127.0.0.1`, make the proxy overwrite both headers, and then set
`ORDERBOOK_TRUST_PROXY=all`:

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:8091;
    proxy_http_version 1.1;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header CF-Connecting-IP "";
    proxy_buffering off;
}
```

Never combine `all` with a publicly reachable container port. A direct client
could forge its address and bypass per-source controls.

If Cloudflare fronts nginx, configure nginx's Real-IP module with Cloudflare's
published address ranges first, then forward the resulting `$remote_addr` as
above. Do not pass arbitrary client-supplied forwarding headers through.

## State, backups, and recovery

The `quantaswap-orderbook-state` volume holds `orders.json` and
`orders.json.federation`. The first contains legacy bearer-token hashes or
signed capability commitments, client IPs, public and private order terms,
taker addresses, and retained protocol proofs. It contains no raw signed-create
capability. The second contains only public signed feed events and mirror-local
cursors. Neither is signing-key material, but the volume is still private
operational data. Encrypt backups and restrict access.

The two files use separate atomic writes. Before serving after a restart, the
mirror reconciles every retained public proof from `orders.json` into the feed,
closing a crash window between the two writes. A later feed persistence failure
starts fatal shutdown rather than accepting mutations peers cannot discover.

Admission is bounded at 200 open orders, 40 per maker pair, and 50 per local
source IP. Retained recovery state is bounded at 256 orders globally, 64 per
maker pair, 64 per local source, and 128 total federation-origin orders. Each
order retains up to eight intents and two conflicting artifacts per conflict
class. Pending intent and release evidence remains available through 20 minutes
after intent expiry while its order record exists. A capacity error preserves
existing evidence and refuses new work.

For a consistent snapshot:

```bash
docker compose stop orderbook
mkdir -p ./backups
docker compose cp orderbook:/var/lib/quantaswap-orderbook/. ./backups/
docker compose start orderbook
```

Do not replace a corrupt file with an empty array automatically. The service
now preserves it and refuses startup so an operator can inspect or restore the
last known-good snapshot. Startup also tightens an existing state file to mode
`0600`. Losing the book cannot steal or strand on-chain funds, but it can
invalidate active coordination handles and waste users' time.

## Safe updates

Stop the service, take an encrypted state snapshot, update the reviewed image
or source commit, and start with the same named volume. The service closes SSE
connections and stops accepting requests on `SIGTERM`; Compose allows 15
seconds before force termination. Makers receive one presence-TTL grace window
after restart and then must resume heartbeats.

For a native development run:

```bash
npm ci
npm test
npm start
```

The complete wire protocol remains in
[`../docs/ORDERBOOK_API.md`](../docs/ORDERBOOK_API.md).
