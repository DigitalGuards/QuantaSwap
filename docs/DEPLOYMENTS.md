# Deployments

## Testnet, 2026-07-12 (stablecoin artifact, CURRENT)

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
