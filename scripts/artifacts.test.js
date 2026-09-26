const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  loadArtifact,
  loadManifest,
  validateArtifactEnvelope,
  validateManifest,
} = require("./artifacts");
const { addressSurface, assertAddressSurface } = require("./abi-guards");

const repoRoot = path.join(__dirname, "..");

function clone(value) {
  return structuredClone(value);
}

function readGenerated(target, file) {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, "build", "hyperion", target, file), "utf8")
  );
}

test("EVM and QRL artifacts share source and ABI while keeping target-specific bytecode", () => {
  const evmManifest = loadManifest("evm");
  const qrlManifest = loadManifest("qrl");

  assert.equal(evmManifest.runtime, "evm-256");
  assert.equal(evmManifest.addressBytes, 20);
  assert.equal(qrlManifest.runtime, "qrvm-512");
  assert.equal(qrlManifest.addressBytes, 64);
  assert.equal(evmManifest.sourceBundleSha256, qrlManifest.sourceBundleSha256);

  // Both settlement contracts ship from one reviewed bundle: HTLC is the
  // deployed HTLCv2, HTLCv3 is the payout-credit redesign (issue #47).
  for (const name of ["HTLC", "HTLCv3"]) {
    const evmArtifact = loadArtifact("evm", name);
    const qrlArtifact = loadArtifact("qrl", name);
    assert.equal(
      evmManifest.contracts[name].abiSha256,
      qrlManifest.contracts[name].abiSha256,
      `${name} ABI differs across targets`
    );
    assert.notEqual(
      evmManifest.contracts[name].bytecodeSha256,
      qrlManifest.contracts[name].bytecodeSha256,
      `${name} bytecode is not target-specific`
    );
    assert.deepEqual(evmArtifact.abi, qrlArtifact.abi);
    assert.notEqual(evmArtifact.bytecode, qrlArtifact.bytecode);
  }

  // HTLCv3 keeps HTLCv2's getSwap tuple shape so existing decoders read v3
  // records unchanged, and exposes the credit ledger through explicit views.
  const shapeOf = (abi) => {
    const entry = abi.find((e) => e.type === "function" && e.name === "getSwap");
    return entry.outputs[0].components.map((c) => `${c.name}:${c.type}`).join(",");
  };
  assert.equal(shapeOf(loadArtifact("evm", "HTLCv3").abi), shapeOf(loadArtifact("evm", "HTLC").abi));
  const v3 = loadArtifact("evm", "HTLCv3").abi;
  for (const name of ["creditOf", "outstandingCredit", "withdraw", "withdrawAll", "deliveryGasPolicy"]) {
    assert.ok(
      v3.some((e) => e.type === "function" && e.name === name),
      `HTLCv3 ABI is missing ${name}`
    );
  }
  assert.equal(
    loadArtifact("evm", "HTLC").abi.some((e) => e.type === "function" && e.name === "withdraw"),
    false,
    "HTLCv2 must stay unchanged"
  );
});

test("manifest validation rejects target, compiler, codegen, source, and path mismatches", () => {
  const manifest = readGenerated("evm", "manifest.json");

  const wrongTarget = clone(manifest);
  wrongTarget.target = "qrl";
  assert.throws(() => validateManifest(wrongTarget, "evm"), /target mismatch/);

  const wrongCompiler = clone(manifest);
  wrongCompiler.compiler.version = "unexpected-compiler";
  assert.throws(() => validateManifest(wrongCompiler, "evm"), /compiler mismatch/);

  const wrongCodegen = clone(manifest);
  wrongCodegen.compilerSettings.viaIR = false;
  assert.throws(() => validateManifest(wrongCodegen, "evm"), /codegen mismatch/);

  const wrongSource = clone(manifest);
  wrongSource.sourceBundleSha256 = "0".repeat(64);
  assert.throws(() => validateManifest(wrongSource, "evm"), /current Hyperion source bundle/);

  const unsafePath = clone(manifest);
  unsafePath.contracts.HTLC.artifact = "../qrl/HTLC.json";
  assert.throws(() => validateManifest(unsafePath, "evm"), /unsafe artifact path/);
});

