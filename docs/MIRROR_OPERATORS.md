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

### Single active writer

One order book process owns its data at a time. Two processes on one state
volume interleave a whole-file rewrite of `orders.json` with appends to
`orders.json.federation` and destroy both files, so the book takes an exclusive
lease at startup: `orders.json.lock` and `orders.json.federation.lock`, one
beside each protected file, inside the state volume the container already
writes. A second process pointed at the same data logs
`FATAL: cannot take the single-writer lease` and exits non-zero without
touching any file.

Rules the lease follows:

- A crashed holder on this host is detected by its dead process id, so a
  replacement starts at once.
- A holder in another container, which is another PID namespace, cannot be
  inspected by process id. It is judged by the heartbeat it refreshes on its
  lease files every 10 seconds, and it counts as live for 90 seconds after the
  last refresh. After a crash or a `docker kill`, a replacement refuses to start
  and exits non-zero for up to 90 seconds; the container or supervisor restart
  policy is what retries until the heartbeat expires, so expect refusal lines in
  the logs during that window and unattended recovery in about two minutes with
  a restart backoff. A clean stop releases the lease and needs no wait.
- The guarantee covers containers on one host, which share a clock and a kernel
  boot id. A state volume shared between machines, for example over NFS, is not
  supported.
- The holder verifies ownership again immediately before every persisted write.
  A proven loss stops the process with exit code 1 so its supervisor restarts
  it, and the restart either takes the lease or fails closed against the live
  holder. When ownership can neither be confirmed nor disproved, for example
  because the lease file briefly cannot be read, the write is refused with
  `503`, nothing changes on disk, and `/api/status` reports
  `lease.ready: false` until a later check succeeds.
- Writes are group-committed, so one lost or unverifiable lease refuses every
  request in the batch it was proved for, with `503` and nothing changed on
  disk. Ownership is still proved at the start of each request, before any
  in-memory change, so the common case is refused before a mutation exists and
  the book keeps serving.
- A commit runs an event-loop turn or more after that proof, so the check is
  repeated immediately before the file is touched, and an unreadable lease is
  re-read a small bounded number of times first. A lease that stays unreadable
  across those attempts restarts the process, which is stricter than a refused
  request: memory already holds mutations whose callers were told they failed,
  so the only safe resolution is a restart that reloads the file. A repeated
  occurrence is a storage fault on the state volume and the container or
  supervisor restart policy is what recovers it.
- `ORDERBOOK_DATA` and `ORDERBOOK_FEDERATION_DATA` may not end in `.lock`;
  startup rejects those paths because the suffix names the lease files.

A `orders.json.lock.recovery` guard file appears for milliseconds while a
starter takes over a stale lease. A kill in that window leaves it behind, and
the next start takes it over by itself once its creator is provably gone. Two
thresholds decide that, and they differ because only one of the two cases can
read a process id:

- a guard from this host and PID namespace is judged by its creator's process
  id, so a dead creator is taken over at once;
- a guard from another PID namespace, which is another container, is judged by
  its age, and the threshold is 10 minutes. A guard covers a handful of file
  operations and is never refreshed, so no live starter produces one that old.
  This is deliberately far longer than the 90 second lease heartbeat lifetime,
  for the reason in the threat note below.

No restart loop needs an operator for either case.

One case is still manual, and its refusal names the exact file: a guard that
keeps looking live, which means a genuinely running starter, a guard from
another container younger than 10 minutes, or a half-written guard record.
Confirm no order book process runs on this data directory, then remove that one
`.lock.recovery` file by hand and leave the `.lock` files in place. Never remove
a `.lock` lease to make a start succeed; that is exactly the second writer the
lease exists to prevent.

**Accepted residual: a guard taken over twice.** Installing a taken-over lease
is a rename followed by a read that confirms the record, and those are two
operations. POSIX offers no compare-and-delete on a file, and `flock` needs a
native addon this service deliberately does not carry, so the confirming read
narrows this window without closing it. Two starters in different containers can
therefore both return from acquisition if, and only if, one of them stalls
inside the guard window for longer than the 10 minute guard threshold and the
other interleaves its own rename and confirmation exactly inside that stall. The
consequence is bounded: both processes verify ownership again before their first
persisted write, and each refreshes a heartbeat the other reads, so the loser
exits non-zero at or before that write and the winner keeps the data. The 10
minute threshold puts the precondition at the level of a machine fault, far past
ordinary scheduling latency.

