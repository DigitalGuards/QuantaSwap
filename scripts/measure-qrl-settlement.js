// Measure HTLCv3's settlement bounds on a live QRL v3 endpoint.
//
// This is the deployment gate recorded as A9 in docs/audit/HTLCV3_SCOPE.md. The
// reserve that records a credit is sized from EVM measurements, and the QRL gas
// schedule has not been measured. If the settling frame costs more there than
// DELIVERY_GAS_RESERVE, a deferred settlement reverts after its preimage is
// public, which is the failure HTLCv3 exists to remove.
//
// The QRL execution client exposes no step tracer, so the settling frame's cost
// is derived without one:
//
//   settlingFrameCost = minSuccessfulGasLimit(credit-path claim)
//                     - gasUsed(claim that reverts WrongPreimage)
//
// The first term is binary searched. The result is an UPPER bound: it also
// contains the terminal state writes, the Claimed log, and whatever the delivery
// attempt itself consumed before failing. Under the bound is therefore
// conclusive. Over the bound means investigate with a tracer before concluding,
// and the payload-invariance comparison is the sharp signal either way.
//
// Scenarios, all from docs/audit/HTLCV3_SCOPE.md section 8:
//   A-token   a credit-path token claim, bomb armed at 4 and at 120,832 bytes
//   A-native  a credit-path native claim to a contract that cannot receive
//   B         a native delivery that succeeds, and one that fails
//   C         a gas-limit sweep with the bomb armed, checking terminal states
//
// Usage, live QRL v3:
//   QRL_RPC_URL=<url> QRL_HEXSEED_FILE=<path> node scripts/measure-qrl-settlement.js
//   add --dry-run to verify the endpoint, the artifacts and the funding without
//   sending anything.
//
// Usage, local control-flow rehearsal on the EVM target:
//   anvil --port 8599 --silent
//   node scripts/measure-qrl-settlement.js --evm
//
// The hexseed is read from the file named by QRL_HEXSEED_FILE and is never
// printed, logged, or written to the result file. Only addresses, transaction
// hashes and gas figures are printed. The script refuses to run unless the
// endpoint's chain id and genesis match the pinned deployment (QRL) or unless
// the chain id is anvil's (rehearsal), so it cannot touch an unintended chain.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { compileDirs } = require("./hypc");
const { loadArtifact } = require("./artifacts");

const repoRoot = path.join(__dirname, "..");
const deployment = require("../config/protocol-v2.json");

const ANVIL_CHAIN_ID = 31337n;
// Bounds under test, mirroring the contract's constants.
const DELIVERY_GAS_LIMIT = 100000n;
const DELIVERY_GAS_RESERVE = 150000n;
// A settling frame whose cost moves with the payload means something on that
// path re-emits a callee's revert data. Allow only measurement noise.
const PAYLOAD_INVARIANCE_TOLERANCE = 2000n;
const BOMB_SIZES = [4n, 120832n];
const SEARCH_FLOOR = 40000n;
const SEARCH_CEILING = 600000n;
const SEARCH_PRECISION = 500n;

const args = process.argv.slice(2);
const options = {
  dryRun: args.includes("--dry-run"),
  evm: args.includes("--evm"),
  out:
    args.includes("--out") && args[args.indexOf("--out") + 1]
      ? args[args.indexOf("--out") + 1]
      : path.join(repoRoot, "qrl-settlement-measurement.json"),
};

const sha256Hex = (hex) =>
  `0x${crypto.createHash("sha256").update(Buffer.from(hex.slice(2), "hex")).digest("hex")}`;
const newSecret = () => {
  const preimage = `0x${crypto.randomBytes(32).toString("hex")}`;
  return { preimage, hashlock: sha256Hex(preimage) };
};

const failures = [];
const note = (message) => console.log(`  ${message}`);
const fail = (message) => {
  failures.push(message);
  console.log(`  BOUND VIOLATED: ${message}`);
};

// ---------------------------------------------------------------- transports
//
// Both adapters expose the same surface, so every scenario below is written once
// and runs against either chain. Only `chainIdentity`, `deploy` and `send`
// differ in substance; the QRL side goes through @theqrl/web3 because QRVM-512
// ABI slots are 64 bytes wide and its encoder is the one that knows that.

