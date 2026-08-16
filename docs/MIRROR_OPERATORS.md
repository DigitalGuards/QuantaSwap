# Operating an independent QuantaSwap mirror

An order-book mirror is an untrusted discovery and coordination relay. It
stores signed public protocol evidence and may exchange that evidence with
other explicitly configured mirrors. It never holds funds, validates chain
settlement for clients, signs orders, or needs an Ethereum or QRL private key.

This guide is for a second organization or individual running a genuinely
independent testnet mirror. The wire reference is
[ORDERBOOK_API.md](ORDERBOOK_API.md), and the protocol trust boundary is in
[ARCHITECTURE.md](ARCHITECTURE.md).

## What independence means

A second process on the original host is useful for testing. An independent
failure domain has its own:

- operator and administrative accounts;
- host, HTTPS domain, firewall, and reverse proxy;
- persistent state volume, encrypted backups, and monitoring;
- reviewed peer list and browser CORS policy;
- release verification and rollback decision;
- incident response contact.

Do not copy another operator's state volume, server access, LP state, wallet
seed, market-maker key, or environment file. The mirror requires no wallet
secret at all. Liquidity provision is a separate role and is documented in
[LIQUIDITY_PROVIDERS.md](LIQUIDITY_PROVIDERS.md).

## 1. Select and verify the software

Tagged releases publish multi-architecture images through the order-book
release workflow. Pin an immutable digest, verify its keyless signature and
GitHub attestation as shown in [the server README](../server/README.md), and
record the source tag plus digest in your change log.

Put the verified digest in `.env`, then pull and start without rebuilding:

```dotenv
ORDERBOOK_IMAGE=ghcr.io/digitalguards/quantaswap-orderbook@sha256:<verified-digest>
```

```bash
docker compose pull orderbook
docker compose up -d --no-build orderbook
```

If no reviewed image tag is available yet, build only an explicitly reviewed
commit:

```bash
git clone https://github.com/DigitalGuards/QuantaSwap.git
cd QuantaSwap
git fetch --tags origin
git switch --detach <reviewed-commit>
cd server
npm ci
npm test
docker compose build --pull
```

Never treat a mutable branch name or image tag as a production pin.

## 2. Prepare the host boundary

The supplied Compose service runs as the unprivileged `node` user, drops all
Linux capabilities, uses a read-only root filesystem, and persists only its
named state volume. Its published port stays on host loopback.

Copy the template and choose a stable project and volume name:

```bash
cd server
cp .env.example .env
chmod 600 .env
```

Keep these defaults unless your reviewed topology requires a change:

```dotenv
ORDERBOOK_PORT=8091
ORDERBOOK_TRUST_PROXY=none
ORDERBOOK_STATE_VOLUME=quantaswap-orderbook-state
ORDERBOOK_IMAGE=ghcr.io/digitalguards/quantaswap-orderbook@sha256:<verified-digest>
```

