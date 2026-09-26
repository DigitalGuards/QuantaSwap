// Local integration tests for the hypc-compiled HTLCv3 artifact.
//
// Spawns a throwaway anvil instance, deploys the exact bytecode that would
// ship to both chains, and drives every protocol path with ethers. Same
// discipline as scripts/test-local.js: there is no Solidity mirror and no
// Foundry suite, the artifact under test is the artifact that gets deployed.
//
// Coverage is organised in three parts:
//   1. HTLCv2 parity: every property HTLCv3 inherits still holds.
//   2. Issue #47: a payout that cannot be delivered becomes a conserved
//      credit owned by the payee, and never rolls back the claim.
//   3. Value conservation and terminal-state invariants, asserted after
//      every step of a mixed multi-swap sequence.
//
// Usage: npm test   (requires anvil on PATH, ships with Foundry)

const { spawn } = require("child_process");
const path = require("path");
const { ethers } = require("ethers");
const { compileDirs } = require("./hypc");

const repoRoot = path.join(__dirname, "..");
const ANVIL_PORT = 8561;
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;

const sha256 = (preimage) => ethers.sha256(preimage);
const newSecret = () => {
  const preimage = ethers.hexlify(ethers.randomBytes(32));
  return { preimage, hashlock: sha256(preimage) };
};

const ERC20_VIEW_ABI = ["function balanceOf(address) view returns (uint256)"];

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
    throw new Error(
      `reverted, but not with ${errorName} (${selector}); got: ${err.shortMessage || err.message}`
    );
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

const Status = { None: 0n, Open: 1n, Claimed: 2n, Refunded: 3n };
const HOUR = 3600;

// Mirrors HTLCv3's delivery gas policy. A bare gas estimate minimises gas and
// therefore lands on the credit path, which is cheaper than a successful token
// transfer; a settlement that should deliver directly has to reserve the
// delivery budget plus the credit reserve on top of the estimate. The contract
// publishes both numbers through deliveryGasPolicy() and this is the rule
// every integration has to follow.
const DELIVERY_GAS_LIMIT = 100_000n;
const DELIVERY_GAS_RESERVE = 70_000n;
const SETTLE_GAS_BUFFER = DELIVERY_GAS_LIMIT + DELIVERY_GAS_RESERVE;

// Submit a settlement (claim, refund, release) the way an integration must.
async function settle(method, ...args) {
  const gasLimit = (await method.estimateGas(...args)) + SETTLE_GAS_BUFFER;
  const tx = await method(...args, { gasLimit });
  return tx.wait();
}

