// Local integration tests for the hypc-compiled HTLC artifact.
//
// Spawns a throwaway anvil instance, deploys the exact bytecode that ships
// to both chains, and drives every protocol path with ethers. This is the
// canonical test gate: there is no Solidity mirror and no Foundry suite,
// the artifact under test is the artifact that gets deployed.
//
// Usage: npm test   (requires anvil on PATH, ships with Foundry)

const { spawn } = require("child_process");
const path = require("path");
const { ethers } = require("ethers");
const { compileDirs } = require("./hypc");

const repoRoot = path.join(__dirname, "..");
const ANVIL_PORT = 8560;
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;

const sha256 = (preimage) => ethers.sha256(preimage);
const newSecret = () => {
  const preimage = ethers.hexlify(ethers.randomBytes(32));
  return { preimage, hashlock: sha256(preimage) };
};

let passed = 0;
let failed = 0;
const fail = (name, err) => {
  failed += 1;
  console.error(`  FAIL ${name}`);
  console.error(`       ${err.message || err}`);
};
const ok = (name) => {
  passed += 1;
  console.log(`  ok   ${name}`);
};

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function assertEq(actual, expected, msg) {
  const a = typeof actual === "bigint" ? actual.toString() : actual;
  const e = typeof expected === "bigint" ? expected.toString() : expected;
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}

// Expect a tx to revert for any reason (string requires from mock tokens).
async function expectAnyRevert(promise, what) {
  try {
    const tx = await promise;
    if (tx && tx.wait) await tx.wait();
  } catch {
    return;
  }
  throw new Error(`expected revert (${what}), but call succeeded`);
}

// Expect a tx (or estimate) to revert with the named custom error.
async function expectRevert(promise, errorName) {
  const selector = ethers.id(`${errorName}()`).slice(0, 10);
  try {
    const tx = await promise;
    if (tx && tx.wait) await tx.wait();
  } catch (err) {
    const seen = JSON.stringify(err, Object.getOwnPropertyNames(err));
    if (seen.includes(selector)) return;
    throw new Error(`reverted, but not with ${errorName} (${selector}); got: ${err.shortMessage || err.message}`);
  }
  throw new Error(`expected revert ${errorName}, but call succeeded`);
}

