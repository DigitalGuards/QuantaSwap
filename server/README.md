# QuantaSwap self-hosted order book

This package runs the protocol-mode coordination service. It discovers and
reserves orders but never holds funds, signs transactions, chooses recipients,
or decides whether an on-chain lock is valid. Every client must continue to
verify all economic and settlement facts against the HTLCs.

**Testnet only.** This image packages one independent book. It verifies and
stores portable maker-signed OrderV1 objects, but mirror federation and signed
cancellation tombstones are separate milestones; running this package does not
by itself create a federated venue.

## What the package provides

- a multi-stage image built from a digest-pinned Node base and npm lockfile;
- a non-root, read-only runtime with all Linux capabilities dropped;
- a persistent named volume for atomic mode-0600 order state;
- fail-closed startup if persisted JSON is unreadable or structurally invalid;
- bounded SSE backpressure, request deadlines, and graceful shutdown;
- explicit reverse-proxy trust instead of unconditional forwarded headers;
- global, per-maker, per-source, rate, take, and stream-connection limits;
- a storage-aware `/api/health` endpoint;
- dual-scheme ML-DSA-87 OrderV1 verification for MyQRLWallet and the official
  QRL Web3 Wallet, with browser-side verification before a take.

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

The `quantaswap-orderbook-state` volume holds `orders.json`. It contains hashed
bearer tokens and client IPs, public and private order terms, and taker
addresses. It is not signing-key material, but it is still private operational
data. Encrypt backups and restrict access.

For a consistent snapshot:

```bash
docker compose stop orderbook
mkdir -p ./backups
docker compose cp orderbook:/var/lib/quantaswap-orderbook/orders.json ./backups/orders.json
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
