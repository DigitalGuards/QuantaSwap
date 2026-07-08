// Deploy the HTLC to the Ethereum leg (Sepolia for now).
// Deploys the SAME hypc-compiled artifact as the QRL leg, so both chains
// run byte-identical bytecode.
// Required env (.env): ETH_RPC_URL, ETH_PRIVATE_KEY
// Run scripts/compile.js first.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const rpc = process.env.ETH_RPC_URL;
const key = process.env.ETH_PRIVATE_KEY;
if (!rpc || !key) {
  console.error("ETH_RPC_URL and ETH_PRIVATE_KEY are required (see .env.example)");
  process.exit(1);
}

const artifactPath = path.join(__dirname, "..", "build", "hyperion", "HTLC.json");
const { abi, bytecode } = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

async function main() {
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(key, provider);
  const { chainId } = await provider.getNetwork();
  console.log(`[deploy-eth] deployer ${wallet.address} on chain ${chainId}`);
  console.log(`[deploy-eth] balance ${ethers.formatEther(await provider.getBalance(wallet.address))} ETH`);

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy();
  console.log(`[deploy-eth] tx ${contract.deploymentTransaction().hash}`);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`[deploy-eth] HTLC deployed at ${address}`);
  const code = await provider.getCode(address);
  if (!code || code === "0x") throw new Error("getCode returned empty, deploy failed");
  console.log(`[deploy-eth] getCode ok (${(code.length - 2) / 2} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
