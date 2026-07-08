// Live smoke test against a deployed HTLC on the Ethereum leg (Sepolia):
// lockNative a dust amount to self, claim it, verify status + preimage.
// Usage: node scripts/smoke-eth.js <htlc-address>
// Required env (.env): ETH_RPC_URL, ETH_PRIVATE_KEY

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const rpc = process.env.ETH_RPC_URL;
const key = process.env.ETH_PRIVATE_KEY;
const htlcAddress = process.argv[2];
if (!rpc || !key || !htlcAddress) {
  console.error("usage: ETH_RPC_URL=.. ETH_PRIVATE_KEY=.. node scripts/smoke-eth.js <htlc-address>");
  process.exit(1);
}

const artifactPath = path.join(__dirname, "..", "build", "hyperion", "HTLC.json");
const { abi } = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

async function main() {
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(key, provider);
  const htlc = new ethers.Contract(htlcAddress, abi, wallet);

  const preimage = ethers.hexlify(ethers.randomBytes(32));
  const hashlock = ethers.sha256(preimage);
  const timeout = Math.floor(Date.now() / 1000) + 3600;

  console.log(`[smoke-eth] account ${wallet.address}, htlc ${htlcAddress}`);
  console.log(`[smoke-eth] hashlock ${hashlock}`);

  console.log("[smoke-eth] lockNative 1000 wei, recipient self, timeout +1h");
  const lockTx = await htlc.lockNative(hashlock, wallet.address, timeout, { value: 1000n });
  console.log(`[smoke-eth] lock tx ${lockTx.hash}`);
  await lockTx.wait();

  let swap = await htlc.getSwap(hashlock);
  if (swap.status !== 1n) throw new Error(`expected Open(1), got ${swap.status}`);

  console.log("[smoke-eth] claim with preimage");
  const claimTx = await htlc.claim(hashlock, preimage);
  console.log(`[smoke-eth] claim tx ${claimTx.hash}`);
  await claimTx.wait();

  swap = await htlc.getSwap(hashlock);
  if (swap.status !== 2n) throw new Error(`expected Claimed(2), got ${swap.status}`);
  if (swap.preimage.toLowerCase() !== preimage.toLowerCase()) throw new Error("preimage mismatch");

  console.log("[smoke-eth] PASS: lock -> claim round trip verified on-chain");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
