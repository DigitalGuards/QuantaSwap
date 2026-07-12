// Live smoke test for an ERC-20 asset (USDC, USDT/tUSDT, WETH) against a
// deployed HTLC on the Ethereum leg: approve, lockToken a dust amount to
// self, claim, verify status + preimage + balances.
//
// Drives the token the way the frontend must: exact-amount approvals, and
// an approve(0) reset first whenever a stale nonzero allowance exists
// (USDT's approval race guard reverts a nonzero -> nonzero approve).
//
// Usage: node scripts/smoke-eth-erc20.js <htlc-address> <token-address> [amount]
//        amount is in token units (default "0.1")
// Required env (.env): ETH_RPC_URL, ETH_PRIVATE_KEY

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const rpc = process.env.ETH_RPC_URL;
const key = process.env.ETH_PRIVATE_KEY;
const [htlcAddress, tokenAddress, amountArg] = process.argv.slice(2);
if (!rpc || !key || !htlcAddress || !tokenAddress) {
  console.error(
    "usage: ETH_RPC_URL=.. ETH_PRIVATE_KEY=.. node scripts/smoke-eth-erc20.js <htlc-address> <token-address> [amount]"
  );
  process.exit(1);
}

const artifactPath = path.join(__dirname, "..", "build", "hyperion", "HTLC.json");
const { abi } = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

// Minimal ERC-20 surface. Return values are only decoded on views, so the
// same ABI drives both standard tokens and USDT-style no-return tokens.
const erc20Abi = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(key, provider);
  const htlc = new ethers.Contract(htlcAddress, abi, wallet);
  const token = new ethers.Contract(tokenAddress, erc20Abi, wallet);

  const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
  const amount = ethers.parseUnits(amountArg || "0.1", decimals);
  const fmt = (v) => `${ethers.formatUnits(v, decimals)} ${symbol}`;

  console.log(`[smoke-erc20] account ${wallet.address}, htlc ${htlcAddress}`);
  console.log(`[smoke-erc20] token ${symbol} (${decimals} decimals) at ${tokenAddress}`);

  const balance = await token.balanceOf(wallet.address);
  if (balance < amount) {
    throw new Error(`balance ${fmt(balance)} below smoke amount ${fmt(amount)}; fund the account first`);
  }

  const allowance = await token.allowance(wallet.address, htlcAddress);
  if (allowance !== 0n) {
    console.log(`[smoke-erc20] stale allowance ${fmt(allowance)}, resetting to 0 (USDT approval race)`);
    await (await token.approve(htlcAddress, 0n)).wait();
  }
  console.log(`[smoke-erc20] approve exactly ${fmt(amount)}`);
  await (await token.approve(htlcAddress, amount)).wait();

  const preimage = ethers.hexlify(ethers.randomBytes(32));
  const hashlock = ethers.sha256(preimage);
  const timeout = Math.floor(Date.now() / 1000) + 3600;
  console.log(`[smoke-erc20] hashlock ${hashlock}`);

  console.log(`[smoke-erc20] lockToken ${fmt(amount)}, recipient self, timeout +1h`);
  const lockTx = await htlc.lockToken(hashlock, wallet.address, tokenAddress, amount, timeout);
  console.log(`[smoke-erc20] lock tx ${lockTx.hash}`);
  await lockTx.wait();

  let swap = await htlc.getSwap(hashlock);
  if (swap.status !== 1n) throw new Error(`expected Open(1), got ${swap.status}`);
  const escrowed = await token.balanceOf(htlcAddress);
  if (escrowed < amount) throw new Error(`escrow balance ${fmt(escrowed)} below ${fmt(amount)}`);

  console.log("[smoke-erc20] claim with preimage");
  const before = await token.balanceOf(wallet.address);
  const claimTx = await htlc.claim(hashlock, preimage);
  console.log(`[smoke-erc20] claim tx ${claimTx.hash}`);
  await claimTx.wait();

  swap = await htlc.getSwap(hashlock);
  if (swap.status !== 2n) throw new Error(`expected Claimed(2), got ${swap.status}`);
  if (swap.preimage.toLowerCase() !== preimage.toLowerCase()) throw new Error("preimage mismatch");
  const received = (await token.balanceOf(wallet.address)) - before;
  if (received !== amount) throw new Error(`claim paid ${fmt(received)}, expected ${fmt(amount)}`);

  console.log(`[smoke-erc20] PASS: ${symbol} lock -> claim round trip verified on-chain`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