Keep `ORDERBOOK_SHUTDOWN_TIMEOUT_MS` (default 10 s) below the container's
`stop_grace_period` (15 s in the supplied Compose file). A stop that runs out of
grace ends in `SIGKILL`, which leaves both lease files behind, and a replacement
in a fresh container then keeps refusing until the 90 second heartbeat lifetime
expires.

An older binary ignores these files, so leaving them in place is safe on a
rollback. They are also safe to leave inside a state backup: a restored
`.lock` from a dead process is recognised as stale, by its process id on the
same host or by its expired heartbeat otherwise.

### Concurrency bound for mutating requests

The book is one process, and every mutating request verifies an ML-DSA-87 proof
and joins a group commit, so there is a small number of them in flight past
which extra concurrency only lengthens the queue until requests reach
`ORDERBOOK_REQUEST_TIMEOUT_MS` (15 s by default). The service therefore bounds
how many it admits at once:

```dotenv
ORDERBOOK_MAX_INFLIGHT_MUTATIONS=32
```

Accepted range 1 to 1024, default 32. Beyond the bound a mutating request is
refused with `503`, `Retry-After: 1`, an `X-Refusal-Stage: pre-verification`
header and `order book has too many requests in flight, retry shortly`, before
the store is touched. Clients should retry after the named delay.

What the bound covers and what it does not:

- Gated: every mutating request, which is `POST`, `PUT`, `PATCH` and `DELETE`
  except `heartbeat`. `GET` and `HEAD` are reads and `OPTIONS` is answered
  before this point.
- Not gated: `GET /api/health`, `GET /api/status`, order views, the SSE stream
  and heartbeats, so a mutation rush no longer makes the probes unanswerable.
  The federation feed read has its own concurrency lane and keeps it.
- The slot is taken once the request body is in hand, so it covers verification
  and the group commit. Reading the body is bounded separately, below.
- A refused request leaves the source's per-minute mutation budget untouched.
  Only an admitted one is counted.
- It also bounds a group commit: at most this many mutations can be waiting for
  one, so the batch latency a mutation can inherit is two commits.

A share of the bound is reachable only by the maker write routes, which are
`POST /orders/signed`, `/cancel`, `/cancel/signed`, `/fill` and `/hashlock`:

```dotenv
ORDERBOOK_RESERVED_MAKER_MUTATIONS=8
```

Default 8, and it must stay below the bound itself; startup refuses a
reservation that would leave takers nothing. A taker rush is exactly what fills
the bound, and a maker who cannot withdraw a stale-priced order during one is
exposed on price.

What the reservation protects against is a taker rush, and nothing more. With
the defaults, takers share 24 slots and the remaining 8 are reachable only by a
caller that presents a maker capability, so no volume of taker traffic can take
them. It is not protection against a maker flooding its own lane, against many
makers competing for it, or against an attacker who holds a real maker token for
some order. Those are bounded by the per-source rate limit and the per-source
body-read share, the same as any other caller.

A request reaches the reserved lane by presenting the order's maker token in
`X-Maker-Token`, checked against the stored commitment before the body is read.
The header works on `/cancel` and `/hashlock` as well as on `/cancel/signed` and
`/fill`, and on those two legacy routes it also authorises the request, so the
admission decision and the authorisation agree about who is calling. A request
to a maker path without a valid token is a taker-lane request: keying the
reservation on the path alone would let anyone reach it by naming a maker route.

`POST /orders/signed` cannot be keyed that way, because the commitment it would
be checked against arrives inside the request. It gets half the reservation as a
sub-reserve of its own, so a signed-create flood cannot consume the headroom the
capability-authenticated routes need, and a repost still has somewhere to go
during a rush. The legacy unsigned `POST /orders` is outside the reservation
entirely: it carries no proof at all, so it is the cheapest route to flood.

The reference market maker posts one rung per pair and direction per tick, in
sequence, so it does not need a wide lane; it needs a lane that a rush cannot
close.