async function qrlTransport() {
  const rpc = process.env.QRL_RPC_URL;
  const seedFile = process.env.QRL_HEXSEED_FILE;
  if (!rpc || !seedFile) {
    throw new Error("QRL_RPC_URL and QRL_HEXSEED_FILE are required for a QRL run");
  }
  // Read, use, and never surface. Nothing below logs this value.
  const hexseed = fs.readFileSync(seedFile, "utf8").trim();
  if (!/^(0x)?[0-9a-fA-F]{102,}$/.test(hexseed)) {
    throw new Error("QRL_HEXSEED_FILE does not contain a hex seed");
  }
  const { Web3 } = require("@theqrl/web3");
  const web3 = new Web3(new Web3.providers.HttpProvider(rpc));
  const account = web3.qrl.accounts.seedToAccount(hexseed);
  web3.qrl.wallet?.add(hexseed);
  web3.qrl.transactionConfirmationBlocks = 1;

  const receiptFor = async (hash) => {
    for (let i = 0; i < 60; i++) {
      const receipt = await web3.qrl.getTransactionReceipt(hash).catch(() => null);
      if (receipt) return receipt;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`no receipt for ${hash}`);
  };

  const submit = async (tx) => {
    const gasPrice = await web3.qrl.getGasPrice();
    let hash = null;
    try {
      const receipt = await new Promise((resolve, reject) => {
        web3.qrl
          .sendTransaction({ ...tx, from: account.address, gasPrice }, undefined, {
            checkRevertBeforeSending: false,
          })
          .on("transactionHash", (value) => {
            hash = typeof value === "string" ? value : `0x${Buffer.from(value).toString("hex")}`;
          })
          .on("receipt", resolve)
          .on("error", reject);
      });
      return {
        hash: hash ?? receipt.transactionHash,
        status: Number(receipt.status) === 1,
        gasUsed: BigInt(receipt.gasUsed),
      };
    } catch (error) {
      if (!hash) throw error;
      const receipt = await receiptFor(hash);
      return { hash, status: Number(receipt.status) === 1, gasUsed: BigInt(receipt.gasUsed) };
    }
  };

  return {
    kind: "qrl",
    target: "qrl",
    account: account.address,
    async chainIdentity() {
      const chainId = BigInt(await web3.qrl.getChainId());
      const genesis = await web3.qrl.getBlock(0);
      return { chainId, genesisHash: String(genesis.hash).toLowerCase() };
    },
    async balance(address) {
      return BigInt(await web3.qrl.getBalance(address));
    },
    contract(abi, address) {
      const instance = new web3.qrl.Contract(abi, address);
      return {
        address,
        data(fn, params) {
          return instance.methods[fn](...params).encodeABI();
        },
        async read(fn, params) {
          return instance.methods[fn](...params).call({ from: account.address });
        },
        async estimate(fn, params, value) {
          return BigInt(
            await instance.methods[fn](...params).estimateGas({
              from: account.address,
              ...(value ? { value } : {}),
            })
          );
        },
      };
    },
    async deploy(artifact) {
      const instance = new web3.qrl.Contract(artifact.abi);
      const data = instance.deploy({ data: artifact.bytecode }).encodeABI();
      const estimated = await web3.qrl.estimateGas({ from: account.address, data });
      const result = await submit({ data, gas: (BigInt(estimated) * 13n) / 10n });
      const receipt = await receiptFor(result.hash);
      if (!receipt.contractAddress) throw new Error("deployment produced no address");
      return receipt.contractAddress;
    },
    async send(to, data, { gas, value }) {
      return submit({ to, data, gas, ...(value ? { value } : {}) });
    },
  };
}

