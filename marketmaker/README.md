# QuantaSwap self-hosted LP kit

This package runs the reference QuantaSwap protocol-mode market maker with
operator-owned wallets and inventory. It uses the same public order-book and
HTLC protocol as the browser maker. It does not grant an operator any protocol
privilege, custody user funds, or share keys with another LP.

**Testnet only.** QuantaSwap has not completed a real-value deployment review.
Use only Sepolia ETH/tokens and QRL v2 testnet funds until that milestone is
explicitly closed in the project release notes.

## What the kit provides

- a multi-stage image built from a digest-pinned Node base and `npm ci` lockfile;
- a non-root, read-only runtime with all Linux capabilities dropped;
- independent ETH and QRL wallet generation without printing either secret;
- read-only secret mounts instead of secrets baked into the image;
- a persistent, deployment-bound state volume for swap recovery;
- a localhost-only health endpoint that reports progress without addresses,
  balances, endpoint URLs, order ids, raw errors, or key material.

The container packages the existing maker. It does not change pricing, reserve,
confirmation, timeout, or swap decision behavior.

## QRL network compatibility gate

The current QRL v2 testnet deployment uses 20-byte Q addresses and therefore
pins `@theqrl/web3` to `0.4.4`. Web3 1.x intentionally derives 64-byte Q
addresses: it produces a different account from the same extended seed, rejects
the current short HTLC address, and the current node rejects its long account
address. Do not override this pin merely to clear a dependency scanner finding.

The upgrade belongs to the network cutover. Drain every existing maker, preserve
its old recovery environment, deploy fresh HTLCs for the new address model,
regenerate or explicitly migrate operator wallets, and repeat signed transaction
and refund recovery tests before accepting any inventory on web3 1.x.

## Prerequisites

- Docker Engine with Compose v2;
- Node.js 20 or newer for the one-time key bootstrap;
- reachable order-book, Ethereum RPC, and QRL RPC endpoints;
- independent testnet capital for both legs and gas.

Use RPC endpoints you trust. Claim simulation necessarily discloses a preimage
to the configured RPC immediately before broadcast. The order book remains a
coordination service and must never be trusted as proof of on-chain state.

## Verified image releases

Maintainers publish `linux/amd64` and `linux/arm64` images to
`ghcr.io/digitalguards/quantaswap-marketmaker` from exact
`marketmaker-vMAJOR.MINOR.PATCH` tags. The tag must match the version in
`package.json`, and its commit must already be reachable from `dev`. The release
workflow reruns the locked tests and dependency audit before publishing. It
attaches an SBOM and maximum-mode build provenance, creates a GitHub artifact
attestation, and signs the immutable image digest with Sigstore keyless signing.

For production-like testing, pin the digest printed in the successful release
workflow rather than relying on a mutable tag:

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

The local Compose file builds from source by default. An operator who selects a
published image should replace its `build` entry only after reviewing the
release digest, signature identity, attestation, SBOM, and migration notes.

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
controls or independently trusts.

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

## State and recovery

The named volume `quantaswap-lp-state` contains `state.json`. That file can hold
live order bearer tokens and unrevealed swap preimages. Treat it as a secret.
Every record is bound to both chain ids and both HTLC addresses. A mismatch is
refused without modifying the file.

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
