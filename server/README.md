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
- storage-aware `/api/health` readiness plus sanitized `/api/status` peer and
  feed diagnostics;
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
curl --fail http://127.0.0.1:8091/api/status | jq
docker compose logs --tail=100 orderbook
```

For a published release, set `ORDERBOOK_IMAGE` to the verified
`ghcr.io/digitalguards/quantaswap-orderbook@sha256:<digest>`, then run:

```bash
docker compose pull orderbook
docker compose up -d --no-build orderbook
```

A digest pin prevents a mutable tag from changing the deployed artifact.

The published port is host-loopback-only. Put a TLS reverse proxy in front of
it rather than exposing port 8091 publicly.

To federate mirrors, set `ORDERBOOK_FEDERATION_PEERS` to comma-separated API
bases such as `https://book-a.example/api,https://book-b.example/api`. Configure
matching public labels such as `foundation,community-1` in
`ORDERBOOK_FEDERATION_PEER_IDS`; when omitted, status and logs use `peer-1`,
`peer-2`, and so on. Labels must be unique. At most 16 explicitly reviewed peers
are accepted.

For shared deployments, generate one inbound token with `openssl rand -hex 32`
and set it as `ORDERBOOK_FEDERATION_READ_TOKEN`. Share that token privately with
each reviewed peer that receives reserved pull capacity. Put each remote
mirror's inbound token at the matching position in
`ORDERBOOK_FEDERATION_PEER_TOKENS`; setting this outbound list requires one
64-character lowercase-hex token for every configured peer. The token selects
an independent authenticated rate and concurrency lane. The feed remains
publicly readable, and credentials stay out of status, logs, events, and state.
An authenticated peer URL must use HTTPS so the bearer token is encrypted in
transit. `ORDERBOOK_FEDERATION_ALLOW_INSECURE_PEER_TOKENS=true` exists only for
the disposable two-container lab on its isolated Docker network. Do not enable
it for an operator deployment.

Configure the exact browser origins allowed to mutate this mirror in
`ORDERBOOK_CORS_ORIGINS`. Peer and origin lists are operator policy and come
from reviewed local configuration.

Each peer cursor belongs to that serving mirror. Missing, stale, foreign, and
future cursors produce an atomic reset snapshot. The durable ring holds 4096
events; an incremental page holds at most 256 events and 4 MiB, and one sync
reads at most 16 pages. One event is capped at 64 KiB. Every response, including
a reset, is capped at 32 MiB. The current 64 public portable-order admission
bound yields at most 1,472 reset records inside the 256-order total retention
bound. Receivers also reject snapshots above their 6,144-record defensive
ceiling. Peer responses must be `application/json`, and redirects are rejected.

Two workers pull up to 16 configured peers. The request timeout is one total
deadline for every page, parse, and application step for a peer. Incremental
pages checkpoint their cursor after successful application. Exact envelopes,
canonical cursor continuity, content-derived event ids, and cross-page unique
ids are required. Settled application results deduplicate proof work only
within the current sync cycle. Every record supplied by a later reset is
revalidated against current store state, allowing valid evidence swept since an
earlier cycle to be reconstructed.

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
or reset-looping peer waits. Fetched and deferred validation failures share an
eight-record per-peer sync budget; reaching it degrades and backs off that peer.

Public federation reads allow 240 requests per source and 3,840 globally each
minute, with four resets per source and 64 globally. Public responses occupy at
most four global concurrency slots and one per source. Authenticated peers use
an independent lane with the same per-minute rate ceilings and one response per
source, plus 16 reserved global concurrency slots.

`GET /api/status` reports local feed bounds and each configured peer as
`pending`, `syncing`, `healthy`, `degraded`, or `stale`. It exposes labels,
counters, and timestamps only. Peer URLs, cursors, feed ids, errors, file paths,
orders, wallet addresses, and capabilities are omitted. A remote peer outage
does not fail `/api/health` or the top-level local status: this mirror can still
serve verified state while operators alert separately on
`federation.state != "healthy"`.

## Optional Tor operator overlay

`compose.tor.yaml` adds one locally built C Tor sidecar. Its Debian base image
uses an immutable multi-architecture digest and the Debian Tor package uses an
exact version. The container runs as uid and gid 10001, has a read-only root
filesystem, drops every Linux capability, and enables `no-new-privileges`.

The overlay creates a v3 onion service whose virtual port 80 reaches
`orderbook:8091`. It also sets
`ORDERBOOK_FEDERATION_ONION_PROXY=socks5h://tor:9050`. Tor binds port 9050 only
to the internal `tor-socks` Compose network. No SOCKS port is published on the
host.