Raise the bound only with evidence: the queue it allows is paid in the latency
of every request in it. Lowering it sheds a rush earlier and also sheds
legitimate work, including a maker repricing a deep book inside one mutation
window. A deployment that serves a handful of makers and takers never reaches
the default.

### Body reads are bounded separately

A request that promises a body and sends it slowly, or never, must not hold a
mutation slot: a handful of those would refuse every writer for the whole
`ORDERBOOK_REQUEST_TIMEOUT_MS` while `/api/health` still reported ready. Body
reads therefore have their own bound, their own reservation and their own short
deadline:

```dotenv
ORDERBOOK_MAX_INFLIGHT_BODY_READS=256
ORDERBOOK_RESERVED_MAKER_BODY_READS=32
ORDERBOOK_BODY_READ_TIMEOUT_MS=3000
```

Ranges 8 to 4096, 0 to below the bound, and 250 ms to 60 s. At most 2
concurrent body reads come from one source, or 4 on the maker lane, because a
real client has one body in flight at a time. A body that misses the deadline is
answered `408 request body was too slow`, its remaining bytes are read and
discarded without being buffered, and the connection closes; the service request
timeout still closes the socket itself. Raise the deadline only for genuinely
slow clients on a slow link.

**The global body-read bound is a service-wide refusal point.** Once it is full
every further body of that lane is answered
`503 order book has too many request bodies in flight`, and a request whose body
cannot be read never reaches the mutation bound at all, so without the
reservation a flood of promised-and-unsent bodies would refuse the maker lane
too. The reservation is what keeps that lane reachable, and the same lane rules
apply: the maker share needs the order's capability in `X-Maker-Token`.

Watch it. The refusal is distinct from the in-flight one and carries
`X-Refusal-Stage: pre-verification`; the load harness reports it as
`book_body_read_gate` and the read deadline as `body_read_timeout`. A steady
stream of either from ordinary clients means the bound or the deadline is too
tight for the paths your visitors come over. A burst of them from many sources
at once is the flood this bound exists to absorb.

**A buffering reverse proxy removes this exposure entirely.** nginx buffers
request bodies by default (`proxy_request_buffering on`), so it forwards a
request only once the whole body has arrived and the book never sees a
half-open body. A mirror behind such a proxy is not exposed to this at all, and
these bounds are then a second line only. They matter for a book that is
reachable directly: a self-hosted mirror with no proxy in front, and the onion
profile, where Tor connects to the service without buffering. Putting nginx or
an equivalent buffering proxy in front is the recommended deployment either
way.

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
list. When the outbound list is set, every configured peer needs either a token
or the literal `-` public-lane sentinel. The onion-only profile in the next
section uses `-` for every peer.

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

## 4. Run the onion-only Tor profile

The optional `server/compose.tor.yaml` profile publishes the order-book API as
a v3 onion service and routes outbound onion federation pulls through the same
C Tor daemon. It is an onion-only topology. The merged Compose model attaches
the order-book container only to the internal `tor-socks` network, which gives
it no native DNS or direct Internet egress. Tor has a separate egress network.

The base order-book port is removed from that container. A small, separately
hardened administration proxy republishes it at
`127.0.0.1:${ORDERBOOK_PORT:-8091}` for local health checks and maintenance.
The Tor SOCKS port has no host publication. It listens only on the internal
network shared with the order book.

The Tor image is built locally from `server/tor/`. Its Debian base is pinned by
multi-architecture digest and its C Tor package is pinned to an exact version.
Tor and the administration proxy run as uid and gid 10001 with read-only root
filesystems, all capabilities dropped, and `no-new-privileges` enabled.

From `server/`, build the two local sidecars and start the merged model:

```bash
docker compose -f compose.yaml -f compose.tor.yaml build --pull tor admin-proxy
docker compose -f compose.yaml -f compose.tor.yaml up -d --no-build
docker compose -f compose.yaml -f compose.tor.yaml ps
docker compose -f compose.yaml -f compose.tor.yaml logs --tail=100 tor
curl --fail http://127.0.0.1:8091/api/health
```

