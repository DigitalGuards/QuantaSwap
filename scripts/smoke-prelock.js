// Live smoke test for the HTLCv2 open-recipient (prelock) surface on a
// deployed leg: lockNativeOpen -> assign(self) -> claim (round trip), then
// lockNativeOpen -> release (on-demand reclaim). Dust amounts to self.
// Usage:
//   node scripts/smoke-prelock.js eth <htlc-address>   (env: ETH_RPC_URL, ETH_PRIVATE_KEY)
//   node scripts/smoke-prelock.js qrl <htlc-address>   (env: QRL_RPC_URL, QRL_HEXSEED)

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const leg = process.argv[2];
const htlcAddress = process.argv[3];
if ((leg !== "eth" && leg !== "qrl") || !htlcAddress) {
  console.error("usage: node scripts/smoke-prelock.js <eth|qrl> <htlc-address>");
  process.exit(1);
}

const artifactPath = path.join(__dirname, "..", "build", "hyperion", "HTLC.json");
const { abi } = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

const newSecret = () => {
  const preimage = `0x${crypto.randomBytes(32).toString("hex")}`;
  const hashlock = `0x${crypto
    .createHash("sha256")
    .update(Buffer.from(preimage.slice(2), "hex"))
    .digest("hex")}`;
  return { preimage, hashlock };
};

/** Uniform driver over the two legs' signing stacks. */
async function makeDriver() {
  if (leg === "eth") {
    const { ethers } = require("ethers");
    const rpc = process.env.ETH_RPC_URL;
    const key = process.env.ETH_PRIVATE_KEY;
    if (!rpc || !key) throw new Error("missing ETH_RPC_URL / ETH_PRIVATE_KEY");
    // cacheTimeout -1: ethers' 250ms result cache serves stale nonces on
    // instant-mining nodes (anvil); harmless against live RPCs.
    const provider = new ethers.JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
    const wallet = new ethers.Wallet(key, provider);
    const htlc = new ethers.Contract(htlcAddress, abi, wallet);
    return {
      address: wallet.address,
      send: async (name, args, value = 0n) => {
        const tx = await htlc[name](...args, ...(value > 0n ? [{ value }] : []));
        console.log(`[smoke-prelock] ${name} tx ${tx.hash}`);
        await tx.wait();
      },
      getSwap: async (hashlock) => {
        const s = await htlc.getSwap(hashlock);
        return { status: BigInt(s.status), recipient: s.recipient };
      },
    };
  }
  const { Web3 } = require("@theqrl/web3");
  const rpc = process.env.QRL_RPC_URL;
  const hexseed = process.env.QRL_HEXSEED;
  if (!rpc || !hexseed) throw new Error("missing QRL_RPC_URL / QRL_HEXSEED");
  const web3 = new Web3(new Web3.providers.HttpProvider(rpc));
  const acc = web3.qrl.accounts.seedToAccount(hexseed);
  web3.qrl.wallet?.add(hexseed);
  web3.qrl.transactionConfirmationBlocks = 1;
  const contract = new web3.qrl.Contract(abi, htlcAddress);
  // See smoke-qrl.js: sign locally via web3.qrl.sendTransaction, never
  // node-side sends.
  const send = async (name, args, value = 0n) => {
    const method = contract.methods[name](...args);
    const from = acc.address;
    const opts = value > 0n ? { value } : {};
    const gasPrice = await web3.qrl.getGasPrice();
    const estimated = await method.estimateGas({ from, ...opts });
    const gas = (BigInt(estimated) * 12n) / 10n;
    const txObj = { from, to: htlcAddress, gas, gasPrice, data: method.encodeABI(), ...opts };
    await new Promise((resolve, reject) => {
      web3.qrl
        .sendTransaction(txObj, undefined, { checkRevertBeforeSending: true })
        .on("receipt", (r) => {
          console.log(`[smoke-prelock] ${name} tx ${r.transactionHash}`);
          resolve(r);
        })
        .on("error", reject);
    });
  };
  return {
    address: acc.address,
    send,
    getSwap: async (hashlock) => {
      const s = await contract.methods.getSwap(hashlock).call();
      return { status: BigInt(s.status), recipient: s.recipient };
    },
  };
}

async function main() {
  const drv = await makeDriver();
  const dust = 1000n;
  const ZERO = `0x${"0".repeat(40)}`;
  console.log(`[smoke-prelock] leg ${leg}, account ${drv.address}, htlc ${htlcAddress}`);

  // Round trip: open lock -> assign(self) -> claim.
  const a = newSecret();
  const timeout = Math.floor(Date.now() / 1000) + 3600;
  console.log("[smoke-prelock] lockNativeOpen dust, recipient unset, timeout +1h");
  await drv.send("lockNativeOpen", [a.hashlock, timeout], dust);
  let swap = await drv.getSwap(a.hashlock);
  if (swap.status !== 1n) throw new Error(`expected Open(1), got ${swap.status}`);
  if (swap.recipient.toLowerCase() !== ZERO) throw new Error("recipient not unset");

  console.log("[smoke-prelock] assign self");
  // The QRL leg stores hex addresses; Q-prefix strips to hex for calldata.
  const selfHex = drv.address.startsWith("Q") ? `0x${drv.address.slice(1)}` : drv.address;
  await drv.send("assign", [a.hashlock, selfHex]);
  swap = await drv.getSwap(a.hashlock);
  if (swap.recipient.toLowerCase() !== selfHex.toLowerCase()) throw new Error("assign did not set recipient");

  console.log("[smoke-prelock] claim with preimage");
  await drv.send("claim", [a.hashlock, a.preimage]);
  swap = await drv.getSwap(a.hashlock);
  if (swap.status !== 2n) throw new Error(`expected Claimed(2), got ${swap.status}`);

  // On-demand release while unassigned.
  const b = newSecret();
  console.log("[smoke-prelock] lockNativeOpen dust, then release on demand");
  await drv.send("lockNativeOpen", [b.hashlock, timeout], dust);
  await drv.send("release", [b.hashlock]);
  swap = await drv.getSwap(b.hashlock);
  if (swap.status !== 3n) throw new Error(`expected Refunded(3), got ${swap.status}`);

  console.log("[smoke-prelock] PASS: open-lock -> assign -> claim, and open-lock -> release");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
