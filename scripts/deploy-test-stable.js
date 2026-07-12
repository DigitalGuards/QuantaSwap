// Deploy TestStable (tUSDT) to the Ethereum leg testnet (Sepolia).
// Tether has no official Sepolia deployment, so testnet USDT swaps use
// this faucet token, which replicates mainnet USDT's ERC-20 surface
// (6 decimals, no return values, approval race). NEVER deploy to mainnet.
// Required env (.env): ETH_RPC_URL, ETH_PRIVATE_KEY
// After deploying, record the address in config/tokens.json (chain 11155111).

require("dotenv").config();
const path = require("path");
const { ethers } = require("ethers");
const { compileDirs } = require("./hypc");

const rpc = process.env.ETH_RPC_URL;
const key = process.env.ETH_PRIVATE_KEY;
if (!rpc || !key) {
  console.error("ETH_RPC_URL and ETH_PRIVATE_KEY are required (see .env.example)");
  process.exit(1);
}

async function main() {
  const artifacts = compileDirs([path.join(__dirname, "..", "contracts", "testnet")]);
  const { abi, bytecode } = artifacts.TestStable;

  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(key, provider);
  const { chainId } = await provider.getNetwork();
  if (chainId === 1n) throw new Error("refusing to deploy a faucet token to Ethereum mainnet");
  console.log(`[deploy-test-stable] deployer ${wallet.address} on chain ${chainId}`);

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy();
  console.log(`[deploy-test-stable] tx ${contract.deploymentTransaction().hash}`);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`[deploy-test-stable] tUSDT deployed at ${address}`);

  const faucetTx = await contract.faucet();
  await faucetTx.wait();
  console.log(`[deploy-test-stable] faucet minted 10,000 tUSDT to deployer`);
  console.log(`[deploy-test-stable] next: set this address in config/tokens.json under chain ${chainId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