Use only canonical 56-character v3 onion peers in this profile. Each aligned
token position is the literal `-`, which selects the public feed lane:

```dotenv
ORDERBOOK_FEDERATION_PEERS=http://<first-56-character-v3-host>.onion/api,http://<second-56-character-v3-host>.onion/api
ORDERBOOK_FEDERATION_PEER_IDS=onion-book-1,onion-book-2
ORDERBOOK_FEDERATION_PEER_TOKENS=-,-
ORDERBOOK_FEDERATION_ONION_ONLY=true
ORDERBOOK_FEDERATION_ALLOW_INSECURE_PEER_TOKENS=false
```

The overlay sets
`ORDERBOOK_FEDERATION_ONION_PROXY=socks5h://tor:9050`, fixes
`ORDERBOOK_FEDERATION_ONION_ONLY=true`, and fixes
`ORDERBOOK_FEDERATION_ALLOW_INSECURE_PEER_TOKENS=false`. An HTTP onion peer
never receives an application bearer token. Startup rejects every configured
peer that is not a canonical v3 onion URL. The `socks5h` route sends the
hostname to Tor. Direct and native-DNS fallbacks are unavailable.

### Verify the onion path

The persistent identity volume defaults to
`quantaswap-orderbook-tor-identity`. Set a stable custom name before first boot
when required:

```dotenv
ORDERBOOK_TOR_IDENTITY_VOLUME=quantaswap-orderbook-tor-identity
ORDERBOOK_TOR_DATA_VOLUME=quantaswap-orderbook-tor-data
```

The data volume retains Tor guard, consensus, and client state across container
recreation. Long-lived guard state is part of the onion service's network
privacy posture. Keep this volume private and reuse it with the identity
volume. The identity volume remains separate so its secret key can use the
narrow encrypted backup and restore procedure below.

Read the generated public hostname:

```bash
compose=(docker compose -f compose.yaml -f compose.tor.yaml)
onion_host=$("${compose[@]}" exec -T tor \
  cat /var/lib/quantaswap-tor/hidden-service/hostname)
printf '%s\n' "$onion_host"
```

The hostname must contain 56 lowercase base32 characters followed by
`.onion`. Probe the full orderbook-to-SOCKS-to-onion path from the order-book
container:

```bash
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

The expected result is `200 {"status":"ok"}`. Also wait for every configured
peer to become healthy:

```bash
curl --fail http://127.0.0.1:8091/api/status \
  | jq -e '.status == "ok" and .federation.state == "healthy"'