test("artifact validation rejects swapped targets and envelope or metadata changes", () => {
  const evmManifest = loadManifest("evm");
  const evmArtifact = readGenerated("evm", "HTLC.json");
  const qrlArtifact = readGenerated("qrl", "HTLC.json");

  assert.throws(
    () => validateArtifactEnvelope(qrlArtifact, evmManifest, "evm", "HTLC"),
    /target mismatch/
  );

  const wrongCompiler = clone(evmArtifact);
  wrongCompiler.compiler.version = "unexpected-compiler";
  assert.throws(
    () => validateArtifactEnvelope(wrongCompiler, evmManifest, "evm", "HTLC"),
    /compiler mismatch/
  );

  const wrongCodegen = clone(evmArtifact);
  wrongCodegen.compilerSettings.viaIR = false;
  assert.throws(
    () => validateArtifactEnvelope(wrongCodegen, evmManifest, "evm", "HTLC"),
    /codegen mismatch/
  );

  const wrongMetadata = clone(evmArtifact);
  wrongMetadata.metadata.settings.optimizer.runs += 1;
  assert.throws(
    () => validateArtifactEnvelope(wrongMetadata, evmManifest, "evm", "HTLC"),
    /codegen metadata mismatch/
  );

  const wrongBytecode = clone(evmArtifact);
  const replacementByte = wrongBytecode.bytecode.endsWith("00") ? "01" : "00";
  wrongBytecode.bytecode = `${wrongBytecode.bytecode.slice(0, -2)}${replacementByte}`;
  assert.throws(
    () => validateArtifactEnvelope(wrongBytecode, evmManifest, "evm", "HTLC"),
    /bytecode hash mismatch/
  );

  const wrongRuntime = clone(evmArtifact);
  const runtimeByte = wrongRuntime.deployedBytecode.endsWith("00") ? "01" : "00";
  wrongRuntime.deployedBytecode = `${wrongRuntime.deployedBytecode.slice(0, -2)}${runtimeByte}`;
  assert.throws(
    () => validateArtifactEnvelope(wrongRuntime, evmManifest, "evm", "HTLC"),
    /runtime bytecode hash mismatch/
  );
});

test("the address surface of both settlement contracts is pinned on both targets", () => {
  // A compiler-generated getter over a wide key truncates it on QRVM-512, so the
  // external surface that mentions an address is pinned exactly. The guard has
  // to reject an addition, or it guards nothing.
  for (const target of ["evm", "qrl"]) {
    for (const name of ["HTLC", "HTLCv3"]) {
      assertAddressSurface(name, loadArtifact(target, name).abi);
    }
  }

  const abi = loadArtifact("evm", "HTLCv3").abi;
  const withExtra = [
    ...abi,
    {
      type: "function",
      name: "credits",
      stateMutability: "view",
      inputs: [{ name: "", type: "address" }, { name: "", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    },
  ];
  assert.throws(() => assertAddressSurface("HTLCv3", withExtra), /address surface changed/);
  assert.throws(() => assertAddressSurface("NotAContract", abi), /no pinned address surface/);

  // A struct member counts: getSwap returns addresses inside a tuple.
  assert.ok(addressSurface(abi).includes("getSwap(bytes32)"));

  // HTLCv2 gained nothing from the v3 work.
  assert.deepEqual(addressSurface(loadArtifact("evm", "HTLC").abi), [
    "assign(bytes32,address)",
    "getSwap(bytes32)",
    "lockNative(bytes32,address,uint256)",
    "lockToken(bytes32,address,address,uint256,uint256)",
    "lockTokenOpen(bytes32,address,uint256,uint256)",
  ]);
});