Put an HTTPS reverse proxy in front of `127.0.0.1:8091`. If the proxy and
container share a host, overwrite both client-address headers before selecting
`ORDERBOOK_TRUST_PROXY=all`:

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:8091;
    proxy_http_version 1.1;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header CF-Connecting-IP "";
    proxy_buffering off;
    proxy_read_timeout 120s;
}
```

Never combine proxy trust `all` with a publicly bound container port. When a
CDN is in front, first configure the proxy to trust only that CDN's published
networks and derive `$remote_addr` from its authenticated edge header.

## 3. Configure federation and browser access

Federation peers are public API bases selected by operator policy. The list is
not learned from gossip:

```dotenv
ORDERBOOK_FEDERATION_PEERS=https://book-a.example/api,https://book-b.example/api
ORDERBOOK_FEDERATION_PEER_IDS=operator-a,operator-b
ORDERBOOK_FEDERATION_PEER_TOKENS=<operator-a-token>,<operator-b-token>
ORDERBOOK_FEDERATION_READ_TOKEN=<this-mirror-token>
ORDERBOOK_FEDERATION_SYNC_MS=5000
ORDERBOOK_FEDERATION_REQUEST_TIMEOUT_MS=10000
```

Peer labels align by position, are unique, contain only lowercase letters,
numbers, and internal hyphens, and appear in logs and `/api/status`. URLs never
appear in the public status response. The service accepts at most 16 reviewed
peers.

Each mirror generates one inbound token and exchanges it with reviewed peer
operators through a private channel:

```bash
openssl rand -hex 32
```

Set your generated 64-character lowercase-hex value as
`ORDERBOOK_FEDERATION_READ_TOKEN`. Each operator pulling your feed puts that
value in their aligned `ORDERBOOK_FEDERATION_PEER_TOKENS` list. Put the inbound
token supplied by each remote operator at that peer's position in your own
list. When the outbound list is set, every configured peer needs a token.

Every peer paired with a bearer token must use HTTPS. Startup fails if an
authenticated peer uses HTTP. The
`ORDERBOOK_FEDERATION_ALLOW_INSECURE_PEER_TOKENS=true` escape hatch is reserved
for the disposable two-container lab on its isolated Docker network. Never use
that escape hatch between hosts or on an operator deployment.

The signed feed remains public. A valid bearer token selects a separate
authenticated availability lane and gives no write authority. Tokens stay out
of events, durable state, logs, and public status. Rotate an exposed token with
a coordinated configuration update among every operator that received it.

Public feed traffic is limited to 240 reads per source and 3,840 globally each
minute, including four reset snapshots per source and 64 globally. It has one
concurrent response per source and four globally. The independent authenticated
lane has the same per-minute rate ceilings and one response per source, plus 16
reserved global concurrency slots.

One federation event is at most 64 KiB. Incremental pages contain at most 256
records and 4 MiB, while every response is capped at 32 MiB. The 64 public
portable-order retention cap produces at most 1,472 reset records within the
256-order total retention bound. Federated public portable rows are capped at
48 overall and 16 first supplied by one direct peer. The puller uses two workers
for at most 16 peers and applies the configured request timeout across the
complete peer sync, including all pages and proof application.

These limits bound resource use but do not stop public-client Sybil listing
spam. Multiple maker keys and source addresses can occupy the remaining slots
until expiry. Treat this as a monitored testnet service. Do not advertise a
real-value permissionless book until an economic or identity-based admission
policy has received a separate review.

Exact envelopes, canonical cursor continuity, content-derived event ids, and
cross-page unique ids are mandatory. Incremental cursors checkpoint after each
successfully applied page. Fetched and deferred proof failures share an
eight-record budget per peer sync. A peer that reaches the budget is degraded
and backed off independently.

For a browser hosted on another origin to submit intents or other mutations to
this mirror, allow that exact origin:

```dotenv
ORDERBOOK_CORS_ORIGINS=https://dev.quantaswap.io
```

Public order snapshots, SSE, status, and federation feeds use wildcard read
CORS. Mutation responses echo only an exact configured origin, never
credentials. Keep capability headers and request bodies out of proxy logs.

## 4. Bootstrap two independent mirrors

Each operator first confirms their own local service:

```bash
docker compose up -d
docker compose ps
curl --fail https://book.example/api/health
curl --fail https://book.example/api/status | jq
curl --fail 'https://book.example/api/federation/v1/events?limit=1' | jq
```

Then both operators add the other's reviewed HTTPS API base and restart with
the same state volume. An initial reset snapshot is normal. A healthy status
eventually reports:

```bash
curl --fail https://book.example/api/status \
  | jq -e '.status == "ok" and .federation.state == "healthy"'
