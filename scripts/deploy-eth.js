// Deploy an HTLC to the Ethereum leg (Sepolia for now).
// Loads the target-bound EVM artifact compiled from the shared Hyperion source.
// Required env (.env): ETH_RPC_URL, ETH_PRIVATE_KEY
// Run scripts/compile.js first.

require("dotenv").config();
const { ethers } = require("ethers");
const { loadArtifact } = require("./artifacts");
const deployment = require("../config/protocol-v2.json");

const rpc = process.env.ETH_RPC_URL;
const key = process.env.ETH_PRIVATE_KEY;
if (!rpc || !key) {
  console.error("ETH_RPC_URL and ETH_PRIVATE_KEY are required (see .env.example)");
  process.exit(1);
}

// HTLC_CONTRACT selects the qualified contract: HTLC (the deployed v2
// interface, the default) or HTLCv3 (payout credits, issue #47).
const contractName = process.env.HTLC_CONTRACT ?? "HTLC";
if (contractName !== "HTLC" && contractName !== "HTLCv3") {
  console.error("HTLC_CONTRACT must be HTLC or HTLCv3");
  process.exit(1);
}
const { abi, bytecode, deployedBytecode } = loadArtifact("evm", contractName);

async function main() {
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(key, provider);
  const { chainId } = await provider.getNetwork();
  if (chainId !== BigInt(deployment.ethChainId)) {
    throw new Error("Ethereum endpoint does not match the pinned deployment");
  }
  console.log(`[deploy-eth] deployer ${wallet.address} on chain ${chainId}`);
  console.log(`[deploy-eth] balance ${ethers.formatEther(await provider.getBalance(wallet.address))} ETH`);

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy({ chainId });
  console.log(`[deploy-eth] tx ${contract.deploymentTransaction().hash}`);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`[deploy-eth] ${contractName} deployed at ${address}`);
  const code = await provider.getCode(address);
  if (code.toLowerCase() !== deployedBytecode.toLowerCase()) {
    throw new Error("deployed Ethereum runtime differs from the qualified artifact");
  }
  console.log(`[deploy-eth] getCode ok (${(code.length - 2) / 2} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
