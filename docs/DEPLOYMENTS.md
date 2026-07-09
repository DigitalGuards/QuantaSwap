# Deployments

## Testnet, 2026-07-08

One hypc-compiled artifact deployed to both chains, byte-identical runtime (2797 bytes).
Compiler: native `hypc` 0.2.0-develop.2026.4.13+commit.d5d1b977, optimizer enabled, 200 runs.

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

## Order book service (quantaswap.io)

Runs on the `78.47.166.153` box next to the frontend webroot. Coordination only, never custody; losing it strands no funds.

```bash
# one-time setup as ops
cd ~/quantaswap-orderbook   # clone or rsync of server/
npm install && npm run build
pm2 start dist/server.js --name quantaswap-orderbook
pm2 save
```

Defaults: `PORT=8091` (binds 127.0.0.1 only), data file `server/data/orders.json` (override with `ORDERBOOK_DATA`).

nginx vhost addition (same-origin, alongside the existing `/rpc/*` proxies):

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:8091;
    proxy_http_version 1.1;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;
}
```

Health check: `curl -s https://quantaswap.io/api/health` returns `{"status":"ok"}`.