async function evmTransport() {
  const { ethers } = require("ethers");
  const rpc = process.env.EVM_RPC_URL || "http://127.0.0.1:8599";
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
  // The rehearsal only ever runs against anvil, whose mnemonic is public and
  // whose chain id is asserted below before anything is sent.
  const wallet = ethers.HDNodeWallet.fromPhrase(
    "test test test test test test test test test test test junk",
    undefined,
    "m/44'/60'/0'/0/0"
  ).connect(provider);

  const submit = async (tx) => {
    try {
      const sent = await wallet.sendTransaction(tx);
      const receipt = await sent.wait();
      return { hash: sent.hash, status: receipt.status === 1, gasUsed: receipt.gasUsed };
    } catch (error) {
      const hash = error?.receipt?.hash ?? error?.transaction?.hash ?? null;
      if (error?.receipt) {
        return {
          hash: error.receipt.hash,
          status: error.receipt.status === 1,
          gasUsed: error.receipt.gasUsed,
        };
      }
      if (!hash) throw error;
      const receipt = await provider.getTransactionReceipt(hash);
      return { hash, status: receipt.status === 1, gasUsed: receipt.gasUsed };
    }
  };

  return {
    kind: "evm",
    target: "evm",
    account: wallet.address,
    async chainIdentity() {
      const network = await provider.getNetwork();
      const genesis = await provider.send("eth_getBlockByNumber", ["0x0", false]);
      return { chainId: network.chainId, genesisHash: String(genesis.hash).toLowerCase() };
    },
    async balance(address) {
      return provider.getBalance(address);
    },
    contract(abi, address) {
      const instance = new ethers.Contract(address, abi, wallet);
      return {
        address,
        data(fn, params) {
          return instance.interface.encodeFunctionData(fn, params);
        },
        async read(fn, params) {
          return instance[fn](...params);
        },
        async estimate(fn, params, value) {
          return instance[fn].estimateGas(...params, value ? { value } : {});
        },
      };
    },
    async deploy(artifact) {
      const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
      const contract = await factory.deploy();
      await contract.waitForDeployment();
      return contract.target;
    },
    async send(to, data, { gas, value }) {
      return submit({ to, data, gasLimit: gas, ...(value ? { value } : {}) });
    },
  };
}

// --------------------------------------------------------------- measurement

// The first gas limit at which `attempt` both completes and leaves the swap
// terminal. `attempt(limit)` has to create a fresh swap each time, because a
// claim is single use.
async function minSuccessfulGasLimit(attempt) {
  let low = SEARCH_FLOOR;
  let high = SEARCH_CEILING;
  const top = await attempt(high);
  if (!top.settled) throw new Error("no gas limit in range settles this claim");
  while (high - low > SEARCH_PRECISION) {
    const mid = (low + high) / 2n;
    const result = await attempt(mid);
    if (result.settled) high = mid;
    else low = mid;
  }
  return high;
}