```

Do not require byte-identical local JSON files or transport cursors. Each feed
has its own identity and sequence, while mirrors converge on authenticated
protocol evidence. A restart intentionally forgets pull cursors and requests a
fresh bounded reset snapshot.

## 5. Monitor the right signals

Use both endpoints:

- `/api/health` is local readiness. Alert immediately on non-200.
- `/api/status` is diagnostic. Alert when top-level `status` is not `ok`, when
  `feed.ready` is false, or when a configured peer remains `degraded` or
  `stale` beyond your incident window.

Peer outages do not change local readiness. That prevents a remote failure from
causing restart loops while still making incomplete discovery visible. Status
contains no URL, cursor, feed id, raw error, state path, order, account, or
capability. Timestamp fields are Unix milliseconds.

Also monitor HTTPS from a different network. A loopback-only health check cannot
detect DNS, CDN, certificate, firewall, or reverse-proxy failures.

## 6. Back up, update, and roll back

The named volume contains `orders.json` plus `orders.json.federation`. Stop the
service and stream a consistent archive directly into GPG encryption. Replace
the recipient placeholder with a reviewed key fingerprint:

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
if ! gpg --list-packets "$backup_file" >/dev/null; then
  rm -f "$backup_file"
  exit 1
fi
docker compose start orderbook
service_needs_start=false
trap - EXIT
```

The pipeline leaves no plaintext backup directory. Its exit trap attempts to
restart the service after every failure, and any failed stop, backup,
verification, or restart leaves a nonzero exit. A failed partial output is
removed. `gpg --list-packets` confirms that the result parses as an OpenPGP
message; it does not prove that the private key and passphrase can restore the
archive. Periodically run a
decrypt-and-list recovery drill on the workstation that holds the private key:

```bash
set -o pipefail
gpg --decrypt "$backup_file" | tar -tzf - >/dev/null
```

The order file contains operational metadata, hashed client and
federation-source identifiers, private-order terms, signed proofs, and
capability commitments. The feed file contains public signed events. Neither
should contain raw signed-create capabilities. Both remain private operational
data.

For an update:

1. verify the new immutable image or source commit;
2. run its tests and inspect schema or migration notes;
3. stop and encrypt a state snapshot;
4. start the new version with the same named volume;
5. verify health, status, feed, SSE, and logs through public HTTPS;
6. retain the prior image digest and backup until the observation window ends.

If startup rejects state, stop. Preserve the exact file and use the prior image
for recovery. Never erase or replace state merely to make a new binary boot.

## 7. Add the mirror to a browser build

Running a mirror does not automatically enroll it in the reference frontend.
After operator, TLS, CORS, uptime, and incident-contact review, add it at build
time:

```dotenv
VITE_ORDERBOOK_MIRRORS=[{"id":"community","apiBase":"https://book.example/api"}]
```

The browser independently verifies signed rows, drops malformed origins,
quarantines observed equivocation, and routes later calls back to a currently
available source. A build accepts at most 15 community mirrors plus the primary
and rejects duplicate ids or normalized API bases. Community mirrors use one
in-flight bounded HTTP poll each, with failed sources backing off from 10
seconds through 5 minutes. Native SSE stays on the trusted same-origin primary
because it cannot enforce a byte limit before buffering an event. Identical
signed envelopes share a 1,024-entry, expiry-aware proof cache. Unsigned public
rows remain primary-only, and private orders remain on the origin named in
their invitation.

## Local acceptance before external coordination

The repository includes a disposable two-container lab:

```bash
cd server
docker build --tag quantaswap-orderbook:lab .
docker compose -f compose.federation-lab.yaml up -d --no-build
FEDERATION_SMOKE_BASE_A=http://127.0.0.1:18091/api \
FEDERATION_SMOKE_BASE_B=http://127.0.0.1:18092/api \
  node federation-smoke.js
docker compose -f compose.federation-lab.yaml down --volumes
```

External-base mode verifies the two-container HTTP transport in both
directions, a signed intent and fill, signed cancellation, private and unsigned
exclusion, raw-capability exclusion, and sanitized peer status. The managed
`npm test` path additionally scans persisted state for capabilities, stops one
mirror, creates an order during the partition, restarts it with the same state,
proves reset-snapshot recovery, and checks outage visibility plus local
readiness. External-base mode refuses non-loopback bases because it creates test
records.
