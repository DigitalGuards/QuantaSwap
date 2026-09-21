// Deploy the HTLC to the pinned private v3 testnet.
// Required env (.env): QRL_RPC_URL, QRL_HEXSEED (funded Dilithium hex seed)
// Run scripts/compile.js first.

require("dotenv").config();
const { Web3 } = require("@theqrl/web3");
const { loadArtifact } = require("./artifacts");
const { assertQip55Deployment, assertQip55ToolingAccount } = require("./qip55");
const deployment = require("../config/protocol-v2.json");

const rpc = process.env.QRL_RPC_URL;
const hexseed = process.env.QRL_HEXSEED;
if (!rpc || !hexseed) {
  console.error("QRL_RPC_URL and QRL_HEXSEED are required (see .env.example)");
  process.exit(1);
}

const { abi, bytecode, deployedBytecode } = loadArtifact("qrl", "HTLC");

const web3 = new Web3(new Web3.providers.HttpProvider(rpc));
const acc = web3.qrl.accounts.seedToAccount(hexseed);
assertQip55ToolingAccount(acc.address);
web3.qrl.wallet?.add(hexseed);
web3.qrl.transactionConfirmationBlocks = 1;

async function main() {
  const chainId = await web3.qrl.getChainId();
  const genesis = await web3.qrl.getBlock(0);
  if (BigInt(chainId) !== BigInt(deployment.qrlChainId) ||
      String(genesis.hash).toLowerCase() !== deployment.qrlGenesisHash) {
    throw new Error("QRL endpoint does not match the pinned v3 deployment");
  }
  console.log(`[deploy-qrl] deployer ${acc.address}`);
  const balance = await web3.qrl.getBalance(acc.address);
  // @theqrl/web3 0.4 has no wei/planck unit helpers; format manually.
  console.log(`[deploy-qrl] balance ${(Number(balance) / 1e18).toFixed(4)} QRL`);

  const contract = new web3.qrl.Contract(abi);
  const deploy = contract.deploy({ data: bytecode });
  const estimatedGas = await deploy.estimateGas({ from: acc.address });
  const gas = (BigInt(estimatedGas) * 12n) / 10n;
  const gasPrice = await web3.qrl.getGasPrice();

  const address = await new Promise((resolve, reject) => {
    web3.qrl
      .sendTransaction(
        { from: acc.address, gas, gasPrice, data: deploy.encodeABI(), chainId },
        undefined,
        { checkRevertBeforeSending: true }
      )
      .on("transactionHash", (h) => {
        const hash = typeof h === "string" ? h : Buffer.from(h).toString("hex");
        console.log(`[deploy-qrl] tx ${hash}`);
      })
      .on("receipt", (r) => resolve(r.contractAddress))
      .on("error", reject);
  });

  assertQip55Deployment(address);
  console.log(`[deploy-qrl] HTLC deployed at ${address}`);
  const code = await web3.qrl.getCode(address);
  if (code.toLowerCase() !== deployedBytecode.toLowerCase()) {
    throw new Error("deployed QRL runtime differs from the qualified artifact");
  }
  console.log(`[deploy-qrl] getCode ok (${(code.length - 2) / 2} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