async function main() {
  const transport = options.evm ? await evmTransport() : await qrlTransport();
  const target = transport.target;
  console.log(`[measure] transport ${transport.kind}, target ${target}`);
  console.log(`[measure] account ${transport.account}`);

  const { chainId, genesisHash } = await transport.chainIdentity();
  console.log(`[measure] chain id ${chainId}`);
  if (options.evm) {
    if (chainId !== ANVIL_CHAIN_ID) {
      throw new Error(`the rehearsal refuses to run anywhere but anvil (chain id ${chainId})`);
    }
  } else {
    if (chainId !== BigInt(deployment.qrlChainId)) {
      throw new Error(`chain id ${chainId} is not the pinned ${deployment.qrlChainId}`);
    }
    if (genesisHash !== String(deployment.qrlGenesisHash).toLowerCase()) {
      throw new Error("genesis hash does not match the pinned deployment");
    }
    console.log("[measure] chain id and genesis match the pinned deployment");
  }

  // The contract under test is the qualified artifact; the mocks are compiled
  // on demand because they are never part of a release build.
  const compiled = compileDirs(
    [path.join(repoRoot, "contracts", "hyperion"), path.join(repoRoot, "contracts", "test")],
    target
  );
  const qualified = loadArtifact(target, "HTLCv3");
  if (compiled.HTLCv3.deployedBytecode !== qualified.deployedBytecode) {
    throw new Error("the compiled HTLCv3 differs from the qualified artifact for this target");
  }
  for (const name of ["RevertBombBalanceToken", "NonPayableRecipient"]) {
    if (!compiled[name]) throw new Error(`missing mock ${name}`);
  }
  console.log(`[measure] HTLCv3 runtime matches the qualified ${target} artifact`);

  const balance = await transport.balance(transport.account);
  console.log(`[measure] balance ${balance}`);
  if (balance === 0n) throw new Error("the account holds nothing; fund it before measuring");

  const results = {
    target,
    chainId: chainId.toString(),
    account: transport.account,
    bounds: {
      settlingFrameMax: DELIVERY_GAS_RESERVE.toString(),
      nativeDeliveryMax: DELIVERY_GAS_LIMIT.toString(),
      payloadInvarianceTolerance: PAYLOAD_INVARIANCE_TOLERANCE.toString(),
    },
    scenarioA: { token: [], native: null },
    scenarioB: [],
    scenarioC: { sweep: [], completed: 0, reverted: 0 },
    failures: [],
  };

  if (options.dryRun) {
    console.log("[measure] dry run: endpoint, artifacts and funding verified, nothing sent");
    const estimateOnly = compiled.HTLCv3;
    console.log(`[measure] HTLCv3 init code ${(estimateOnly.bytecode.length - 2) / 2} bytes`);
    results.dryRun = true;
    fs.writeFileSync(options.out, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`[measure] wrote ${options.out}`);
    return;
  }

  const htlcAddress = await transport.deploy(compiled.HTLCv3);
  console.log(`[measure] HTLCv3 ${htlcAddress}`);
  const htlc = transport.contract(compiled.HTLCv3.abi, htlcAddress);
  const rejector = await transport.deploy(compiled.NonPayableRecipient);
  console.log(`[measure] nonpayable recipient ${rejector}`);

  const timeout = async () => {
    // Far enough out that no measurement can drift past the claim window.
    const seconds = Math.floor(Date.now() / 1000) + 24 * 3600;
    return BigInt(seconds);
  };
  const swapStatus = async (hashlock) => {
    const swap = await htlc.read("getSwap", [hashlock]);
    return { status: BigInt(swap.status ?? swap[5]), preimage: String(swap.preimage ?? swap[6]) };
  };
  const creditSum = async (token, accounts) => {
    let total = 0n;
    for (const account of accounts) total += BigInt(await htlc.read("creditOf", [token, account]));
    return total;
  };
  const checkLedger = async (label, token, accounts) => {
    const outstanding = BigInt(await htlc.read("outstandingCredit", [token]));
    const summed = await creditSum(token, accounts);
    if (outstanding !== summed) {
      fail(`${label}: outstandingCredit ${outstanding} does not equal the per-account sum ${summed}`);
    }
    return outstanding;
  };

  // ---- the WrongPreimage baseline, the subtrahend of the derivation ----
  const zeroAddress = options.evm ? "0x" + "0".repeat(40) : `Q${"0".repeat(128)}`;
  const wrongBaseline = await (async () => {
    const secret = newSecret();
    const lock = await transport.send(
      htlcAddress,
      htlc.data("lockNative", [secret.hashlock, rejector, await timeout()]),
      { gas: 200000n, value: 1000n }
    );
    if (!lock.status) throw new Error("the baseline lock failed");
    const wrong = newSecret().preimage;
    const claim = await transport.send(htlcAddress, htlc.data("claim", [secret.hashlock, wrong]), {
      gas: 200000n,
    });
    if (claim.status) throw new Error("a wrong preimage was accepted");
    console.log(`  WrongPreimage baseline gasUsed ${claim.gasUsed} (tx ${claim.hash})`);
    return claim.gasUsed;
  })();
  results.wrongPreimageGasUsed = wrongBaseline.toString();

  // ---- Scenario A, token: bomb armed small and large ----
  console.log("\n[measure] scenario A (token): the settling frame under a revert bomb");
  const settlingCosts = [];
  for (const size of BOMB_SIZES) {
    const token = await transport.deploy(compiled.RevertBombBalanceToken);
    const tokenContract = transport.contract(compiled.RevertBombBalanceToken.abi, token);
    const mint = await transport.send(
      token,
      tokenContract.data("mint", [transport.account, 10n ** 6n]),
      { gas: 200000n }
    );
    if (!mint.status) throw new Error("mint failed");
    const approve = await transport.send(
      token,
      tokenContract.data("approve", [htlcAddress, 10n ** 6n]),
      { gas: 200000n }
    );
    if (!approve.status) throw new Error("approve failed");

    const recipients = [];
    const attempt = async (limit) => {
      const secret = newSecret();
      const disarm = await transport.send(token, tokenContract.data("disarm", []), { gas: 200000n });
      if (!disarm.status) throw new Error("disarm failed");
      const lock = await transport.send(
        htlcAddress,
        htlc.data("lockToken", [secret.hashlock, rejector, token, 10n, await timeout()]),
        { gas: 400000n }
      );
      if (!lock.status) throw new Error("the token lock failed");
      recipients.push(rejector);
      const arm = await transport.send(token, tokenContract.data("arm", [size]), { gas: 200000n });
      if (!arm.status) throw new Error("arm failed");
      const claim = await transport.send(htlcAddress, htlc.data("claim", [secret.hashlock, secret.preimage]), {
        gas: limit,
      });
      const state = await swapStatus(secret.hashlock);
      if (claim.status && state.status !== 2n) {
        fail(`scenario A token ${size}B: a completed claim left status ${state.status}`);
      }
      if (!claim.status && BigInt(state.preimage) !== 0n) {
        fail(`scenario A token ${size}B: a failed claim stored a preimage`);
      }
      return { settled: claim.status && state.status === 2n, gasUsed: claim.gasUsed, hash: claim.hash };
    };
    const minimum = await minSuccessfulGasLimit(attempt);
    const settlingFrame = minimum - wrongBaseline;
    settlingCosts.push(settlingFrame);
    console.log(
      `  payload ${size}B: minimum settling gas limit ${minimum}, ` +
        `settling frame <= ${settlingFrame}`
    );
    if (settlingFrame >= DELIVERY_GAS_RESERVE) {
      fail(
        `scenario A token ${size}B: settling frame ${settlingFrame} reaches the reserve ` +
          `${DELIVERY_GAS_RESERVE}`
      );
    }
    const disarm = await transport.send(token, tokenContract.data("disarm", []), { gas: 200000n });
    if (!disarm.status) throw new Error("final disarm failed");
    await checkLedger(`scenario A token ${size}B`, token, [...new Set(recipients)]);
    results.scenarioA.token.push({
      payloadBytes: size.toString(),
      minimumGasLimit: minimum.toString(),
      settlingFrameUpperBound: settlingFrame.toString(),
      token,
    });
  }
  const spread =
    settlingCosts.reduce((a, b) => (a > b ? a : b)) - settlingCosts.reduce((a, b) => (a < b ? a : b));
  console.log(`  payload invariance: spread ${spread} across ${BOMB_SIZES.join(" and ")} bytes`);
  if (spread > PAYLOAD_INVARIANCE_TOLERANCE) {
    fail(`the settling frame grows with the payload (spread ${spread})`);
  }
  results.scenarioA.payloadSpread = spread.toString();

  // ---- Scenario A, native: the QRL leg settles the native coin ----
  console.log("\n[measure] scenario A (native): the settling frame with a rejecting recipient");
  const nativeAttempt = async (limit) => {
    const secret = newSecret();
    const lock = await transport.send(
      htlcAddress,
      htlc.data("lockNative", [secret.hashlock, rejector, await timeout()]),
      { gas: 200000n, value: 1000n }
    );
    if (!lock.status) throw new Error("the native lock failed");
    const claim = await transport.send(htlcAddress, htlc.data("claim", [secret.hashlock, secret.preimage]), {
      gas: limit,
    });
    const state = await swapStatus(secret.hashlock);
    if (claim.status && state.status !== 2n) {
      fail(`scenario A native: a completed claim left status ${state.status}`);
    }
    if (!claim.status && BigInt(state.preimage) !== 0n) {
      fail("scenario A native: a failed claim stored a preimage");
    }
    return { settled: claim.status && state.status === 2n, gasUsed: claim.gasUsed, hash: claim.hash };
  };
  const nativeMinimum = await minSuccessfulGasLimit(nativeAttempt);
  const nativeSettlingFrame = nativeMinimum - wrongBaseline;
  console.log(
    `  minimum settling gas limit ${nativeMinimum}, settling frame <= ${nativeSettlingFrame}`
  );
  if (nativeSettlingFrame >= DELIVERY_GAS_RESERVE) {
    fail(
      `scenario A native: settling frame ${nativeSettlingFrame} reaches the reserve ` +
        `${DELIVERY_GAS_RESERVE}`
    );
  }
  await checkLedger("scenario A native", zeroAddress, [rejector]);
  results.scenarioA.native = {
    minimumGasLimit: nativeMinimum.toString(),
    settlingFrameUpperBound: nativeSettlingFrame.toString(),
  };

  // ---- Scenario B: what a native delivery attempt costs ----
  //
  // deliveryCost = gasUsed(delivering claim) - gasUsed(crediting claim)
  //                + settlingFrameCost
  // Every term is measurable without a tracer, and the settling frame figure is
  // the native one just derived.
  console.log("\n[measure] scenario B: the native delivery attempt");
  const buffer = DELIVERY_GAS_LIMIT + DELIVERY_GAS_RESERVE;
  const creditingRun = await (async () => {
    const secret = newSecret();
    await transport.send(
      htlcAddress,
      htlc.data("lockNative", [secret.hashlock, rejector, await timeout()]),
      { gas: 200000n, value: 1000n }
    );
    const estimate = await htlc.estimate("claim", [secret.hashlock, secret.preimage]);
    const claim = await transport.send(htlcAddress, htlc.data("claim", [secret.hashlock, secret.preimage]), {
      gas: estimate + buffer,
    });
    if (!claim.status) throw new Error("the crediting claim failed");
    return claim;
  })();
  for (const [label, recipient] of [
    ["plain account", transport.account],
    ["rejecting contract", rejector],
  ]) {
    const secret = newSecret();
    const lock = await transport.send(
      htlcAddress,
      htlc.data("lockNative", [secret.hashlock, recipient, await timeout()]),
      { gas: 200000n, value: 1000n }
    );
    if (!lock.status) throw new Error("the native lock failed");
    const estimate = await htlc.estimate("claim", [secret.hashlock, secret.preimage]);
    const claim = await transport.send(htlcAddress, htlc.data("claim", [secret.hashlock, secret.preimage]), {
      gas: estimate + buffer,
    });
    const state = await swapStatus(secret.hashlock);
    if (!claim.status || state.status !== 2n) {
      fail(`scenario B ${label}: the claim did not settle`);
      continue;
    }
    const credited = BigInt(await htlc.read("creditOf", [zeroAddress, recipient]));
    const deliveryCost = claim.gasUsed - creditingRun.gasUsed + nativeSettlingFrame;
    console.log(
      `  ${label}: gasUsed ${claim.gasUsed}, delivery attempt ~${deliveryCost}, ` +
        `credited ${credited} (tx ${claim.hash})`
    );
    if (credited === 0n && deliveryCost >= DELIVERY_GAS_LIMIT) {
      fail(`scenario B ${label}: delivery attempt ${deliveryCost} reaches the budget ${DELIVERY_GAS_LIMIT}`);
    }
    results.scenarioB.push({
      recipient: label,
      gasUsed: claim.gasUsed.toString(),
      deliveryAttemptEstimate: deliveryCost.toString(),
      credited: credited.toString(),
    });
  }

  // ---- Scenario C: a gas-limit sweep with the bomb armed ----
  console.log("\n[measure] scenario C: gas-limit sweep with a 120,832-byte revert bomb");
  const sweepToken = await transport.deploy(compiled.RevertBombBalanceToken);
  const sweepContract = transport.contract(compiled.RevertBombBalanceToken.abi, sweepToken);
  await transport.send(sweepToken, sweepContract.data("mint", [transport.account, 10n ** 6n]), {
    gas: 200000n,
  });
  await transport.send(sweepToken, sweepContract.data("approve", [htlcAddress, 10n ** 6n]), {
    gas: 200000n,
  });
  const sweepLimits = [];
  for (let limit = 80000n; limit <= 420000n; limit += 40000n) sweepLimits.push(limit);
  for (const limit of sweepLimits) {
    const secret = newSecret();
    await transport.send(sweepToken, sweepContract.data("disarm", []), { gas: 200000n });
    const lock = await transport.send(
      htlcAddress,
      htlc.data("lockToken", [secret.hashlock, rejector, sweepToken, 10n, await timeout()]),
      { gas: 400000n }
    );
    if (!lock.status) throw new Error("the sweep lock failed");
    await transport.send(sweepToken, sweepContract.data("arm", [120832n]), { gas: 200000n });
    const claim = await transport.send(htlcAddress, htlc.data("claim", [secret.hashlock, secret.preimage]), {
      gas: limit,
    });
    const state = await swapStatus(secret.hashlock);
    if (claim.status) {
      results.scenarioC.completed += 1;
      if (state.status !== 2n) fail(`sweep ${limit}: a completed claim left status ${state.status}`);
    } else {
      results.scenarioC.reverted += 1;
      if (state.status !== 1n) fail(`sweep ${limit}: a failed claim left status ${state.status}`);
      if (BigInt(state.preimage) !== 0n) fail(`sweep ${limit}: a failed claim stored a preimage`);
    }
    await transport.send(sweepToken, sweepContract.data("disarm", []), { gas: 200000n });
    await checkLedger(`sweep ${limit}`, sweepToken, [rejector]);
    results.scenarioC.sweep.push({
      gasLimit: limit.toString(),
      completed: claim.status,
      status: state.status.toString(),
    });
    console.log(`  limit ${limit}: completed=${claim.status} status=${state.status}`);
  }

  results.failures = failures;
  fs.writeFileSync(options.out, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\n[measure] wrote ${options.out}`);
  if (failures.length > 0) {
    console.log(`[measure] ${failures.length} bound violation(s)`);
    process.exitCode = 1;
    return;
  }
  console.log("[measure] every bound held");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
