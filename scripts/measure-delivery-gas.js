// Measure the real cost of HTLCv3's token delivery path (balanceOf, transfer,
// balanceOf) against the live WETH, USDC and USDT implementations. This is what
// sizes DELIVERY_GAS_LIMIT, recorded in docs/audit/HTLCV3_SCOPE.md section 2.
//
// It runs on a READ-ONLY anvil fork of Ethereum mainnet. Nothing is broadcast to
// any chain, no private key is used or read, and the fork is discarded when the
// process exits. Token balances come from impersonating public holders inside
// the fork, which only ever touches local state. It needs network access, so it
// is deliberately outside `npm test`.
//
// Usage: node scripts/measure-delivery-gas.js
//        FORK_URL=<archive rpc> node scripts/measure-delivery-gas.js
const { spawn } = require("child_process");
const path = require("path");
const { ethers } = require("ethers");
const { compileDirs } = require("./hypc");

const repoRoot = path.join(__dirname, "..");

const PORT = 8590;
const RPC = `http://127.0.0.1:${PORT}`;
const FORK = process.env.FORK_URL || "https://ethereum-rpc.publicnode.com";

// The documented integration rule, so the attempt is handed its whole budget.
// A smaller buffer forwards less and measures a delivery that never had the
// budget the contract promises it.
const SETTLE_GAS_BUFFER = 250000n;

const TOKENS = {
  WETH: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18, amount: 10n ** 17n,
          holders: ["0x8EB8a3b98659Cce290402893d0123abb75E3ab28", "0x2F0b23f53734b29847fAc2Bd4ECbb1f4E8f62e30"] },
  USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, amount: 100n * 10n ** 6n,
          holders: ["0x28C6c06298d514Db089934071355E5743bf21d60", "0x55FE002aefF02F77364de339a1292923A15844B8",
                    "0x4B16c5dE96EB2117bBE5fd234E25623E2D41499E", "0xcEe284F754E854890e311e3280b767F80797180d"] },
  USDT: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, amount: 100n * 10n ** 6n,
          holders: ["0x28C6c06298d514Db089934071355E5743bf21d60", "0x5754284f345afc66a98fbB0a0Afe71e0F007B949",
                    "0xF977814e90dA44bFA03b6295A0616a897441aceC", "0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503"] },
};

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function deposit() payable",
];

const newSecret = () => {
  const p = ethers.hexlify(ethers.randomBytes(32));
  return { preimage: p, hashlock: ethers.sha256(p) };
};

async function main() {
  const artifacts = compileDirs([path.join(repoRoot, "contracts", "hyperion")], "evm");
  const anvil = spawn("anvil", ["--port", String(PORT), "--silent", "--steps-tracing",
    "--fork-url", FORK, "--gas-limit", "30000000"], { stdio: "ignore" });
  process.on("exit", () => { try { anvil.kill(); } catch {} });
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { polling: true, pollingInterval: 200, cacheTimeout: -1 });
  let block = null;
  for (let i = 0; ; i++) {
    try { block = await provider.getBlockNumber(); break; }
    catch (e) { if (i > 300) throw new Error("fork did not come up: " + e.message); await new Promise(r => setTimeout(r, 500)); }
  }
  console.log("forked mainnet at block", block);

  const w = (i) => ethers.HDNodeWallet.fromPhrase("test test test test test test test test test test test junk", undefined, `m/44'/60'/0'/0/${i}`).connect(provider);
  const [alice, relayer] = [w(0), w(3)];
  const f = new ethers.ContractFactory(artifacts.HTLCv3.abi, artifacts.HTLCv3.bytecode, alice);
  const htlc = await f.deploy();
  await htlc.waitForDeployment();
  const [budget, reserve] = await htlc.deliveryGasPolicy();
  console.log("delivery policy: budget", budget.toString(), "reserve", reserve.toString());

  const fund = async (name, cfg, to, amount) => {
    const token = new ethers.Contract(cfg.address, ERC20, provider);
    if (name === "WETH") {
      await provider.send("anvil_setBalance", [to, "0x" + (10n ** 21n).toString(16)]);
      await provider.send("anvil_impersonateAccount", [to]);
      const s = await provider.getSigner(to);
      await (await token.connect(s).deposit({ value: amount * 4n })).wait();
      await provider.send("anvil_stopImpersonatingAccount", [to]);
      return true;
    }
    for (const holder of cfg.holders) {
      const bal = await token.balanceOf(holder);
      if (bal < amount * 4n) continue;
      await provider.send("anvil_setBalance", [holder, "0x" + (10n ** 19n).toString(16)]);
      await provider.send("anvil_impersonateAccount", [holder]);
      const s = await provider.getSigner(holder);
      try { await (await token.connect(s).transfer(to, amount * 4n)).wait(); }
      catch (e) { await provider.send("anvil_stopImpersonatingAccount", [holder]); continue; }
      await provider.send("anvil_stopImpersonatingAccount", [holder]);
      return true;
    }
    return false;
  };

  // The delivery attempt is the only depth-1 CALL a settlement makes; its own
  // consumption is what DELIVERY_GAS_LIMIT has to cover.
  const childCost = async (txHash) => {
    const t = await provider.send("debug_traceTransaction", [txHash, { disableStorage: true, disableMemory: true, disableStack: true }]);
    const L = t.structLogs;
    let ci = -1;
    for (let i = 0; i < L.length; i++) if (L[i].depth === 1 && L[i].op === "CALL") ci = i;
    if (ci < 0) return null;
    let back = -1;
    for (let i = ci + 1; i < L.length; i++) if (L[i].depth === 1) { back = i; break; }
    return { budgetForwarded: L[ci].gasCost, childUsed: L[ci].gas - L[back].gas };
  };

  console.log("\ntoken | recipient | delivery attempt gas | budget forwarded | headroom vs 100000");
  for (const [name, cfg] of Object.entries(TOKENS)) {
    const ok = await fund(name, cfg, alice.address, cfg.amount);
    if (!ok) { console.log(`${name}: NO FUNDING SOURCE FOUND, not measured`); continue; }
    const token = new ethers.Contract(cfg.address, ERC20, alice);
    for (const [label, recipient] of [["fresh", ethers.Wallet.createRandom().address], ["warm", w(1).address]]) {
      if (label === "warm") {
        // make the recipient's token balance slot nonzero first
        await (await token.transfer(recipient, 1n)).wait();
      }
      const secret = newSecret();
      await (await token.approve(htlc.target, cfg.amount)).wait();
      const timeout = (await provider.getBlock("latest")).timestamp + 3600;
      await (await htlc.lockToken(secret.hashlock, recipient, cfg.address, cfg.amount, timeout)).wait();
      const claimAs = htlc.connect(relayer).claim;
      const est = await claimAs.estimateGas(secret.hashlock, secret.preimage);
      const tx = await claimAs(secret.hashlock, secret.preimage, { gasLimit: est + SETTLE_GAS_BUFFER });
      const r = await tx.wait();
      const c = await childCost(tx.hash);
      const delivered = (await htlc.creditOf(cfg.address, recipient)) === 0n;
      console.log(`${name.padEnd(5)} | ${label.padEnd(9)} | ${String(c.childUsed).padStart(20)} | ${String(c.budgetForwarded).padStart(16)} | ${String(100000 - c.childUsed).padStart(18)}  delivered=${delivered} txGas=${r.gasUsed}`);
    }
  }
  anvil.kill();
}
main().then(() => process.exit(0)).catch(e => { console.error("FAILED:", e.message); process.exit(1); });