The order-book container is attached only to `tor-socks`, so native DNS and
direct Internet egress are unavailable. A separate hardened `admin-proxy`
sidecar preserves the host administration endpoint at
`127.0.0.1:${ORDERBOOK_PORT:-8091}`. That loopback endpoint is intended for
health checks and local maintenance in this onion-only topology.

Build the pinned sidecar from the reviewed checkout, then start the merged
configuration:

```bash
docker compose -f compose.yaml -f compose.tor.yaml build --pull tor admin-proxy
docker compose -f compose.yaml -f compose.tor.yaml up -d --no-build
docker compose -f compose.yaml -f compose.tor.yaml ps
docker compose -f compose.yaml -f compose.tor.yaml logs --tail=100 tor
```

The onion hostname and its private identity keys live in the named
`quantaswap-orderbook-tor-identity` volume. Tor guard, consensus, and client
state lives separately in `quantaswap-orderbook-tor-data`, preserving the Tor
instance's state across container recreation. Set
`ORDERBOOK_TOR_IDENTITY_VOLUME` and `ORDERBOOK_TOR_DATA_VOLUME` in `.env` before
first boot when the deployment needs different stable volume names. Reuse both
volumes across rebuilds and restarts. Back up the identity volume separately.

Configure only canonical v3 onion peers with this overlay. Align one token
position with every peer, and use the literal `-` in every position to select
the public feed lane:

```dotenv
ORDERBOOK_FEDERATION_PEERS=http://<first-56-character-v3-host>.onion/api,http://<second-56-character-v3-host>.onion/api
ORDERBOOK_FEDERATION_PEER_IDS=onion-book-1,onion-book-2
ORDERBOOK_FEDERATION_PEER_TOKENS=-,-
ORDERBOOK_FEDERATION_ONION_ONLY=true
ORDERBOOK_FEDERATION_ALLOW_INSECURE_PEER_TOKENS=false
```

The overlay fixes onion-only validation at `true` and the insecure-token flag
at `false`. Startup rejects every peer that is not a canonical v3 onion URL.
HTTP onion peers never receive an application bearer token. The `socks5h`
transport sends the onion hostname to Tor and has no native-DNS or direct
fallback.

Read the generated hostname, then probe the complete orderbook-to-SOCKS-to-onion
path from the running order-book container:

```bash
compose=(docker compose -f compose.yaml -f compose.tor.yaml)
onion_host=$("${compose[@]}" exec -T tor \
  cat /var/lib/quantaswap-tor/hidden-service/hostname)
"${compose[@]}" exec -T -e ONION_HOST="$onion_host" orderbook \
  node --input-type=module -e '
    import { FederationPeerTransport } from "./dist/peer-transport.js";
    const transport = new FederationPeerTransport("socks5h://tor:9050", {
      connectTimeoutMs: 90000,
    });
    try {
      const response = await transport.fetch(
        `http://${process.env.ONION_HOST}/api/health`,
        { redirect: "error", signal: AbortSignal.timeout(90000) },
      );
      console.log(`${response.status} ${await response.text()}`);
      if (!response.ok) process.exitCode = 1;
    } finally {
      await transport.close();
    }
  '
```

The expected result is `200 {"status":"ok"}`. Every inbound onion connection
reaches the order book from the Tor sidecar's single internal IP. All onion
visitors consequently share the service's per-source request, reset, stream,
and concurrency limits. One busy or abusive onion client can consume that
shared allowance. Keep `ORDERBOOK_TRUST_PROXY=none`, monitor `429` responses,
and treat this as a bounded testnet federation endpoint.

A normal browser cannot resolve an onion hostname. Tor Browser can open the
API, while this overlay does not publish the QuantaSwap frontend as an onion
site. Browser mixed-content, CSP, and CORS rules can also block a clearnet page
from fetching an HTTP onion API. Use the onion endpoint for server federation
and direct Tor-aware probes unless the complete browser deployment has
received a separate review.

The Tor Project documents [onion-service setup and identity
keys](https://community.torproject.org/onion-services/setup/) and [access from
Tor Browser](https://support.torproject.org/tor-browser/features/onion-services/).
Encrypted identity backup, restore, browser limits, and the complete privacy
boundary are covered in
[`../docs/MIRROR_OPERATORS.md`](../docs/MIRROR_OPERATORS.md).

## Local two-mirror acceptance lab

The checked-in Compose lab proves two separately hardened containers and state
volumes exchange signed protocol evidence over real HTTP on loopback host
ports:

```bash
docker build --tag quantaswap-orderbook:lab .
docker compose -f compose.federation-lab.yaml up -d --no-build
FEDERATION_SMOKE_BASE_A=http://127.0.0.1:18091/api \
FEDERATION_SMOKE_BASE_B=http://127.0.0.1:18092/api \
  node federation-smoke.js