async function withTest(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

async function main() {
  console.log("[test] compiling contracts + mocks with hypc");
  const artifacts = compileDirs([
    path.join(repoRoot, "contracts", "hyperion"),
    path.join(repoRoot, "contracts", "test"),
    path.join(repoRoot, "contracts", "testnet"),
  ]);
  for (const required of [
    "HTLC",
    "MockERC20",
    "NoReturnToken",
    "FalseToken",
    "ApprovalRaceToken",
    "BlocklistToken",
    "FeeToken",
    "TestStable",
  ]) {
    if (!artifacts[required]) throw new Error(`missing artifact ${required}`);
  }

  console.log("[test] starting anvil");
  const anvil = spawn("anvil", ["--port", String(ANVIL_PORT), "--silent"], { stdio: "ignore" });
  const stopAnvil = () => {
    try {
      anvil.kill();
    } catch {}
  };
  process.on("exit", stopAnvil);

  // cacheTimeout -1: ethers caches identical RPC results for 250ms by
  // default, which serves stale nonces when anvil mines instantly.
  const provider = new ethers.JsonRpcProvider(RPC, undefined, {
    polling: true,
    pollingInterval: 50,
    cacheTimeout: -1,
  });
  for (let i = 0; ; i++) {
    try {
      await provider.getBlockNumber();
      break;
    } catch {
      if (i > 100) throw new Error("anvil did not come up");
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // anvil default funded accounts
  const signers = Array.from({ length: 4 }, (_, i) =>
    ethers.HDNodeWallet.fromPhrase(
      "test test test test test test test test test test test junk",
      undefined,
      `m/44'/60'/0'/0/${i}`
    ).connect(provider)
  );
  const [alice, bob, carol, relayer] = signers;

  const deploy = async (name, signer, args = []) => {
    const f = new ethers.ContractFactory(artifacts[name].abi, artifacts[name].bytecode, signer);
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    return c;
  };

  const now = async () => (await provider.getBlock("latest")).timestamp;
  const warpTo = async (t) => {
    await provider.send("evm_setNextBlockTimestamp", [t]);
    await provider.send("evm_mine", []);
  };

  const Status = { None: 0n, Open: 1n, Claimed: 2n, Refunded: 3n };
  const HOUR = 3600;

  console.log("[test] running scenarios\n");

  await withTest("lockNative stores the swap and holds the funds", async () => {
    const htlc = await deploy("HTLC", alice);
    const { hashlock } = newSecret();
    const timeout = (await now()) + 4 * HOUR;
    const amount = ethers.parseEther("1");
    await (await htlc.lockNative(hashlock, bob.address, timeout, { value: amount })).wait();
    const s = await htlc.getSwap(hashlock);
    assertEq(s.initiator, alice.address, "initiator");
    assertEq(s.recipient, bob.address, "recipient");
    assertEq(s.token, ethers.ZeroAddress, "token");
    assertEq(s.amount, amount, "amount");
    assertEq(s.status, Status.Open, "status");
    assertEq(await provider.getBalance(htlc.target), amount, "contract balance");
  });

  await withTest("claim is permissionless and pays only the fixed recipient", async () => {
    const htlc = await deploy("HTLC", alice);
    const { preimage, hashlock } = newSecret();
    const timeout = (await now()) + 4 * HOUR;
    const amount = ethers.parseEther("1");
    await (await htlc.lockNative(hashlock, bob.address, timeout, { value: amount })).wait();
    const bobBefore = await provider.getBalance(bob.address);
    // relayer submits the claim: sponsored claim, bob spends no gas
    await (await htlc.connect(relayer).claim(hashlock, preimage)).wait();
    assertEq((await provider.getBalance(bob.address)) - bobBefore, amount, "bob received");
    const s = await htlc.getSwap(hashlock);
    assertEq(s.status, Status.Claimed, "status");
    assertEq(s.preimage, preimage, "stored preimage");
  });

  await withTest("claim with a wrong preimage reverts", async () => {
    const htlc = await deploy("HTLC", alice);
    const { hashlock } = newSecret();
    const timeout = (await now()) + 4 * HOUR;
    await (await htlc.lockNative(hashlock, bob.address, timeout, { value: 1n })).wait();
    await expectRevert(htlc.claim(hashlock, ethers.hexlify(ethers.randomBytes(32))), "WrongPreimage");
  });

  await withTest("claim closes at timeout, refund opens at timeout", async () => {
    const htlc = await deploy("HTLC", alice);
    const { preimage, hashlock } = newSecret();
    const timeout = (await now()) + 2 * HOUR;
    const amount = ethers.parseEther("1");
    await (await htlc.lockNative(hashlock, bob.address, timeout, { value: amount })).wait();
    await expectRevert(htlc.refund(hashlock), "TimeoutNotReached");
    await warpTo(timeout);
    await expectRevert(htlc.claim(hashlock, preimage), "TimeoutPassed");
    const aliceBefore = await provider.getBalance(alice.address);
    await (await htlc.connect(relayer).refund(hashlock)).wait();
    assertEq((await provider.getBalance(alice.address)) - aliceBefore, amount, "alice refunded");
    assertEq((await htlc.getSwap(hashlock)).status, Status.Refunded, "status");
  });

  await withTest("settled swaps cannot be claimed or refunded again", async () => {
    const htlc = await deploy("HTLC", alice);
    const { preimage, hashlock } = newSecret();
    const timeout = (await now()) + 4 * HOUR;
    await (await htlc.lockNative(hashlock, bob.address, timeout, { value: 1n })).wait();
    await (await htlc.claim(hashlock, preimage)).wait();
    await expectRevert(htlc.claim(hashlock, preimage), "SwapNotOpen");
    await warpTo(timeout);
    await expectRevert(htlc.refund(hashlock), "SwapNotOpen");
  });

  await withTest("a hashlock is single-use forever (open, claimed, refunded)", async () => {
    const htlc = await deploy("HTLC", alice);
    const { preimage, hashlock } = newSecret();
    const timeout = (await now()) + 4 * HOUR;
    await (await htlc.lockNative(hashlock, bob.address, timeout, { value: 1n })).wait();
    await expectRevert(htlc.lockNative(hashlock, bob.address, timeout, { value: 1n }), "HashlockAlreadyUsed");
    await (await htlc.claim(hashlock, preimage)).wait();
    await expectRevert(
      htlc.lockNative(hashlock, bob.address, (await now()) + HOUR, { value: 1n }),
      "HashlockAlreadyUsed"
    );
  });

  await withTest("lock rejects invalid parameters", async () => {
    const htlc = await deploy("HTLC", alice);
    const { hashlock } = newSecret();
    const timeout = (await now()) + 4 * HOUR;
    await expectRevert(htlc.lockNative(hashlock, bob.address, timeout, { value: 0 }), "InvalidParams");
    await expectRevert(htlc.lockNative(hashlock, ethers.ZeroAddress, timeout, { value: 1n }), "InvalidParams");
    await expectRevert(htlc.lockNative(hashlock, bob.address, (await now()) - 1, { value: 1n }), "InvalidParams");
    await expectRevert(htlc.lockNative(ethers.ZeroHash, bob.address, timeout, { value: 1n }), "InvalidParams");
  });

  await withTest("lockToken + claim moves ERC-20 balances", async () => {
    const htlc = await deploy("HTLC", alice);
    const token = await deploy("MockERC20", alice);
    const amount = 1000n;
    await (await token.mint(alice.address, amount)).wait();
    await (await token.approve(htlc.target, amount)).wait();
    const { preimage, hashlock } = newSecret();
    const timeout = (await now()) + 4 * HOUR;
    await (await htlc.lockToken(hashlock, bob.address, token.target, amount, timeout)).wait();
    assertEq(await token.balanceOf(htlc.target), amount, "escrowed");
    await (await htlc.connect(relayer).claim(hashlock, preimage)).wait();
    assertEq(await token.balanceOf(bob.address), amount, "bob token balance");
    assertEq(await token.balanceOf(htlc.target), 0n, "contract drained");
  });

  await withTest("lockToken + refund returns ERC-20 to the initiator", async () => {
    const htlc = await deploy("HTLC", alice);
    const token = await deploy("MockERC20", alice);
    const amount = 500n;
    await (await token.mint(alice.address, amount)).wait();
    await (await token.approve(htlc.target, amount)).wait();
    const { hashlock } = newSecret();
    const timeout = (await now()) + 2 * HOUR;
    await (await htlc.lockToken(hashlock, bob.address, token.target, amount, timeout)).wait();
    await warpTo(timeout);
    await (await htlc.refund(hashlock)).wait();
    assertEq(await token.balanceOf(alice.address), amount, "alice refunded");
  });

  await withTest("no-return (USDT-style) tokens work", async () => {
    const htlc = await deploy("HTLC", alice);
    const token = await deploy("NoReturnToken", alice);
    const amount = 100n;
    await (await token.mint(alice.address, amount)).wait();
    await (await token.approve(htlc.target, amount)).wait();
    const { preimage, hashlock } = newSecret();
    await (await htlc.lockToken(hashlock, bob.address, token.target, amount, (await now()) + HOUR)).wait();
    await (await htlc.claim(hashlock, preimage)).wait();
    assertEq(await token.balanceOf(bob.address), amount, "bob token balance");
  });

  await withTest("false-returning tokens are rejected", async () => {
    const htlc = await deploy("HTLC", alice);
    const token = await deploy("FalseToken", alice);
    const { hashlock } = newSecret();
    await expectRevert(
      htlc.lockToken(hashlock, bob.address, token.target, 100n, (await now()) + HOUR),
      "TransferFailed"
    );
  });

  await withTest("USDT approval race: nonzero allowance must be reset to 0 first", async () => {
    const htlc = await deploy("HTLC", alice);
    const usdt = await deploy("ApprovalRaceToken", alice);
    const amount = 250n * 10n ** 6n; // 250 USDT, 6 decimals
    await (await usdt.mint(alice.address, amount)).wait();

    // A stale nonzero allowance (e.g. from an aborted earlier swap) cannot
    // be changed directly; the client must reset it to zero first.
    await (await usdt.approve(htlc.target, 1n)).wait();
    await expectAnyRevert(usdt.approve(htlc.target, amount), "nonzero -> nonzero approve");
    await (await usdt.approve(htlc.target, 0n)).wait();
    await (await usdt.approve(htlc.target, amount)).wait();

    const { preimage, hashlock } = newSecret();
    await (await htlc.lockToken(hashlock, bob.address, usdt.target, amount, (await now()) + HOUR)).wait();
    await (await htlc.claim(hashlock, preimage)).wait();
    assertEq(await usdt.balanceOf(bob.address), amount, "bob USDT balance");
  });

  await withTest("fee-on-transfer tokens are rejected at lock", async () => {
    const htlc = await deploy("HTLC", alice);
    const token = await deploy("FeeToken", alice);
    const amount = 1000n * 10n ** 6n;
    await (await token.mint(alice.address, amount)).wait();
    await (await token.approve(htlc.target, amount)).wait();
    const { hashlock } = newSecret();
    await expectRevert(
      htlc.lockToken(hashlock, bob.address, token.target, amount, (await now()) + HOUR),
      "UnsupportedToken"
    );
    assertEq(await token.balanceOf(htlc.target), 0n, "nothing escrowed");
  });

  await withTest("issuer blocklist: blocked recipient cannot claim, refund recovers", async () => {
    const htlc = await deploy("HTLC", alice);
    const usdc = await deploy("BlocklistToken", alice);
    const amount = 500n * 10n ** 6n;
    await (await usdc.mint(alice.address, amount)).wait();
    await (await usdc.approve(htlc.target, amount)).wait();
    const { preimage, hashlock } = newSecret();
    const timeout = (await now()) + 2 * HOUR;
    await (await htlc.lockToken(hashlock, bob.address, usdc.target, amount, timeout)).wait();

    // Issuer blocks the recipient after lock: claim cannot pay out.
    await (await usdc.setBlocked(bob.address, true)).wait();
    await expectRevert(htlc.claim(hashlock, preimage), "TransferFailed");

    // Funds are not stranded: the refund path still pays the initiator.
    await warpTo(timeout);
    await (await htlc.refund(hashlock)).wait();
    assertEq(await usdc.balanceOf(alice.address), amount, "alice refunded");

    // Documented residual risk: a blocked INITIATOR strands the refund
    // until the issuer unblocks them (see ARCHITECTURE.md).
    const second = newSecret();
    await (await usdc.approve(htlc.target, amount)).wait();
    const timeout2 = (await now()) + HOUR;
    await (await htlc.lockToken(second.hashlock, bob.address, usdc.target, amount, timeout2)).wait();
    await (await usdc.setBlocked(alice.address, true)).wait();
    await warpTo(timeout2);
    await expectRevert(htlc.refund(second.hashlock), "TransferFailed");
    await (await usdc.setBlocked(alice.address, false)).wait();
    await (await htlc.refund(second.hashlock)).wait();
    assertEq(await usdc.balanceOf(alice.address), amount, "alice refunded after unblock");
  });

  await withTest("config/tokens.json registry is well-formed", async () => {
    const registry = JSON.parse(
      require("fs").readFileSync(path.join(repoRoot, "config", "tokens.json"), "utf8")
    );
    for (const chainId of ["1", "11155111", "1337"]) {
      assert(registry.chains[chainId], `chain ${chainId} present`);
    }
    for (const [chainId, chain] of Object.entries(registry.chains)) {
      assert(chain.leg === "ethereum" || chain.leg === "qrl", `chain ${chainId} leg`);
      const entries = [...chain.tokens, ...(chain.native ? [chain.native] : [])];
      for (const t of entries) {
        assert(Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 18, `${t.symbol} decimals`);
        ethers.parseUnits(t.minLockAmount, t.decimals); // throws if malformed
        if ("address" in t && t.address !== null) {
          assertEq(ethers.getAddress(t.address), t.address, `${t.symbol} checksummed address`);
        }
      }
    }
    // Ethereum mainnet launch set is exactly WETH + USDC + USDT.
    assertEq(
      registry.chains["1"].tokens.map((t) => t.symbol).join(","),
      "WETH,USDC,USDT",
      "mainnet asset set"
    );
  });

  await withTest("lockToken rejects the zero address and EOAs as token", async () => {
    const htlc = await deploy("HTLC", alice);
    const { hashlock } = newSecret();
    const timeout = (await now()) + HOUR;
    await expectRevert(htlc.lockToken(hashlock, bob.address, ethers.ZeroAddress, 1n, timeout), "InvalidParams");
    await expectRevert(htlc.lockToken(hashlock, bob.address, carol.address, 1n, timeout), "InvalidParams");
  });

  await withTest("native claim to a non-payable recipient reverts, refund still works", async () => {
    const htlc = await deploy("HTLC", alice);
    const sink = await deploy("FalseToken", alice); // no receive function
    const { preimage, hashlock } = newSecret();
    const timeout = (await now()) + 2 * HOUR;
    await (await htlc.lockNative(hashlock, sink.target, timeout, { value: 1n })).wait();
    await expectRevert(htlc.claim(hashlock, preimage), "TransferFailed");
    await warpTo(timeout);
    await (await htlc.refund(hashlock)).wait(); // funds are not stranded
    assertEq((await htlc.getSwap(hashlock)).status, Status.Refunded, "status");
  });

  await withTest("full cross-chain atomic swap (two instances, timelock asymmetry)", async () => {
    // "Ethereum leg": WETH stand-in token. "QRL leg": native coin.
    const ethLeg = await deploy("HTLC", carol);
    const qrlLeg = await deploy("HTLC", carol);
    const weth = await deploy("MockERC20", carol);

    const wethAmount = 10_000n;
    const qrlAmount = ethers.parseEther("2");
    await (await weth.mint(alice.address, wethAmount)).wait();

    // Alice (initiator, has WETH, wants QRL) picks the secret.
    const { preimage, hashlock } = newSecret();
    const t0 = await now();
    const T1 = t0 + 4 * HOUR; // initiator leg, longer
    const T2 = t0 + 2 * HOUR; // responder leg, shorter

    // 1. Alice locks WETH for Bob on the Ethereum leg.
    await (await weth.connect(alice).approve(ethLeg.target, wethAmount)).wait();
    await (await ethLeg.connect(alice).lockToken(hashlock, bob.address, weth.target, wethAmount, T1)).wait();

    // 2. Bob observes the lock and responds with native QRL for Alice.
    await (await qrlLeg.connect(bob).lockNative(hashlock, alice.address, T2, { value: qrlAmount })).wait();

    // 3. Alice claims the QRL leg, revealing the preimage on-chain.
    const aliceBefore = await provider.getBalance(alice.address);
    await (await qrlLeg.connect(relayer).claim(hashlock, preimage)).wait(); // sponsored
    assertEq((await provider.getBalance(alice.address)) - aliceBefore, qrlAmount, "alice got QRL");

    // 4. Bob reads the now-public preimage from the QRL leg and claims the WETH.
    const revealed = (await qrlLeg.getSwap(hashlock)).preimage;
    assertEq(revealed, preimage, "preimage public");
    await (await ethLeg.connect(bob).claim(hashlock, revealed)).wait();
    assertEq(await weth.balanceOf(bob.address), wethAmount, "bob got WETH");
  });

  await withTest("full cross-chain stable swap: tUSDT (USDT semantics, 6 decimals) vs native QRL", async () => {
    // Runs the deployable TestStable artifact through the whole protocol
    // path, exercising the USDT-hard case: 6 decimals, no return values,
    // approval race guard.
    const ethLeg = await deploy("HTLC", carol);
    const qrlLeg = await deploy("HTLC", carol);
    const usdt = await deploy("TestStable", carol);

    const usdtAmount = 2_500n * 10n ** 6n; // 2,500 tUSDT
    const qrlAmount = ethers.parseEther("3000");
    await (await usdt.connect(alice).faucet()).wait();

    const { preimage, hashlock } = newSecret();
    const t0 = await now();
    const T1 = t0 + 4 * HOUR;
    const T2 = t0 + 2 * HOUR;

    // 1. Alice locks tUSDT for Bob on the Ethereum leg (exact approval).
    await (await usdt.connect(alice).approve(ethLeg.target, usdtAmount)).wait();
    await (await ethLeg.connect(alice).lockToken(hashlock, bob.address, usdt.target, usdtAmount, T1)).wait();
    assertEq(await usdt.balanceOf(ethLeg.target), usdtAmount, "escrowed");
    // transferFrom consumed the exact allowance, so no reset is needed
    // before the next swap's approve.
    assertEq(await usdt.allowance(alice.address, ethLeg.target), 0n, "allowance consumed");

    // 2. Bob responds with native QRL.
    await (await qrlLeg.connect(bob).lockNative(hashlock, alice.address, T2, { value: qrlAmount })).wait();

    // 3. Alice claims the QRL leg (sponsored), revealing the preimage.
    const aliceBefore = await provider.getBalance(alice.address);
    await (await qrlLeg.connect(relayer).claim(hashlock, preimage)).wait();
    assertEq((await provider.getBalance(alice.address)) - aliceBefore, qrlAmount, "alice got QRL");

    // 4. Bob claims the tUSDT with the now-public preimage.
    const revealed = (await qrlLeg.getSwap(hashlock)).preimage;
    await (await ethLeg.connect(bob).claim(hashlock, revealed)).wait();
    assertEq(await usdt.balanceOf(bob.address), usdtAmount, "bob got tUSDT");
  });

  await withTest("abandoned swap: both legs refund cleanly (free option outcome)", async () => {
    const ethLeg = await deploy("HTLC", carol);
    const qrlLeg = await deploy("HTLC", carol);
    const weth = await deploy("MockERC20", carol);
    const wethAmount = 777n;
    await (await weth.mint(alice.address, wethAmount)).wait();

    const { hashlock } = newSecret(); // secret is never revealed
    const t0 = await now();
    const T1 = t0 + 4 * HOUR;
    const T2 = t0 + 2 * HOUR;

    await (await weth.connect(alice).approve(ethLeg.target, wethAmount)).wait();
    await (await ethLeg.connect(alice).lockToken(hashlock, bob.address, weth.target, wethAmount, T1)).wait();
    const qrlAmount = ethers.parseEther("1");
    await (await qrlLeg.connect(bob).lockNative(hashlock, alice.address, T2, { value: qrlAmount })).wait();

    await warpTo(T2); // responder exits first
    const bobBefore = await provider.getBalance(bob.address);
    await (await qrlLeg.connect(relayer).refund(hashlock)).wait();
    assertEq((await provider.getBalance(bob.address)) - bobBefore, qrlAmount, "bob refunded");

    await warpTo(T1);
    await (await ethLeg.connect(relayer).refund(hashlock)).wait();
    assertEq(await weth.balanceOf(alice.address), wethAmount, "alice refunded");
  });

  stopAnvil();
  console.log(`\n[test] ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
