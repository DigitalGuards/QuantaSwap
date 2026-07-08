// Live smoke test against a deployed HTLC on QRL v2 testnet:
// lockNative a dust amount to self, claim it, verify status + preimage.
// Usage: node scripts/smoke-qrl.js <htlc-address>
// Required env (.env): QRL_RPC_URL, QRL_HEXSEED

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Web3 } = require("@theqrl/web3");

const rpc = process.env.QRL_RPC_URL;
const hexseed = process.env.QRL_HEXSEED;
const htlcAddress = process.argv[2];
if (!rpc || !hexseed || !htlcAddress) {
  console.error("usage: QRL_RPC_URL=.. QRL_HEXSEED=.. node scripts/smoke-qrl.js <htlc-address>");
  process.exit(1);
}

const artifactPath = path.join(__dirname, "..", "build", "hyperion", "HTLC.json");
const { abi } = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

const web3 = new Web3(new Web3.providers.HttpProvider(rpc));
const acc = web3.qrl.accounts.seedToAccount(hexseed);
web3.qrl.wallet?.add(hexseed);
web3.qrl.transactionConfirmationBlocks = 1;

// contract.methods.*.send() routes to node-side qrl_sendTransaction and
// fails with "unknown account"; web3.qrl.sendTransaction signs locally
// with the added wallet, so build the tx explicitly.
async function send(method, opts = {}) {
  const from = acc.address;
  const gasPrice = await web3.qrl.getGasPrice();
  const estimated = await method.estimateGas({ from, ...opts });
  const gas = (BigInt(estimated) * 12n) / 10n;
  const txObj = { from, to: htlcAddress, gas, gasPrice, data: method.encodeABI(), ...opts };
  return new Promise((resolve, reject) => {
    web3.qrl
      .sendTransaction(txObj, undefined, { checkRevertBeforeSending: true })
      .on("receipt", resolve)
      .on("error", reject);
  });
}

async function main() {
  const contract = new web3.qrl.Contract(abi, htlcAddress);

  const preimage = `0x${crypto.randomBytes(32).toString("hex")}`;
  const hashlock = `0x${crypto.createHash("sha256").update(Buffer.from(preimage.slice(2), "hex")).digest("hex")}`;
  const timeout = Math.floor(Date.now() / 1000) + 3600;
  const amount = 10n ** 15n; // 0.001 QRL in planck (no unit helpers in @theqrl/web3 0.4)

  console.log(`[smoke-qrl] account ${acc.address}, htlc ${htlcAddress}`);
  console.log(`[smoke-qrl] hashlock ${hashlock}`);

  console.log("[smoke-qrl] lockNative 0.001 QRL, recipient self, timeout +1h");
  const lockReceipt = await send(contract.methods.lockNative(hashlock, acc.address, timeout), { value: amount });
  console.log(`[smoke-qrl] lock tx ${lockReceipt.transactionHash}`);

  let swap = await contract.methods.getSwap(hashlock).call();
  if (BigInt(swap.status) !== 1n) throw new Error(`expected Open(1), got ${swap.status}`);

  console.log("[smoke-qrl] claim with preimage");
  const claimReceipt = await send(contract.methods.claim(hashlock, preimage));
  console.log(`[smoke-qrl] claim tx ${claimReceipt.transactionHash}`);

  swap = await contract.methods.getSwap(hashlock).call();
  if (BigInt(swap.status) !== 2n) throw new Error(`expected Claimed(2), got ${swap.status}`);
  if (swap.preimage.toLowerCase() !== preimage.toLowerCase()) throw new Error("preimage mismatch");

  console.log("[smoke-qrl] PASS: lock -> claim round trip verified on-chain");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