async function main() {
  console.log("[htlcv3] compiling contracts + mocks with hypc");
  const artifacts = compileDirs(
    [
      path.join(repoRoot, "contracts", "hyperion"),
      path.join(repoRoot, "contracts", "test"),
      path.join(repoRoot, "contracts", "testnet"),
    ],
    "evm"
  );
  for (const required of [
    "HTLCv3",
    "MockERC20",
    "NoReturnToken",
    "FalseToken",
    "BlocklistToken",
    "FeeToken",
    "FalseTransferToken",
    "RevertingTransferToken",
    "ReturnBombToken",
    "NonPayableRecipient",
    "GasGuzzlerRecipient",
    "ReentrantRecipient",
  ]) {
    if (!artifacts[required]) throw new Error(`missing artifact ${required}`);
  }

  // The credit ledger is keyed by (token, account) with account-width keys.
  // A compiler-generated getter over those mappings would be truncated by
  // legacy QRVM-512 codegen, so HTLCv3 must expose explicit views only.
  const htlcAbi = artifacts.HTLCv3.abi;
  for (const name of ["creditOf", "outstandingCredit", "getSwap"]) {
    const entry = htlcAbi.find((e) => e.type === "function" && e.name === name);
    assert(entry !== undefined, `HTLCv3 exposes ${name}`);
    assert(entry.stateMutability === "view", `${name} is a view`);
  }
  assertEq(
    htlcAbi.find((e) => e.type === "function" && e.name === "creditOf").inputs.length,
    2,
    "creditOf takes (token, account)"
  );

  console.log("[htlcv3] starting anvil");
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
  const signers = Array.from({ length: 5 }, (_, i) =>
    ethers.HDNodeWallet.fromPhrase(
      "test test test test test test test test test test test junk",
      undefined,
      `m/44'/60'/0'/0/${i}`
    ).connect(provider)
  );
  const [alice, bob, carol, relayer, dave] = signers;

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

  const heldBy = async (token, holder) =>
    token === ethers.ZeroAddress
      ? provider.getBalance(holder)
      : new ethers.Contract(token, ERC20_VIEW_ABI, provider).balanceOf(holder);

  // Tracks every swap created against one HTLC instance and re-derives the
  // conservation invariant from on-chain state, so no test can drift from a
  // hand-maintained expectation:
  //
  //   held(token) == sum(Open swap amounts in token) + outstandingCredit(token)
  //
  // The assertion uses equality. The general invariant is >=, and nothing in
  // this suite force-feeds the contract native value.
  const makeTracker = (htlc) => {
    const swaps = [];
    const tokens = new Set([ethers.ZeroAddress]);
    return {
      track(hashlock, token) {
        swaps.push(hashlock);
        tokens.add(token);
        return hashlock;
      },
      async check(label) {
        const open = new Map();
        for (const hashlock of swaps) {
          const s = await htlc.getSwap(hashlock);
          assert(s.status !== Status.None, `${label}: tracked swap ${hashlock} exists`);
          if (s.status === Status.Open) {
            open.set(s.token, (open.get(s.token) ?? 0n) + s.amount);
            continue;
          }
          assert(
            s.status === Status.Claimed || s.status === Status.Refunded,
            `${label}: ${hashlock} is Open or terminal`
          );
          if (s.status === Status.Claimed) {
            assert(s.preimage !== ethers.ZeroHash, `${label}: ${hashlock} kept its preimage`);
          }
        }
        for (const token of tokens) {
          const held = await heldBy(token, htlc.target);
          const credited = await htlc.outstandingCredit(token);
          assertEq(
            held,
            (open.get(token) ?? 0n) + credited,
            `${label}: value conservation for token ${token}`
          );
        }
      },
    };
  };

  const creditedEvents = (htlc, receipt) =>
    receipt.logs
      .map((l) => {
        try {
          return htlc.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .filter((p) => p && p.name === "PayoutCredited");

  console.log("[htlcv3] running scenarios\n");

  // ---------------------------------------------------------------- part 1
  // HTLCv2 parity: nothing the deployed contract guarantees was dropped.
  // ------------------------------------------------------------------------

  await withTest("parity: lockNative stores the swap and holds the funds", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const track = makeTracker(htlc);
    const { hashlock } = newSecret();
    const timeout = (await now()) + 4 * HOUR;
    const amount = ethers.parseEther("1");
    await (await htlc.lockNative(hashlock, bob.address, timeout, { value: amount })).wait();
    track.track(hashlock, ethers.ZeroAddress);
    const s = await htlc.getSwap(hashlock);
    assertEq(s.initiator, alice.address, "initiator");
    assertEq(s.recipient, bob.address, "recipient");
    assertEq(s.token, ethers.ZeroAddress, "token");
    assertEq(s.amount, amount, "amount");
    assertEq(s.timeout, BigInt(timeout), "timeout");
    assertEq(s.status, Status.Open, "status");
    assertEq(s.preimage, ethers.ZeroHash, "no preimage yet");
    await track.check("after lockNative");
  });

  await withTest("parity: claim is permissionless and pays only the fixed recipient", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const track = makeTracker(htlc);
    const { preimage, hashlock } = newSecret();
    const timeout = (await now()) + 4 * HOUR;
    const amount = ethers.parseEther("1");
    await (await htlc.lockNative(hashlock, bob.address, timeout, { value: amount })).wait();
    track.track(hashlock, ethers.ZeroAddress);
    const bobBefore = await provider.getBalance(bob.address);
    // relayer submits the claim: sponsored claim, bob spends no gas
    const receipt = await settle(htlc.connect(relayer).claim, hashlock, preimage);
    assertEq((await provider.getBalance(bob.address)) - bobBefore, amount, "bob received");
    const s = await htlc.getSwap(hashlock);
    assertEq(s.status, Status.Claimed, "status");
    assertEq(s.preimage, preimage, "stored preimage");
    assertEq(creditedEvents(htlc, receipt).length, 0, "direct delivery emits no PayoutCredited");
    assertEq(await htlc.creditOf(ethers.ZeroAddress, bob.address), 0n, "no credit");
    await track.check("after direct claim");
  });

  await withTest("parity: claim with a wrong preimage reverts", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const { hashlock } = newSecret();
    const timeout = (await now()) + 4 * HOUR;
    await (await htlc.lockNative(hashlock, bob.address, timeout, { value: 1n })).wait();
    await expectRevert(
      htlc.claim(hashlock, ethers.hexlify(ethers.randomBytes(32))),
      "WrongPreimage"
    );
  });

  await withTest("parity: claim closes at timeout, refund opens at timeout", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const { preimage, hashlock } = newSecret();
    const timeout = (await now()) + 2 * HOUR;
    const amount = ethers.parseEther("1");
    await (await htlc.lockNative(hashlock, bob.address, timeout, { value: amount })).wait();
    await expectRevert(htlc.refund(hashlock), "TimeoutNotReached");
    await warpTo(timeout);
    await expectRevert(htlc.claim(hashlock, preimage), "TimeoutPassed");
    const aliceBefore = await provider.getBalance(alice.address);
    await settle(htlc.connect(relayer).refund, hashlock);
    assertEq((await provider.getBalance(alice.address)) - aliceBefore, amount, "alice refunded");
    assertEq((await htlc.getSwap(hashlock)).status, Status.Refunded, "status");
  });

  await withTest("parity: settled swaps cannot be claimed or refunded again", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const { preimage, hashlock } = newSecret();
    const timeout = (await now()) + 4 * HOUR;
    await (await htlc.lockNative(hashlock, bob.address, timeout, { value: 1n })).wait();
    await (await htlc.claim(hashlock, preimage)).wait();
    await expectRevert(htlc.claim(hashlock, preimage), "SwapNotOpen");
    await warpTo(timeout);
    await expectRevert(htlc.refund(hashlock), "SwapNotOpen");
  });

  await withTest("parity: a hashlock is single-use forever", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const { preimage, hashlock } = newSecret();
    const timeout = (await now()) + 4 * HOUR;
    await (await htlc.lockNative(hashlock, bob.address, timeout, { value: 1n })).wait();
    await expectRevert(
      htlc.lockNative(hashlock, bob.address, timeout, { value: 1n }),
      "HashlockAlreadyUsed"
    );
    await (await htlc.claim(hashlock, preimage)).wait();
    await expectRevert(
      htlc.lockNative(hashlock, bob.address, (await now()) + HOUR, { value: 1n }),
      "HashlockAlreadyUsed"
    );
    await expectRevert(
      htlc.lockNativeOpen(hashlock, (await now()) + HOUR, { value: 1n }),
      "HashlockAlreadyUsed"
    );
  });

  await withTest("parity: lock rejects invalid parameters, including the HTLC itself", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const { hashlock } = newSecret();
    const timeout = (await now()) + 4 * HOUR;
    await expectRevert(htlc.lockNative(hashlock, bob.address, timeout, { value: 0 }), "InvalidParams");
    await expectRevert(
      htlc.lockNative(hashlock, ethers.ZeroAddress, timeout, { value: 1n }),
      "InvalidParams"
    );
    await expectRevert(
      htlc.lockNative(hashlock, bob.address, (await now()) - 1, { value: 1n }),
      "InvalidParams"
    );
    await expectRevert(htlc.lockNative(ethers.ZeroHash, bob.address, timeout, { value: 1n }), "InvalidParams");
    // New in v3: the HTLC can never be its own payout target. A native push
    // to itself would fail into a credit nobody can move, and a token push
    // would leave the escrow accounting inconsistent.
    await expectRevert(htlc.lockNative(hashlock, htlc.target, timeout, { value: 1n }), "InvalidParams");
  });

  await withTest("parity: lockToken + claim moves ERC-20 balances", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const track = makeTracker(htlc);
    const token = await deploy("MockERC20", alice);
    const amount = 1000n;
    await (await token.mint(alice.address, amount)).wait();
    await (await token.approve(htlc.target, amount)).wait();
    const { preimage, hashlock } = newSecret();
    const timeout = (await now()) + 4 * HOUR;
    await (await htlc.lockToken(hashlock, bob.address, token.target, amount, timeout)).wait();
    track.track(hashlock, token.target);
    assertEq(await token.balanceOf(htlc.target), amount, "escrowed");
    await track.check("token lock");
    await settle(htlc.connect(relayer).claim, hashlock, preimage);
    assertEq(await token.balanceOf(bob.address), amount, "bob token balance");
    assertEq(await token.balanceOf(htlc.target), 0n, "contract drained");
    await track.check("token claim");
  });

  await withTest("parity: lockToken + refund returns ERC-20 to the initiator", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const token = await deploy("MockERC20", alice);
    const amount = 500n;
    await (await token.mint(alice.address, amount)).wait();
    await (await token.approve(htlc.target, amount)).wait();
    const { hashlock } = newSecret();
    const timeout = (await now()) + 2 * HOUR;
    await (await htlc.lockToken(hashlock, bob.address, token.target, amount, timeout)).wait();
    await warpTo(timeout);
    await settle(htlc.refund, hashlock);
    assertEq(await token.balanceOf(alice.address), amount, "alice refunded");
  });

  await withTest("parity: no-return (USDT-style) tokens deliver directly", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const track = makeTracker(htlc);
    const token = await deploy("NoReturnToken", alice);
    const amount = 100n;
    await (await token.mint(alice.address, amount)).wait();
    await (await token.approve(htlc.target, amount)).wait();
    const { preimage, hashlock } = newSecret();
    await (
      await htlc.lockToken(hashlock, bob.address, token.target, amount, (await now()) + HOUR)
    ).wait();
    track.track(hashlock, token.target);
    const receipt = await settle(htlc.claim, hashlock, preimage);
    assertEq(await token.balanceOf(bob.address), amount, "bob token balance");
    assertEq(creditedEvents(htlc, receipt).length, 0, "no-return token needs no credit");
    await track.check("no-return token claim");
  });

  await withTest("parity: a token that declines transferFrom cannot be locked", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const token = await deploy("FalseToken", alice);
    const { hashlock } = newSecret();
    await expectRevert(
      htlc.lockToken(hashlock, bob.address, token.target, 100n, (await now()) + HOUR),
      "TransferFailed"
    );
  });

  await withTest("parity: fee-on-transfer tokens are rejected at both lock entries", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const token = await deploy("FeeToken", alice);
    const amount = 1000n * 10n ** 6n;
    await (await token.mint(alice.address, amount * 2n)).wait();
    await (await token.approve(htlc.target, amount * 2n)).wait();
    const first = newSecret();
    const second = newSecret();
    await expectRevert(
      htlc.lockToken(first.hashlock, bob.address, token.target, amount, (await now()) + HOUR),
      "UnsupportedToken"
    );
    await expectRevert(
      htlc.lockTokenOpen(second.hashlock, token.target, amount, (await now()) + HOUR),
      "UnsupportedToken"
    );
    assertEq(await token.balanceOf(htlc.target), 0n, "nothing escrowed");
    assertEq((await htlc.getSwap(first.hashlock)).status, Status.None, "no record kept");
  });

  await withTest("parity: lockToken rejects the zero address and EOAs as token", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const { hashlock } = newSecret();
    const timeout = (await now()) + HOUR;
    await expectRevert(
      htlc.lockToken(hashlock, bob.address, ethers.ZeroAddress, 1n, timeout),
      "InvalidParams"
    );
    await expectRevert(htlc.lockToken(hashlock, bob.address, carol.address, 1n, timeout), "InvalidParams");
  });

  await withTest("parity: open locks, assign write-once, release, NotAssigned guard", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const track = makeTracker(htlc);
    const first = newSecret();
    const timeout = (await now()) + 4 * HOUR;
    const amount = ethers.parseEther("1");
    await (await htlc.lockNativeOpen(first.hashlock, timeout, { value: amount })).wait();
    track.track(first.hashlock, ethers.ZeroAddress);
    assertEq((await htlc.getSwap(first.hashlock)).recipient, ethers.ZeroAddress, "recipient unset");
    await expectRevert(htlc.connect(relayer).claim(first.hashlock, first.preimage), "NotAssigned");
    await expectRevert(htlc.connect(bob).assign(first.hashlock, bob.address), "NotInitiator");
    await expectRevert(htlc.assign(first.hashlock, ethers.ZeroAddress), "InvalidParams");
    await expectRevert(htlc.assign(first.hashlock, htlc.target), "InvalidParams");
    await (await htlc.assign(first.hashlock, bob.address)).wait();
    await expectRevert(htlc.assign(first.hashlock, carol.address), "AlreadyAssigned");
    await expectRevert(htlc.release(first.hashlock), "AlreadyAssigned");
    const bobBefore = await provider.getBalance(bob.address);
    await settle(htlc.connect(relayer).claim, first.hashlock, first.preimage);
    assertEq((await provider.getBalance(bob.address)) - bobBefore, amount, "assigned recipient paid");
    await track.check("assigned claim");

    // release: initiator-only, immediate, blocked once assigned.
    const second = newSecret();
    await (await htlc.lockNativeOpen(second.hashlock, timeout, { value: amount })).wait();
    track.track(second.hashlock, ethers.ZeroAddress);
    await expectRevert(htlc.connect(bob).release(second.hashlock), "NotInitiator");
    const before = await provider.getBalance(alice.address);
    const receipt = await settle(htlc.release, second.hashlock);
    const gas = receipt.gasUsed * receipt.gasPrice;
    assertEq((await provider.getBalance(alice.address)) - before + gas, amount, "alice repaid in full");
    assertEq((await htlc.getSwap(second.hashlock)).status, Status.Refunded, "status Refunded");
    await expectRevert(htlc.release(second.hashlock), "SwapNotOpen");
    await track.check("after release");

    // Past timeout the claim window is closed and refund is open: no assign.
    const late = newSecret();
    const lateTimeout = (await now()) + HOUR;
    await (await htlc.lockNativeOpen(late.hashlock, lateTimeout, { value: 1n })).wait();
    track.track(late.hashlock, ethers.ZeroAddress);
    await warpTo(lateTimeout);
    await expectRevert(htlc.assign(late.hashlock, bob.address), "TimeoutPassed");
    await settle(htlc.release, late.hashlock);
    await track.check("late release");
  });

  await withTest("parity: full cross-chain atomic swap across two instances", async () => {
    const ethLeg = await deploy("HTLCv3", carol);
    const qrlLeg = await deploy("HTLCv3", carol);
    const weth = await deploy("MockERC20", carol);

    const wethAmount = 10_000n;
    const qrlAmount = ethers.parseEther("2");
    await (await weth.mint(alice.address, wethAmount)).wait();

    const { preimage, hashlock } = newSecret();
    const t0 = await now();
    const T1 = t0 + 4 * HOUR; // initiator leg, longer
    const T2 = t0 + 2 * HOUR; // responder leg, shorter

    await (await weth.connect(alice).approve(ethLeg.target, wethAmount)).wait();
    await (
      await ethLeg.connect(alice).lockToken(hashlock, bob.address, weth.target, wethAmount, T1)
    ).wait();
    await (await qrlLeg.connect(bob).lockNative(hashlock, alice.address, T2, { value: qrlAmount })).wait();

    const aliceBefore = await provider.getBalance(alice.address);
    await settle(qrlLeg.connect(relayer).claim, hashlock, preimage); // sponsored
    assertEq((await provider.getBalance(alice.address)) - aliceBefore, qrlAmount, "alice got QRL");

    const revealed = (await qrlLeg.getSwap(hashlock)).preimage;
    assertEq(revealed, preimage, "preimage public");
    await settle(ethLeg.connect(bob).claim, hashlock, revealed);
    assertEq(await weth.balanceOf(bob.address), wethAmount, "bob got WETH");
  });

  // ---------------------------------------------------------------- part 2
  // Issue #47: undeliverable payouts become conserved credits.
  // ------------------------------------------------------------------------

  await withTest("#47 native: a nonpayable recipient ends the claim as a credit", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const track = makeTracker(htlc);
    const sink = await deploy("FalseToken", alice); // no receive, no fallback
    const { preimage, hashlock } = newSecret();
    const timeout = (await now()) + 2 * HOUR;
    const amount = ethers.parseEther("1");
    await (await htlc.lockNative(hashlock, sink.target, timeout, { value: amount })).wait();
    track.track(hashlock, ethers.ZeroAddress);

    const receipt = await (await htlc.connect(relayer).claim(hashlock, preimage)).wait();
    assertEq(receipt.status, 1, "claim transaction succeeded");
    const s = await htlc.getSwap(hashlock);
    assertEq(s.status, Status.Claimed, "claim is terminal");
    assertEq(s.preimage, preimage, "preimage persisted despite the failed payout");
    const credited = creditedEvents(htlc, receipt);
    assertEq(credited.length, 1, "PayoutCredited emitted");
    assertEq(credited[0].args.token, ethers.ZeroAddress, "credit token");
    assertEq(credited[0].args.account, sink.target, "credit account");
    assertEq(credited[0].args.hashlock, hashlock, "credit hashlock");
    assertEq(credited[0].args.amount, amount, "credit amount");
    assertEq(await htlc.creditOf(ethers.ZeroAddress, sink.target), amount, "credit recorded");
    assertEq(await htlc.outstandingCredit(ethers.ZeroAddress), amount, "outstanding total");
    assertEq(await provider.getBalance(htlc.target), amount, "funds still held");
    await track.check("native credit");

    // The claim is terminal: no refund path can hand this to the initiator.
    await warpTo(timeout);
    await expectRevert(htlc.refund(hashlock), "SwapNotOpen");
    assertEq(await htlc.creditOf(ethers.ZeroAddress, alice.address), 0n, "initiator gets nothing");
    await track.check("native credit after timeout");
  });

  await withTest("#47 token: an issuer blocklist on the recipient credits, then withdraws", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const track = makeTracker(htlc);
    const usdc = await deploy("BlocklistToken", alice);
    const amount = 500n * 10n ** 6n;
    await (await usdc.mint(alice.address, amount)).wait();
    await (await usdc.approve(htlc.target, amount)).wait();
    const { preimage, hashlock } = newSecret();
    const timeout = (await now()) + 2 * HOUR;
    await (await htlc.lockToken(hashlock, bob.address, usdc.target, amount, timeout)).wait();
    track.track(hashlock, usdc.target);

    // Issuer blocks the recipient after the lock, so the payout cannot land.
    await (await usdc.setBlocked(bob.address, true)).wait();
    const receipt = await (await htlc.connect(relayer).claim(hashlock, preimage)).wait();
    assertEq(receipt.status, 1, "claim transaction succeeded");
    assertEq((await htlc.getSwap(hashlock)).status, Status.Claimed, "claim is terminal");
    assertEq((await htlc.getSwap(hashlock)).preimage, preimage, "preimage persisted");
    assertEq(await htlc.creditOf(usdc.target, bob.address), amount, "recipient credited");
    assertEq(await usdc.balanceOf(htlc.target), amount, "escrow still held");
    await track.check("blocked recipient credit");

    // Still blocked: the withdrawal reverts and the credit stays intact.
    await expectRevert(htlc.connect(bob).withdrawAll(usdc.target, bob.address), "TransferFailed");
    assertEq(await htlc.creditOf(usdc.target, bob.address), amount, "credit untouched");

    // The recipient can name an unblocked destination without waiting for
    // the issuer: this is the alternate payout address path.
    await (await htlc.connect(bob).withdraw(usdc.target, carol.address, amount)).wait();
    assertEq(await usdc.balanceOf(carol.address), amount, "alternate destination paid");
    assertEq(await htlc.creditOf(usdc.target, bob.address), 0n, "credit consumed");
    assertEq(await htlc.outstandingCredit(usdc.target), 0n, "outstanding cleared");
    await track.check("after alternate-destination withdraw");
  });

  await withTest("#47 token: an HTLC-wide freeze credits every settlement", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const track = makeTracker(htlc);
    const usdc = await deploy("BlocklistToken", alice);
    const amount = 100n * 10n ** 6n;
    await (await usdc.mint(alice.address, amount * 2n)).wait();
    await (await usdc.approve(htlc.target, amount * 2n)).wait();
    const claimed = newSecret();
    const refunded = newSecret();
    const timeout = (await now()) + 2 * HOUR;
    await (await htlc.lockToken(claimed.hashlock, bob.address, usdc.target, amount, timeout)).wait();
    await (await htlc.lockToken(refunded.hashlock, bob.address, usdc.target, amount, timeout)).wait();
    track.track(claimed.hashlock, usdc.target);
    track.track(refunded.hashlock, usdc.target);

    // The issuer freezes the HTLC contract itself: nothing can leave.
    await (await usdc.setBlocked(htlc.target, true)).wait();
    await (await htlc.connect(relayer).claim(claimed.hashlock, claimed.preimage)).wait();
    assertEq((await htlc.getSwap(claimed.hashlock)).status, Status.Claimed, "claim still terminal");
    assertEq(await htlc.creditOf(usdc.target, bob.address), amount, "recipient credited");

    await warpTo(timeout);
    await (await htlc.connect(relayer).refund(refunded.hashlock)).wait();
    assertEq((await htlc.getSwap(refunded.hashlock)).status, Status.Refunded, "refund still terminal");
    assertEq(await htlc.creditOf(usdc.target, alice.address), amount, "initiator credited");
    assertEq(await htlc.outstandingCredit(usdc.target), amount * 2n, "both credits outstanding");
    await track.check("frozen HTLC");

    // No withdrawal can succeed while the freeze holds.
    await expectRevert(htlc.connect(bob).withdrawAll(usdc.target, bob.address), "TransferFailed");
    await expectRevert(htlc.withdrawAll(usdc.target, alice.address), "TransferFailed");

    await (await usdc.setBlocked(htlc.target, false)).wait();
    await (await htlc.connect(bob).withdrawAll(usdc.target, bob.address)).wait();
    await (await htlc.withdrawAll(usdc.target, alice.address)).wait();
    assertEq(await usdc.balanceOf(bob.address), amount, "recipient paid after unfreeze");
    assertEq(await usdc.balanceOf(alice.address), amount, "initiator paid after unfreeze");
    assertEq(await htlc.outstandingCredit(usdc.target), 0n, "outstanding cleared");
    await track.check("after unfreeze");
  });

  await withTest("#47 token: false-return, reverting and return-bomb transfers all credit", async () => {
    for (const mockName of ["FalseTransferToken", "RevertingTransferToken", "ReturnBombToken"]) {
      const htlc = await deploy("HTLCv3", alice);
      const track = makeTracker(htlc);
      const token = await deploy(mockName, alice);
      const amount = 777n;
      await (await token.mint(alice.address, amount)).wait();
      await (await token.approve(htlc.target, amount)).wait();
      const { preimage, hashlock } = newSecret();
      await (
        await htlc.lockToken(hashlock, bob.address, token.target, amount, (await now()) + HOUR)
      ).wait();
      track.track(hashlock, token.target);
      const receipt = await (await htlc.connect(relayer).claim(hashlock, preimage)).wait();
      assertEq(receipt.status, 1, `${mockName}: claim transaction succeeded`);
      assertEq((await htlc.getSwap(hashlock)).status, Status.Claimed, `${mockName}: terminal`);
      assertEq((await htlc.getSwap(hashlock)).preimage, preimage, `${mockName}: preimage kept`);
      assertEq(await htlc.creditOf(token.target, bob.address), amount, `${mockName}: credited`);
      await track.check(mockName);
    }
  });

  await withTest("#47 token: a 64k-word return bomb cannot exhaust the credit reserve", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const track = makeTracker(htlc);
    const token = await deploy("ReturnBombToken", alice);
    const amount = 5n;
    await (await token.mint(alice.address, amount)).wait();
    await (await token.approve(htlc.target, amount)).wait();
    await (await token.setWords(65536n)).wait();
    const { preimage, hashlock } = newSecret();
    await (
      await htlc.lockToken(hashlock, bob.address, token.target, amount, (await now()) + HOUR)
    ).wait();
    track.track(hashlock, token.target);
    const receipt = await (await htlc.connect(relayer).claim(hashlock, preimage, { gasLimit: 3_000_000 })).wait();
    assertEq(receipt.status, 1, "claim transaction succeeded");
    assertEq((await htlc.getSwap(hashlock)).status, Status.Claimed, "claim is terminal");
    assertEq(await htlc.creditOf(token.target, bob.address), amount, "credited");
    await track.check("oversized return bomb");
  });

  await withTest("#47 native: a gas-guzzling and a reverting recipient both credit", async () => {
    for (const mode of [1, 2]) {
      const htlc = await deploy("HTLCv3", alice);
      const track = makeTracker(htlc);
      const guzzler = await deploy("GasGuzzlerRecipient", alice);
      await (await guzzler.setMode(mode)).wait();
      const { preimage, hashlock } = newSecret();
      const amount = ethers.parseEther("1");
      await (
        await htlc.lockNative(hashlock, guzzler.target, (await now()) + HOUR, { value: amount })
      ).wait();
      track.track(hashlock, ethers.ZeroAddress);
      const receipt = await (
        await htlc.connect(relayer).claim(hashlock, preimage, { gasLimit: 1_000_000 })
      ).wait();
      assertEq(receipt.status, 1, `mode ${mode}: claim transaction succeeded`);
      assertEq((await htlc.getSwap(hashlock)).status, Status.Claimed, `mode ${mode}: terminal`);
      assertEq(
        await htlc.creditOf(ethers.ZeroAddress, guzzler.target),
        amount,
        `mode ${mode}: credited`
      );
      // A guzzler cannot burn more than the delivery budget.
      assert(receipt.gasUsed < 600_000n, `mode ${mode}: delivery gas is bounded (${receipt.gasUsed})`);
      await track.check(`guzzler mode ${mode}`);

      // The recipient still collects, naming a destination that works.
      await (await guzzler.pull(htlc.target, ethers.ZeroAddress, dave.address, amount)).wait();
      assertEq(await htlc.creditOf(ethers.ZeroAddress, guzzler.target), 0n, "credit consumed");
      await track.check(`guzzler mode ${mode} withdrawn`);
    }
  });

  await withTest("#47 reentrancy: a recipient re-entering claim is blocked, delivery still lands", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const track = makeTracker(htlc);
    const attacker = await deploy("ReentrantRecipient", alice);
    const victim = newSecret();
    const target = newSecret();
    const timeout = (await now()) + 2 * HOUR;
    const amount = ethers.parseEther("1");
    // A second open swap the callback tries to claim during the first payout.
    await (await htlc.lockNative(target.hashlock, attacker.target, timeout, { value: amount })).wait();
    await (await htlc.lockNative(victim.hashlock, attacker.target, timeout, { value: amount })).wait();
    track.track(target.hashlock, ethers.ZeroAddress);
    track.track(victim.hashlock, ethers.ZeroAddress);
    await (
      await attacker.configure(
        htlc.target,
        1, // MODE_CLAIM
        true, // swallow the revert so the payout still completes
        target.hashlock,
        target.preimage,
        ethers.ZeroAddress
      )
    ).wait();

    const before = await provider.getBalance(attacker.target);
    const receipt = await (
      await htlc.connect(relayer).claim(victim.hashlock, victim.preimage, { gasLimit: 1_000_000 })
    ).wait();
    assertEq(receipt.status, 1, "claim transaction succeeded");
    assertEq((await provider.getBalance(attacker.target)) - before, amount, "payout delivered");
    assertEq(await attacker.reentries(), 1n, "the callback did run");
    assertEq(await attacker.lastReentryReverted(), true, "the reentrant claim was rejected");
    assertEq((await htlc.getSwap(target.hashlock)).status, Status.Open, "second swap untouched");
    assertEq(creditedEvents(htlc, receipt).length, 0, "delivery was direct");
    await track.check("reentrant claim blocked");
  });

  await withTest("#47 reentrancy: a callback that propagates its revert falls back to a credit", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const track = makeTracker(htlc);
    const attacker = await deploy("ReentrantRecipient", alice);
    const victim = newSecret();
    const other = newSecret();
    const timeout = (await now()) + 2 * HOUR;
    const amount = ethers.parseEther("1");
    await (await htlc.lockNative(other.hashlock, attacker.target, timeout, { value: amount })).wait();
    await (await htlc.lockNative(victim.hashlock, attacker.target, timeout, { value: amount })).wait();
    track.track(other.hashlock, ethers.ZeroAddress);
    track.track(victim.hashlock, ethers.ZeroAddress);
    await (
      await attacker.configure(htlc.target, 2, false, other.hashlock, other.preimage, ethers.ZeroAddress)
    ).wait(); // MODE_REFUND, propagate

    const receipt = await (
      await htlc.connect(relayer).claim(victim.hashlock, victim.preimage, { gasLimit: 1_000_000 })
    ).wait();
    assertEq(receipt.status, 1, "claim transaction succeeded");
    assertEq((await htlc.getSwap(victim.hashlock)).status, Status.Claimed, "claim is terminal");
    assertEq(await htlc.creditOf(ethers.ZeroAddress, attacker.target), amount, "credited");
    assertEq((await htlc.getSwap(other.hashlock)).status, Status.Open, "other swap untouched");
    await track.check("reentrant refund blocked");
  });

  await withTest("#47 reentrancy: a withdrawal cannot be re-entered", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const track = makeTracker(htlc);
    const attacker = await deploy("ReentrantRecipient", alice);
    const { preimage, hashlock } = newSecret();
    const amount = ethers.parseEther("1");
    // Build a credit first, with the callback disabled.
    await (
      await attacker.configure(htlc.target, 0, false, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroAddress)
    ).wait();
    await (
      await htlc.lockNative(hashlock, attacker.target, (await now()) + HOUR, { value: amount })
    ).wait();
    track.track(hashlock, ethers.ZeroAddress);
    // Force the credit path by starving the delivery attempt of budget.
    await (await attacker.configure(htlc.target, 3, false, hashlock, preimage, ethers.ZeroAddress)).wait();
    await (await htlc.connect(relayer).claim(hashlock, preimage, { gasLimit: 1_000_000 })).wait();
    assertEq(await htlc.creditOf(ethers.ZeroAddress, attacker.target), amount, "credited");
    await track.check("credit before reentrant withdraw");

    // MODE_WITHDRAW with propagation: the nested withdrawAll hits the guard,
    // the callback reverts, and the whole withdrawal unwinds with the credit
    // intact. Nothing is paid twice.
    await expectRevert(attacker.pull(ethers.ZeroAddress, attacker.target, amount), "TransferFailed");
    assertEq(await htlc.creditOf(ethers.ZeroAddress, attacker.target), amount, "credit intact");
    await track.check("after reentrant withdraw attempt");

    // With the callback silenced the same withdrawal succeeds exactly once.
    await (
      await attacker.configure(htlc.target, 0, false, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroAddress)
    ).wait();
    await (await attacker.pull(ethers.ZeroAddress, attacker.target, amount)).wait();
    assertEq(await htlc.creditOf(ethers.ZeroAddress, attacker.target), 0n, "credit consumed once");
    await track.check("after successful withdraw");
  });

  await withTest("#47 credits: only the credited account can move them", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const track = makeTracker(htlc);
    const sink = await deploy("FalseToken", alice); // nonpayable recipient
    const { preimage, hashlock } = newSecret();
    const amount = ethers.parseEther("2");
    await (
      await htlc.lockNative(hashlock, sink.target, (await now()) + HOUR, { value: amount })
    ).wait();
    track.track(hashlock, ethers.ZeroAddress);
    await (await htlc.connect(relayer).claim(hashlock, preimage)).wait();
    assertEq(await htlc.creditOf(ethers.ZeroAddress, sink.target), amount, "credited");

    // The claimer, the initiator and an unrelated account all have nothing:
    // a permissionless claim never buys redirect authority.
    for (const [who, label] of [
      [relayer, "claimer"],
      [alice, "initiator"],
      [carol, "bystander"],
    ]) {
      assertEq(await htlc.creditOf(ethers.ZeroAddress, who.address), 0n, `${label} has no credit`);
      await expectRevert(
        htlc.connect(who).withdraw(ethers.ZeroAddress, who.address, amount),
        "InsufficientCredit"
      );
      await expectRevert(htlc.connect(who).withdrawAll(ethers.ZeroAddress, who.address), "NoCredit");
    }
    assertEq(await htlc.creditOf(ethers.ZeroAddress, sink.target), amount, "credit still whole");
    await track.check("credit authority");
  });

  await withTest("#47 credits: partial withdrawals, withdrawAll, and destination validation", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const track = makeTracker(htlc);
    const token = await deploy("BlocklistToken", alice);
    const amount = 900n;
    await (await token.mint(alice.address, amount)).wait();
    await (await token.approve(htlc.target, amount)).wait();
    const { preimage, hashlock } = newSecret();
    await (
      await htlc.lockToken(hashlock, bob.address, token.target, amount, (await now()) + HOUR)
    ).wait();
    track.track(hashlock, token.target);
    await (await token.setBlocked(bob.address, true)).wait();
    await (await htlc.connect(relayer).claim(hashlock, preimage)).wait();
    assertEq(await htlc.creditOf(token.target, bob.address), amount, "credited");

    await expectRevert(
      htlc.connect(bob).withdraw(token.target, ethers.ZeroAddress, 1n),
      "InvalidParams"
    );
    await expectRevert(htlc.connect(bob).withdraw(token.target, htlc.target, 1n), "InvalidParams");
    await expectRevert(htlc.connect(bob).withdraw(token.target, carol.address, 0n), "NoCredit");
    await expectRevert(
      htlc.connect(bob).withdraw(token.target, carol.address, amount + 1n),
      "InsufficientCredit"
    );

    await (await htlc.connect(bob).withdraw(token.target, carol.address, 400n)).wait();
    assertEq(await token.balanceOf(carol.address), 400n, "partial paid");
    assertEq(await htlc.creditOf(token.target, bob.address), 500n, "remainder kept");
    assertEq(await htlc.outstandingCredit(token.target), 500n, "outstanding tracks the remainder");
    await track.check("after partial withdraw");

    await (await htlc.connect(bob).withdrawAll(token.target, dave.address)).wait();
    assertEq(await token.balanceOf(dave.address), 500n, "remainder paid elsewhere");
    assertEq(await htlc.creditOf(token.target, bob.address), 0n, "credit cleared");
    await expectRevert(htlc.connect(bob).withdrawAll(token.target, dave.address), "NoCredit");
    await track.check("after withdrawAll");
  });

  await withTest("#47 credits: a nonpayable recipient contract collects through a payable destination", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const track = makeTracker(htlc);
    const recipient = await deploy("NonPayableRecipient", alice);
    const { preimage, hashlock } = newSecret();
    const amount = ethers.parseEther("3");
    await (
      await htlc.lockNative(hashlock, recipient.target, (await now()) + HOUR, { value: amount })
    ).wait();
    track.track(hashlock, ethers.ZeroAddress);
    await (await htlc.connect(relayer).claim(hashlock, preimage)).wait();
    assertEq(await htlc.creditOf(ethers.ZeroAddress, recipient.target), amount, "credited");

    // It cannot receive the native coin, so it pays a destination that can.
    await expectRevert(
      recipient.pullAll(htlc.target, ethers.ZeroAddress, recipient.target),
      "TransferFailed"
    );
    const before = await provider.getBalance(dave.address);
    await (await recipient.pullAll(htlc.target, ethers.ZeroAddress, dave.address)).wait();
    assertEq((await provider.getBalance(dave.address)) - before, amount, "destination paid");
    assertEq(await htlc.creditOf(ethers.ZeroAddress, recipient.target), 0n, "credit cleared");
    await track.check("nonpayable recipient collected");
  });

  await withTest("#47 refund: a blocked initiator keeps the value as a credit", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const track = makeTracker(htlc);
    const usdc = await deploy("BlocklistToken", alice);
    const amount = 250n * 10n ** 6n;
    await (await usdc.mint(alice.address, amount * 2n)).wait();
    await (await usdc.approve(htlc.target, amount * 2n)).wait();
    const timedOut = newSecret();
    const released = newSecret();
    const timeout = (await now()) + HOUR;
    await (await htlc.lockToken(timedOut.hashlock, bob.address, usdc.target, amount, timeout)).wait();
    await (await htlc.lockTokenOpen(released.hashlock, usdc.target, amount, timeout)).wait();
    track.track(timedOut.hashlock, usdc.target);
    track.track(released.hashlock, usdc.target);

    await (await usdc.setBlocked(alice.address, true)).wait();
    await (await htlc.release(released.hashlock)).wait();
    assertEq((await htlc.getSwap(released.hashlock)).status, Status.Refunded, "release is terminal");
    await warpTo(timeout);
    await (await htlc.connect(relayer).refund(timedOut.hashlock)).wait();
    assertEq((await htlc.getSwap(timedOut.hashlock)).status, Status.Refunded, "refund is terminal");
    assertEq(await htlc.creditOf(usdc.target, alice.address), amount * 2n, "initiator credited twice");
    await track.check("blocked initiator credited");

    await (await usdc.setBlocked(alice.address, false)).wait();
    await (await htlc.withdrawAll(usdc.target, alice.address)).wait();
    assertEq(await usdc.balanceOf(alice.address), amount * 2n, "initiator made whole");
    await track.check("blocked initiator withdrew");
  });

  await withTest("#47 gas: the published policy matches the delivery budget in use", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const [gasLimit, gasReserve] = await htlc.deliveryGasPolicy();
    assertEq(gasLimit, DELIVERY_GAS_LIMIT, "published delivery budget");
    assertEq(gasReserve, DELIVERY_GAS_RESERVE, "published credit reserve");
  });

  await withTest("#47 gas: a settlement is never refused for gas, at any workable limit", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const track = makeTracker(htlc);
    const amount = ethers.parseEther("1");
    const timeout = (await now()) + 4 * HOUR;
    const claimAs = htlc.connect(relayer).claim;

    // The documented rule (estimate + budget + reserve) delivers directly.
    const direct = newSecret();
    await (await htlc.lockNative(direct.hashlock, bob.address, timeout, { value: amount })).wait();
    track.track(direct.hashlock, ethers.ZeroAddress);
    const bobBefore = await provider.getBalance(bob.address);
    const receipt = await settle(claimAs, direct.hashlock, direct.preimage);
    assertEq(creditedEvents(htlc, receipt).length, 0, "documented gas rule delivers directly");
    assertEq((await provider.getBalance(bob.address)) - bobBefore, amount, "recipient paid");
    await track.check("documented gas rule");

    // A bare estimate, and a range of tighter and wider limits, must all end
    // terminal with the value conserved, through every branch.
    const bare = await claimAs.estimateGas(direct.hashlock, direct.preimage).catch(() => 0n);
    assert(bare === 0n, "a settled swap cannot be claimed again");

    let credits = 0;
    let directDeliveries = 0;
    for (const extra of [0n, 25_000n, 70_000n, SETTLE_GAS_BUFFER, 400_000n]) {
      const secret = newSecret();
      await (await htlc.lockNative(secret.hashlock, bob.address, timeout, { value: amount })).wait();
      track.track(secret.hashlock, ethers.ZeroAddress);
      const estimate = await claimAs.estimateGas(secret.hashlock, secret.preimage);
      const limit = estimate + extra;
      const r = await (
        await claimAs(secret.hashlock, secret.preimage, { gasLimit: limit })
      ).wait();
      assertEq(r.status, 1, `gasLimit ${limit}: transaction succeeded`);
      const s = await htlc.getSwap(secret.hashlock);
      assertEq(s.status, Status.Claimed, `gasLimit ${limit}: claim is terminal`);
      assertEq(s.preimage, secret.preimage, `gasLimit ${limit}: preimage persisted`);
      if (creditedEvents(htlc, r).length === 1) credits += 1;
      else directDeliveries += 1;
      await track.check(`gasLimit ${limit}`);
    }
    console.log(`       gas sweep: ${directDeliveries} direct, ${credits} credited`);
    assert(directDeliveries > 0, "the widest limits deliver directly");
    assert(credits > 0, "a bare estimate defers to a credit, as documented");
    assertEq(
      await htlc.outstandingCredit(ethers.ZeroAddress),
      BigInt(credits) * amount,
      "credits match the deferred deliveries"
    );
  });

  await withTest("#47 gas: the credit reserve survives a recipient burning the whole budget", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const track = makeTracker(htlc);
    const guzzler = await deploy("GasGuzzlerRecipient", alice);
    await (await guzzler.setMode(1)).wait(); // burn until out of gas
    const amount = ethers.parseEther("1");
    const timeout = (await now()) + 4 * HOUR;

    // Exactly the documented gas rule: the child frame consumes the whole
    // delivery budget and the reserve still has to record the credit.
    const secret = newSecret();
    await (await htlc.lockNative(secret.hashlock, guzzler.target, timeout, { value: amount })).wait();
    track.track(secret.hashlock, ethers.ZeroAddress);
    const claimAs = htlc.connect(relayer).claim;
    const estimate = await claimAs.estimateGas(secret.hashlock, secret.preimage);
    const receipt = await (
      await claimAs(secret.hashlock, secret.preimage, { gasLimit: estimate + SETTLE_GAS_BUFFER })
    ).wait();
    assertEq(receipt.status, 1, "claim transaction succeeded");
    assertEq((await htlc.getSwap(secret.hashlock)).status, Status.Claimed, "claim is terminal");
    assertEq(await htlc.creditOf(ethers.ZeroAddress, guzzler.target), amount, "credited");
    // The whole budget was burned, and no more than the budget.
    assert(
      receipt.gasUsed > estimate + DELIVERY_GAS_LIMIT - 20_000n,
      `the recipient burned its budget (${receipt.gasUsed} vs ${estimate})`
    );
    assert(
      receipt.gasUsed < estimate + SETTLE_GAS_BUFFER,
      `the burn stayed inside the budget (${receipt.gasUsed})`
    );
    await track.check("budget fully burned");

    // There must be no gas limit at which a burning recipient turns a
    // completed transaction into a swap that stayed Open. Either the
    // transaction runs out of gas outright and changes nothing, or it ends
    // terminal with the amount conserved.
    let terminal = 0;
    for (let extra = 0n; extra <= SETTLE_GAS_BUFFER + 100_000n; extra += 17_000n) {
      const probe = newSecret();
      await (await htlc.lockNative(probe.hashlock, guzzler.target, timeout, { value: amount })).wait();
      track.track(probe.hashlock, ethers.ZeroAddress);
      const limit = (await claimAs.estimateGas(probe.hashlock, probe.preimage)) + extra;
      let status = 0;
      try {
        status = (await (await claimAs(probe.hashlock, probe.preimage, { gasLimit: limit })).wait())
          .status;
      } catch {
        status = 0;
      }
      const s = await htlc.getSwap(probe.hashlock);
      if (status === 1) {
        assertEq(s.status, Status.Claimed, `gasLimit ${limit}: completed means terminal`);
        terminal += 1;
      } else {
        assertEq(s.status, Status.Open, `gasLimit ${limit}: a failed transaction changes nothing`);
      }
      await track.check(`guzzler sweep ${limit}`);
    }
    assert(terminal > 0, "the guzzler sweep settled at least once");
  });

  await withTest("#47 trampoline: selfDeliver is not reachable from outside", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const token = await deploy("MockERC20", alice);
    await (await token.mint(htlc.target, 1000n)).wait();
    await expectRevert(
      htlc.connect(carol).selfDeliver(token.target, carol.address, 1000n),
      "Unauthorized"
    );
    await expectRevert(htlc.selfDeliver(ethers.ZeroAddress, alice.address, 0n), "Unauthorized");
    assertEq(await token.balanceOf(htlc.target), 1000n, "nothing left the contract");
  });

  await withTest("#47 invariants: a mixed multi-swap sequence conserves value throughout", async () => {
    const htlc = await deploy("HTLCv3", alice);
    const track = makeTracker(htlc);
    const good = await deploy("MockERC20", alice);
    const usdc = await deploy("BlocklistToken", alice);
    const sink = await deploy("FalseToken", alice);
    const timeout = (await now()) + 4 * HOUR;

    await (await good.mint(alice.address, 10_000n)).wait();
    await (await good.approve(htlc.target, 10_000n)).wait();
    await (await usdc.mint(alice.address, 10_000n)).wait();
    await (await usdc.approve(htlc.target, 10_000n)).wait();

    const plan = [];
    // Five swaps in three assets, two of which will fail delivery.
    plan.push({ ...newSecret(), token: ethers.ZeroAddress, amount: ethers.parseEther("1"), to: bob.address });
    plan.push({ ...newSecret(), token: ethers.ZeroAddress, amount: ethers.parseEther("2"), to: sink.target });
    plan.push({ ...newSecret(), token: good.target, amount: 4_000n, to: bob.address });
    plan.push({ ...newSecret(), token: usdc.target, amount: 3_000n, to: carol.address });
    plan.push({ ...newSecret(), token: usdc.target, amount: 2_000n, to: dave.address });

    for (const p of plan) {
      if (p.token === ethers.ZeroAddress) {
        await (await htlc.lockNative(p.hashlock, p.to, timeout, { value: p.amount })).wait();
      } else {
        await (await htlc.lockToken(p.hashlock, p.to, p.token, p.amount, timeout)).wait();
      }
      track.track(p.hashlock, p.token);
      await track.check(`locked ${p.hashlock.slice(0, 10)}`);
    }

    // Block one USDC recipient so its claim has to defer.
    await (await usdc.setBlocked(dave.address, true)).wait();
    for (const p of plan) {
      await (await htlc.connect(relayer).claim(p.hashlock, p.preimage, { gasLimit: 1_000_000 })).wait();
      await track.check(`claimed ${p.hashlock.slice(0, 10)}`);
    }

    assertEq(await htlc.outstandingCredit(ethers.ZeroAddress), ethers.parseEther("2"), "native credit");
    assertEq(await htlc.outstandingCredit(usdc.target), 2_000n, "usdc credit");
    assertEq(await htlc.outstandingCredit(good.target), 0n, "no good-token credit");
    assertEq(await good.balanceOf(bob.address), 4_000n, "good token delivered");
    assertEq(await usdc.balanceOf(carol.address), 3_000n, "unblocked usdc delivered");

    await (await usdc.setBlocked(dave.address, false)).wait();
    await (await htlc.connect(dave).withdrawAll(usdc.target, dave.address)).wait();
    assertEq(await usdc.balanceOf(dave.address), 2_000n, "deferred usdc collected");
    await track.check("after deferred usdc withdraw");

    // Every swap ended terminal, and every token account is now settled.
    for (const p of plan) {
      assertEq((await htlc.getSwap(p.hashlock)).status, Status.Claimed, "terminal Claimed");
    }
    assertEq(await htlc.outstandingCredit(usdc.target), 0n, "usdc fully settled");
    assertEq(await htlc.outstandingCredit(ethers.ZeroAddress), ethers.parseEther("2"), "native credit stays");
    assertEq(await provider.getBalance(htlc.target), ethers.parseEther("2"), "only the credit is held");
    await track.check("end of sequence");
  });

  stopAnvil();
  console.log(`\n[htlcv3] ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