docker compose -f compose.federation-lab.yaml down --volumes
```

External-base mode posts fresh test proofs and therefore refuses non-loopback
bases. It covers reciprocal HTTP transport, OrderV1, FillIntentV1, FillV1 and
CancelV1 propagation, origin-local exclusions, capability exclusion, and
sanitized status. The managed `npm test` mode additionally owns both child
processes, scans their persisted state for raw capabilities, simulates a
partition, restarts one mirror with its existing state, proves reset-snapshot
recovery, and confirms a peer outage leaves local readiness healthy.

Independent resilience requires another operator, host, domain, state volume,
and administrative boundary. The independent-host procedure is in
[`../docs/MIRROR_OPERATORS.md`](../docs/MIRROR_OPERATORS.md).

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
signed capability commitments, hashed client and federation-source identifiers,
public and private order terms, taker addresses, and retained protocol proofs.
It contains no raw signed-create capability. The second contains only public
signed feed events and its local feed sequence. Pull cursors are intentionally
in memory, so every process restart obtains a fresh reset snapshot from each
peer. Neither file is signing-key material, but the volume is still private
operational data. Encrypt backups and restrict access.

The two files use separate atomic writes. Before serving after a restart, the
mirror reconciles every retained public proof from `orders.json` into the feed,
closing a crash window between the two writes. A later feed persistence failure
starts fatal shutdown rather than accepting mutations peers cannot discover.

Admission is bounded at 200 open orders, 40 per maker pair, and 50 per local
source IP. Retained recovery state is bounded at 256 orders globally, 64 per
maker pair, 64 per local source, 128 total federation-origin orders, and 64
public portable orders across local plus federated sources. Federated public
portable rows are further bounded at 48 globally and 16 first supplied by one
direct peer. Startup enforces the same persisted-state ceilings. Each order
retains up to eight intents and two conflicting artifacts per conflict class.
The portable cap makes the largest current federation reset 1,472 records and
keeps a maximal signed reset inside the 32 MiB response ceiling. Pending intent
and release evidence remains available through 20 minutes after intent expiry
while its order record exists. A capacity error preserves existing evidence
and refuses new work.

The bounds contain memory use and preserve local capacity, but signatures alone
do not prevent Sybil listing spam. This kit is ready for reviewed testnet peers.
A real-value permissionless deployment still needs a separately reviewed
economic or identity-based admission policy.

For a consistent encrypted snapshot, replace the recipient placeholder with a
reviewed GPG key fingerprint:

```bash
set -euo pipefail
service_needs_start=true
trap 'if [ "$service_needs_start" = true ]; then docker compose start orderbook; fi' EXIT
docker compose stop orderbook
mkdir -p ./backups
gpg_recipient=replace-with-reviewed-key-fingerprint
backup_file="./backups/orderbook-state-$(date -u +%Y%m%dT%H%M%SZ).tar.gz.gpg"
if ! docker compose run --rm --no-deps --entrypoint tar orderbook \
    -C /var/lib/quantaswap-orderbook -czf - . \
    | gpg --batch --yes --encrypt --recipient "$gpg_recipient" \
        --output "$backup_file"; then
  rm -f "$backup_file"
  exit 1
fi
if ! gpg --batch --pinentry-mode error --list-only --decrypt "$backup_file" >/dev/null; then
  rm -f "$backup_file"
  exit 1
fi
docker compose start orderbook
service_needs_start=false
trap - EXIT
```

This pipeline writes encrypted output directly. Its exit trap attempts to
restart the service after every failure, and any failed stop, backup,
verification, or restart leaves a nonzero exit. The noninteractive
`gpg --batch --pinentry-mode error --list-only --decrypt` check confirms that
the output is decryptable by an available key without opening pinentry. It does
not prove that the interactive passphrase path can restore the archive.
Periodically run a decrypt-and-list recovery drill on the
workstation that holds the private key:

```bash
set -o pipefail
gpg --decrypt "$backup_file" | tar -tzf - >/dev/null
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
