# Deployments

## HTLCv3, deployed 2026-09-27, current

HTLCv3 (issue #47: payout credits, see [`docs/audit/HTLCV3_SCOPE.md`](audit/HTLCV3_SCOPE.md))
is deployed on both legs from the qualified artifacts of source bundle
`674904c7df7b56db0d88c99539ffd7edc7f7990f7e6df5e7a18f3c7324c37ca5`. Both deployed
runtimes matched their qualified artifacts at deploy time (EVM 5,212 bytes, QRVM-512
6,225 bytes).

| Leg | Chain ID | HTLCv3 address | Deploy transaction |
|---|---|---|---|
| QRL private v3 | `3151909` | `QBFe68340591f82a68C2258FA2cE7C02Be21E5fc7Bb71615B56a509db4985e863D9243B74da6335C065e257A01d40354653E551907338DBDc7A6b342ea2274437` | `0x9e91eece45845e4527575d54df223923b5a1bb27b4ce2cd7357b87af6700debf` |
| Ethereum Sepolia | `11155111` | `0xCD5Aa74452cC29e73C6e52591b3b54D775C683e4` | `0xcaa1acb4ff58ac0a64db74001e83fdb8ac5cb036cc4bca6401f402047168a479` |

Deploy with `HTLC_CONTRACT=HTLCv3 npm run deploy:eth` and
`HTLC_CONTRACT=HTLCv3 npm run deploy:qrl` after `npm run compile`.

### Which configuration field flips a client to HTLCv3

[`config/protocol-v2.json`](../config/protocol-v2.json) carries the whole cutover:

| Field | HTLCv2 (history) | HTLCv3 (current) |
|---|---|---|
| `htlcInterface` | absent | `"v3"` |
| `ethHtlc` | `0x4D9D3adAe3e479CA8a9e13c6E5eE4E4E7Bc4f9B5` | `0xCD5Aa74452cC29e73C6e52591b3b54D775C683e4` |
| `qrlHtlc` | `Q71D5194Eaa...580D05405` | `QBFe6834059...ea2274437` |

`htlcInterface` is the marker every client asserts at load: the browser, the order
book, the market maker and the scripted taker all refuse to start against a profile
whose interface is not the one they were built for. The addresses are signed into
every portable V2 order, so the three fields move as one: changing them rotates the
signing domain, which is why `config/protocol-v2-vectors.json` carries HTLCv3-bound
digests and why a mixed-version pair of clients cannot agree on an order.

### What happens to open HTLCv2 orders and in-flight HTLCv2 swaps

Nothing migrates, and no record is ever reinterpreted against the new address.
Every client keys its swap state on the HTLC addresses it was created against
and keeps claiming or refunding at those addresses until the record is
terminal:

- The browser namespaces all local swap state on both HTLC addresses, so an
  HTLCv2 record stays in place under its own key and the HTLCv3 build simply
  does not see it. Reopening the previous release, which carries the HTLCv2
  profile, settles or refunds it.
- The reference maker and the scripted taker write the deployment identity into
  their state files and refuse to start against a file from another deployment,
  leaving the file untouched and naming the remedy in the error: run the
  original configuration to settle or refund those orders.
- Open HTLCv2 orders on the book cannot be taken by an HTLCv3 client at all,
  because the signing domain changed: an HTLCv2 order fails verification under
  the HTLCv3 domain and the reverse. They expire on their own signed expiry.

### The cutover procedure

Drain first, then flip. Per component, in order:

1. **Drain the maker to zero.** Set `MM_DRAIN=true` and restart it. It cancels
   its open listings, posts no replacements, and settles what is in flight.
   Wait until `managedOrders` in its health snapshot reads 0 and
   `strandedCredits` reads 0. A parked credit is a payout the contract refused
   often enough, over long enough, that the maker stopped trying; it is
   recorded in the state file, listed in the log at every start, and re-read
   hourly. `strandedCredits` counts only this maker's own payouts, which are
   collectable: collect each under the current configuration before going on,
   because the new profile will not see it. `parkedCounterpartyCredits` counts
   courtesy pushes to a taker's address that refused the payout, which only that
   address can ever receive, so they do not gate this step; dismiss them if you
   want them out of the report. `marketmaker/README.md` has both procedures.
2. **Stop the maker.**
3. **Move its state file aside**, or point `MM_STATE_FILE` at a new path. A
   state file records the deployment its records settle on, and the daemon
   refuses to start against one from another deployment even when it is empty.
   Keep the old file: it is the recovery material for anything that turns out
   to be unfinished.
4. **Deploy the order book, then the maker, then the frontend**, each carrying
   the new `config/protocol-v2.json`. The book goes first because it is the
   verifier: on the HTLCv3 domain it rejects HTLCv2 orders, so a mixed pair
   cannot form.
5. **Confirm the maker's boot check.** It reads `deliveryGasPolicy()` on both
   legs and refuses to start if either answers anything but the budget it was
   built for, so a clean boot is itself the check that the addresses are the
   HTLCv3 ones.
6. **Serve the previous release at `/v2/`** for anyone whose swap started
   before the cutover (below), and keep it up until nothing is left to recover.

The scripted taker follows the same shape with its own state file; see
[TAKERS.md](TAKERS.md).

### Recovering a swap started before the cutover

Browser swap state is scoped to the origin and namespaced on both HTLC
addresses, so an HTLCv2 record is still in local storage after the cutover,
under its own key, and the HTLCv3 build does not read it. Building the previous
release with `VITE_BASE_PATH=/v2/` and serving it beside the current one on the
same origin gives those records their own release back, with no migration and
no in-app scanner. The current build links to it from the footer, which
`VITE_LEGACY_RELEASE_PATH` configures.

Anything still in flight at the moment of the flip is therefore settled with
the release it was created under, which is the configuration that knows its
contracts.

## Private v3 testnet release, 2026-09-21 (HTLCv2, superseded by HTLCv3 above)

This deployment used Sepolia and the private QRL v3 testnet with the HTLCv2
open-recipient contract. QRL network v3, the HTLC contract interface, and portable
signing wire V2 are separate versioned interfaces. The public deployment source of
truth is [`config/protocol-v2.json`](../config/protocol-v2.json); these addresses are
kept here as history and as the settlement target of any swap record that still names
them.

| Leg | Chain ID | HTLC address | Deploy transaction |
|---|---|---|---|
| QRL private v3 | `3151909` | `Q71D5194EaaBF33e753b9F5ae7375C9c77F063Ed0CB2908De65D0ba00354da0bf40403Eb0247A536760625Ca6AB9bBB58B875A72c8DCdB67FEDA2266580D05405` | `0x83aa79c2a47dc5385a61e6657d7da8db059e19120a26352a57f76124bedd8e66` |
| Ethereum Sepolia | `11155111` | `0x4D9D3adAe3e479CA8a9e13c6E5eE4E4E7Bc4f9B5` | `0xd593f7ab2394008a7735f06f4255c21f3a25748ccf15100da002e0ab375c5738` |

The QRL genesis is pinned to
`0xd15407991193e6c23b733dc6bf9c628deaff8f9b6e252aa0d60030952b3e3ea4`.
Clients verify both chain ID and genesis before QRL operations. QRL accounts and
contract addresses contain 64 bytes, represented as uppercase `Q` plus 128 hexadecimal
characters. Ethereum retains 20-byte addresses.

Both deployed runtimes exactly match their target-bound compiled artifacts:

| Artifact | SHA-256 |
|---|---|
| Reviewed source bundle | `089e8775ac06c6c01ecc930da9985f3c278a194a1e611f1030ed571d9261108f` |
| Ethereum runtime | `9ad68221efceaf9f958d96a9f650946f6fce37f2ddcaf12e2b6194d7578a5e8f` |
| QRL runtime | `7d9b70ef0d4a427f357a721b9c897cc253abaff077465cbcd8513a696cd70903` |

Portable V2 uses `qrl_signMessage` and a fixed ordered-message encoding that binds
both chain IDs, both HTLCs, and the QRL genesis. The browser pins Connect SDK 5.0.1
for explicit transaction-chain checks; the order book and market maker retain
SDK 5.0.0 for their signing and verification helpers. The browser,
order book, and market maker reject V1 proofs. Previous deployment records remain
separate recovery data and are never automatically migrated into this deployment.

### Target-bound build

The current reviewed Hyperion source builds into two target-bound artifacts. Ethereum uses the
EVM-256 compiler target at `build/hyperion/evm/HTLC.json`; QRL uses the QRVM-512 Q128 target at
`build/hyperion/qrl/HTLC.json`. Both builds enable the optimizer at 200 runs and `viaIR: true`.

Source-bundle note: `contracts/hyperion/` also holds `HTLCv3.hyp`, which the current
clients settle against (issue #47, see [audit/HTLCV3_SCOPE.md](audit/HTLCV3_SCOPE.md)).
Its target-bound artifacts are `build/hyperion/{evm,qrl}/HTLCv3.json`. The bundle hash covers every
source in that directory, so it moved to
`674904c7df7b56db0d88c99539ffd7edc7f7990f7e6df5e7a18f3c7324c37ca5`. `HTLC.hyp` itself is
unchanged, and the two deployed runtime hashes above still reproduce byte for byte from the
current tree, which is what verifies the live contracts.
Their manifests require the same source-bundle hash and ABI, and record distinct compiler versions,
address widths, runtimes, and bytecode hashes. Deployment and smoke scripts load only the artifact
for their named chain and reject a mismatched manifest or artifact before network traffic.

The deployed artifacts above use this build boundary. The July deployments below
are historical and must not be selected for new v3 orders.

## Historical testnet, 2026-07-13 (HTLCv2 open-recipient locks / prelock)

One hypc-compiled artifact deployed to both chains, byte-identical runtime (4136 bytes).
Adds open-recipient locks over the 2026-07-12 artifact: `lockNativeOpen` / `lockTokenOpen`
(escrow with the recipient unset), one-time initiator-only `assign(hashlock, recipient)`, and
initiator-only `release(hashlock)` while unassigned; `claim` now reverts `NotAssigned` on an
unassigned lock. Classic entrypoints and settled-swap semantics are byte-for-byte unchanged.

| Leg | Chain | Contract | Address | Deploy tx |
|---|---|---|---|---|
| QRL | QRL v2 testnet (1337) | HTLC | `Q238322ad2e8f935b4481fcc379779c31b84decb0` | `0x4f670352c0651362dfafe49786f27dc981175579739dddf83c2cb2411218e6e4` |
| Ethereum | Sepolia (11155111) | HTLC | `0x910D5d4a7f2037c01F3B4C835167357e89909281` | `0x04d80973404a491c6bb883179f56012423ccd92bda9874a4812e6fa6904211a9` |

The tUSDT faucet (`0x027847Dc41C7a3198a28B9c7B27B5a0BC5bD23A0`, Sepolia) is a separate contract,
unchanged by this redeploy and carried forward. Deployers unchanged:
`Q6153d37Fa4DA7193E6219DCBd2bBe62Fa12905b1` (QRL leg),
`0x035F07bCb487E51547417dEC7664b013a11Ef234` (Sepolia leg).

### Post-deploy smokes, 2026-07-13

Native lock -> claim on both legs, plus the v2 surface (open-lock -> assign -> claim, and
open-lock -> release), status/preimage/balances verified on-chain.

| Path | Tx |
|---|---|
| QRL native claim (0.001 QRL) | `0x14c2d2b9fe0ac104cb904d975a6c73d04c27781112be49dc9d3a7298297b081f` |
| Sepolia native claim (1000 wei) | `0x84e20696b860e55e701941d31082a6fdb2ea6f32552bbf5ae10fd388dc57bebb` |
| QRL prelock: assign -> claim | `0x65b4ef7ecca81412737fc65c5df9bdab68629e9fd3e69736b7d5934e7a1df988` |
| QRL prelock: open -> release | `0x2b526c371dd9af3f588478f2da528e6a77fd7692eda076801bd438df65ecb705` |
| Sepolia prelock: open -> release | `0x009d8459d5e7f8bd8d78ae499f7bd670c7b156578093e776c0f5a663b114e66f` |

```bash
node scripts/smoke-qrl.js Q238322ad2e8f935b4481fcc379779c31b84decb0
node scripts/smoke-eth.js 0x910D5d4a7f2037c01F3B4C835167357e89909281
node scripts/smoke-prelock.js qrl Q238322ad2e8f935b4481fcc379779c31b84decb0
node scripts/smoke-prelock.js eth 0x910D5d4a7f2037c01F3B4C835167357e89909281
node scripts/smoke-eth-erc20.js 0x910D5d4a7f2037c01F3B4C835167357e89909281 0x027847Dc41C7a3198a28B9c7B27B5a0BC5bD23A0  # tUSDT
```

## Testnet, 2026-07-12 (stablecoin artifact, superseded 2026-07-13; HTLC only)

One hypc-compiled artifact deployed to both chains, byte-identical runtime (3088 bytes).
Compiler: native `hypc` 0.2.0-develop.2026.4.13+commit.d5d1b977, optimizer enabled, 200 runs.
Adds the `lockToken` received-amount check (`UnsupportedToken`) over the 2026-07-08 artifact.

| Leg | Chain | Contract | Address | Deploy tx |
|---|---|---|---|---|
| QRL | QRL v2 testnet (1337) | HTLC | `Qde1f2a65b0889bcb3f2ce271e8c6d1711425cf13` | `0xba8b05615c15854466eb6321326f13d6ced789c3bef482631971a2c0975106b8` |
| Ethereum | Sepolia (11155111) | HTLC | `0x31993bB91ECeD6141a1667c072f214C8DF20f7DB` | `0xfbbccb70350614cb11bac396a274a76147bf7b8f77bff5c8c6b71c5362692d5a` |
| Ethereum | Sepolia (11155111) | TestStable (tUSDT faucet) | `0x027847Dc41C7a3198a28B9c7B27B5a0BC5bD23A0` | `0x73420889a8c387fdbeeb9c65f9d3385945b78ca355243e909ac908b1ecabe85f` |

Deployers unchanged: `Q6153d37Fa4DA7193E6219DCBd2bBe62Fa12905b1` (QRL leg), `0x035F07bCb487E51547417dEC7664b013a11Ef234` (Sepolia leg).

### Post-deploy smokes, 2026-07-12 (live lock -> claim round trips, status + preimage + balances verified)

| Path | Claim tx |
|---|---|
| QRL native (0.001 QRL) | `0xf6cac45501ef77c4eb4d65c33242663cacc5cb7af4e47e4b5052163dd538cbb6` |
| Sepolia native (1000 wei) | `0xc7c485adac4e74e0e96de478a4dd98f87234249eed3a412c24e31d2e92e4f29c` |
| Sepolia USDC (0.1 USDC, lockToken) | `0x63f464eff6b0ce13c4b20149c026abd48c590e5a3f93abb541768b68d6f391b7` |
| Sepolia tUSDT (0.1 tUSDT, lockToken + approval-race flow) | `0x924ab43e5a362fbea206034895324e3cba5f19343b0b417a0b33c723acecb00e` |

```bash
node scripts/smoke-qrl.js Qde1f2a65b0889bcb3f2ce271e8c6d1711425cf13
node scripts/smoke-eth.js 0x31993bB91ECeD6141a1667c072f214C8DF20f7DB
node scripts/smoke-eth-erc20.js 0x31993bB91ECeD6141a1667c072f214C8DF20f7DB 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238  # USDC
node scripts/smoke-eth-erc20.js 0x31993bB91ECeD6141a1667c072f214C8DF20f7DB 0x027847Dc41C7a3198a28B9c7B27B5a0BC5bD23A0  # tUSDT
```

## Testnet, 2026-07-08 (superseded)

Kept for the record: swaps opened on these addresses settle there. Runtime 2797 bytes (no
received-amount check); safe for native and WETH, do not point clients at it for stables.

| Leg | Chain | HTLC address | Deploy tx |
|---|---|---|---|
| QRL | QRL v2 testnet (1337) | `Q94cd8e406d2bb4ea251dce3f0558941f2ac056ee` | `0xc566f50e388bf67dd37532f3a728d35971618f6389a2215bcffa731f8a5dd44c` |
| Ethereum | Sepolia (11155111) | `0x805100Fa4310B9c0dbb0754E14CbDe827E3b8a3c` | `0x88c16f9f0b094f23fbccff709c01206d66ef2ce3629ebe1e0f843af67e8e4b74` |

Deployers: `Q6153d37Fa4DA7193E6219DCBd2bBe62Fa12905b1` (QRL leg), `0x035F07bCb487E51547417dEC7664b013a11Ef234` (Sepolia leg).

### Post-deploy smoke (live lock -> claim round trip, status + stored preimage verified)

| Leg | Lock tx | Claim tx |
|---|---|---|
| QRL (0.001 QRL) | `0x355eb4bde5174fd40d8d5cc65b176a182b937a87d7fac8a05d065c6ce9e902f1` | `0x0e4f5e5c00fe0480b1b5bd0a87df589dff0107acf5f05305bcb634c545106506` |
| Sepolia (1000 wei) | `0x3db0fbba8e07d3f67905d66a2d8a596d31a3afd560742078983f7cb5f67e9e19` | `0x28665bc7efc130d5c2d2473d2ae1b0a22b956a064b665c0147a8a02e252ef50a` |

Rerun the smokes any time:

```bash
node scripts/smoke-qrl.js Q94cd8e406d2bb4ea251dce3f0558941f2ac056ee
node scripts/smoke-eth.js 0x805100Fa4310B9c0dbb0754E14CbDe827E3b8a3c
```

## Live services (quantaswap.io)

- **Order book**: coordination only, never custody; losing it strands no funds.
  Same-origin behind `/api`; health check: `curl -s https://quantaswap.io/api/health`
  returns `{"status":"ok"}`. Full API reference: [ORDERBOOK_API.md](ORDERBOOK_API.md).
  Independent operator packaging and recovery guidance:
  [`../server/README.md`](../server/README.md).
- **Market maker** (`marketmaker/`): an always-online protocol-mode maker that keeps
  the book stocked so visitors always have takeable orders. It is an ordinary maker
  driving the public protocol: killing it strands no one (in-flight swaps settle via
  the HTLC windows; its open orders expire off the book). Policy defaults live in
  `marketmaker/src/config.ts` and are documented in `marketmaker/.env.example`;
  anyone can run their own; see [LIQUIDITY_PROVIDERS.md](LIQUIDITY_PROVIDERS.md).
- The operational runbook (server layout, deploy procedure, production tuning) lives
  outside the repo.

## Stablecoin pairs (QRL/USDC, QRL/tUSDT)

Shipped 2026-07-12: contracts, tUSDT, and inventory are live (tables above);
the frontend, order book, and market maker carry the asset dimension (symbol
strings `ETH | USDC | tUSDT` on the wire, base-unit amounts, registry-resolved
token addresses verified on-chain by every client). The MM stocks QRL/USDC
(CoinGecko usd-coin/qrl cross mid); QRL/tUSDT has no MM liquidity, the tUSDT
faucet (`faucet()` on the token, 10,000 per call) makes it self-serve for
testing the USDT approval-race path.

Cutover note (2026-07-12): HTLC addresses changed with this rollout. Swaps
opened on the 2026-07-08 contracts settle there (records do not migrate); the
old MM listings were cancelled at cutover and in-flight swaps drained before
the restart. USDC more fundable at faucet.circle.com if inventory runs dry.