```

### Browser and rate-limit constraints

The overlay publishes the order-book API. It does not publish the reference
frontend as an onion site. Ordinary browsers cannot resolve `.onion`; use Tor
Browser or another explicitly Tor-aware client. A clearnet HTTPS frontend can
also be prevented from fetching an HTTP onion API by mixed-content, CSP, or
CORS policy. A browser onion deployment needs its own reviewed frontend,
origin, CSP, wallet, and RPC design.

Tor forwards every inbound onion stream from the sidecar's one internal IP.
The order book therefore sees all onion visitors as one source. They share the
per-source request limits, the 240 feed reads and four resets per minute, the
single public-feed response slot, SSE limits, and other source-scoped quotas.
One busy client can consume that shared allowance and cause `429` responses
for other onion users. Keep `ORDERBOOK_TRUST_PROXY=none`: Tor supplies no
authenticated original-client header. Monitor aggregate load, `429` responses,
feed health, and request latency. This profile is sized for bounded testnet
federation and direct operator probes.

### Encrypt and restore the onion identity

The named identity volume holds `hostname`, `hs_ed25519_public_key`, and
`hs_ed25519_secret_key`. Possession of the secret key permits impersonation of
the onion service. Loss of the key means loss of the hostname. Keep the backup
encrypted, restrict it like a wallet key, and store the OpenPGP recovery key in
a separate failure domain.

Stop Tor and stream the complete identity directory directly into OpenPGP
encryption. Replace the recipient placeholder with a reviewed fingerprint:

```bash
set -euo pipefail
compose=(docker compose -f compose.yaml -f compose.tor.yaml)
compose_json=$("${compose[@]}" config --format json)
tor_image=$(jq -er '.services.tor.image' <<<"$compose_json")
tor_image_id=$(docker image inspect --format '{{.Id}}' "$tor_image")
identity_volume=$(jq -er '
  .services.tor.volumes[]
  | select(.target == "/var/lib/quantaswap-tor/hidden-service")
  | .source
' <<<"$compose_json")
docker volume inspect "$identity_volume" >/dev/null
offline_run=(
  docker run --rm --network none --read-only
  --cap-drop ALL --security-opt no-new-privileges:true
  --pids-limit 32 --user 10001:10001
)
tor_needs_start=true
trap 'if [ "$tor_needs_start" = true ]; then "${compose[@]}" start tor; fi' EXIT
"${compose[@]}" stop tor
"${offline_run[@]}" \
  --mount "type=volume,src=$identity_volume,dst=/var/lib/quantaswap-tor/hidden-service,readonly" \
  --entrypoint sh "$tor_image_id" -ec '
    test -s /var/lib/quantaswap-tor/hidden-service/hostname
    test -s /var/lib/quantaswap-tor/hidden-service/hs_ed25519_secret_key
  '
mkdir -p ./backups
umask 077
gpg_recipient=replace-with-reviewed-key-fingerprint
backup_file="./backups/onion-identity-$(date -u +%Y%m%dT%H%M%SZ).tar.gz.gpg"
if ! "${offline_run[@]}" \
    --mount "type=volume,src=$identity_volume,dst=/var/lib/quantaswap-tor/hidden-service,readonly" \
    --entrypoint tar "$tor_image_id" \
      -C /var/lib/quantaswap-tor/hidden-service -czf - . \
    | gpg --batch --yes --encrypt --recipient "$gpg_recipient" \
        --output "$backup_file"; then
  rm -f "$backup_file"
  exit 1
fi
if ! gpg --batch --pinentry-mode error --list-only --decrypt "$backup_file" >/dev/null; then
  rm -f "$backup_file"
  exit 1
fi
"${compose[@]}" start tor
tor_needs_start=false
trap - EXIT
```

Periodically prove that the recovery key can decrypt and parse the archive:

```bash
set -o pipefail
gpg --decrypt "$backup_file" | tar -tzf - >/dev/null
```

Restore into a new named volume so the current identity remains available for
rollback. The target name in this example must not already exist:

```bash
set -euo pipefail
compose=(docker compose -f compose.yaml -f compose.tor.yaml)
compose_json=$("${compose[@]}" config --format json)
tor_image=$(jq -er '.services.tor.image' <<<"$compose_json")
tor_image_id=$(docker image inspect --format '{{.Id}}' "$tor_image")
offline_run=(
  docker run --rm --network none --read-only
  --cap-drop ALL --security-opt no-new-privileges:true
  --pids-limit 32 --user 10001:10001
)
backup_file=./backups/onion-identity-YYYYMMDDTHHMMSSZ.tar.gz.gpg
restore_volume=quantaswap-orderbook-tor-identity-restore-YYYYMMDD
if docker volume inspect "$restore_volume" >/dev/null 2>&1; then
  echo "restore volume already exists" >&2
  exit 1
fi
gpg --decrypt "$backup_file" | tar -tzf - >/dev/null
docker volume create "$restore_volume" >/dev/null
restore_complete=false
trap 'if [ "$restore_complete" = false ]; then docker volume rm "$restore_volume" >/dev/null 2>&1 || true; fi' EXIT
gpg --decrypt "$backup_file" \
  | "${offline_run[@]}" --interactive \
      --mount "type=volume,src=$restore_volume,dst=/var/lib/quantaswap-tor/hidden-service" \
      --entrypoint tar "$tor_image_id" \
        -C /var/lib/quantaswap-tor/hidden-service -xzf -
"${offline_run[@]}" \
  --mount "type=volume,src=$restore_volume,dst=/var/lib/quantaswap-tor/hidden-service,readonly" \
  --entrypoint sh "$tor_image_id" -ec '
      test "$(stat -c %a /var/lib/quantaswap-tor/hidden-service)" = 700
      test "$(stat -c %a /var/lib/quantaswap-tor/hidden-service/hs_ed25519_secret_key)" = 600
      grep -Eq "^[a-z2-7]{56}\\.onion$" \
        /var/lib/quantaswap-tor/hidden-service/hostname
  '
restore_complete=true
trap - EXIT
```

The restore volume is created empty. Its first mount uses the exact Tor image
at the image's pre-created identity path, so Docker initializes the volume with
the path's uid 10001 ownership and mode 0700 before the non-root extraction.
Every backup, extraction, and verification helper uses `--network none`, a
read-only root filesystem, no Linux capabilities, and
`no-new-privileges`. The backup volume is mounted read-only, and decrypted
archive bytes travel only through the pipe into the new volume.

Record `ORDERBOOK_TOR_IDENTITY_VOLUME=$restore_volume` in `.env`, stop the
current Tor container, and start the merged Compose model. Confirm that the
hostname matches the recorded original, repeat the onion probe, and retain the
previous volume until the recovery observation window ends.

### Privacy boundary and Tor guidance

This profile routes only the mirror's onion-service traffic and onion
federation pulls. The browser, wallet extension, market maker, chain indexer,
and their Ethereum and QRL RPC calls have separate network paths. Wallet
addresses, amounts, HTLC calls, transaction hashes, and timing remain public on
their respective chains. RPC and wallet providers can observe their own
requests and may correlate them with public transactions. Tor transport for the
order book does not create on-chain anonymity.

Read the Tor Project's [onion-service setup and key
guidance](https://community.torproject.org/onion-services/setup/), [onion
service overview](https://community.torproject.org/onion-services/overview/),
[Tor Browser onion-service
guide](https://support.torproject.org/tor-browser/features/onion-services/),
and [onion-service operational security
guidance](https://community.torproject.org/onion-services/advanced/opsec/).

## 5. Bootstrap two independent mirrors

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

## 6. Monitor the right signals

Use both endpoints:

- `/api/health` is local readiness. Alert immediately on non-200.
- `/api/status` is diagnostic. Alert when top-level `status` is not `ok`, when
  `feed.ready` is false, when `lease.ready` is false, or when a configured peer
  remains `degraded` or `stale` beyond your incident window.

Watch the `503` rate on mutating routes as well. A sustained stream of
`order book has too many requests in flight` means demand is past
`ORDERBOOK_MAX_INFLIGHT_MUTATIONS`. That is a capacity signal: the book is
shedding on purpose and its reads and probes are still being served.

A `lease.ready` of false means writes are being refused while reads still
serve. Treat a repeated occurrence as a storage fault on the state volume.
`lease.lost` is true only while the process is already shutting down after
another process took its data over; a restart loop with
`FATAL: cannot take the single-writer lease` in the logs means two deployments
point at one volume.

Peer outages do not change local readiness. That prevents a remote failure from
causing restart loops while still making incomplete discovery visible. Status
contains no URL, cursor, feed id, raw error, state path, order, account, or
capability. Timestamp fields are Unix milliseconds.

Also monitor HTTPS from a different network. A loopback-only health check cannot
detect DNS, CDN, certificate, firewall, or reverse-proxy failures.

## 7. Back up, update, and roll back

The named volume contains `orders.json` plus `orders.json.federation`, and,
while the service runs, a `.lock` file beside each of them. Stop the service and
stream a consistent archive directly into GPG encryption. A clean stop removes
both lease files first, so a snapshot taken this way holds only the two data
files. Replace
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
if ! gpg --batch --pinentry-mode error --list-only --decrypt "$backup_file" >/dev/null; then
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
removed. The noninteractive
`gpg --batch --pinentry-mode error --list-only --decrypt` check confirms that
the output is decryptable by an available key without opening pinentry. It does
not prove that the interactive passphrase path can restore the archive.
Periodically run a
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

Rolling back to an image from before the single-writer lease needs no cleanup.
That binary never reads `orders.json.lock` or `orders.json.federation.lock` and
leaves them untouched, and a later roll forward treats whatever it finds there
as a stale lease. The one thing a rollback gives up is the protection itself:
the older binary starts even when another process is already writing the same
volume.

## 8. Add the mirror to a browser build

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
