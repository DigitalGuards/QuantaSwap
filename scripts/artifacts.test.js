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
  const evmArtifact = loadArtifact("evm", "HTLC");
  const qrlArtifact = loadArtifact("qrl", "HTLC");

  assert.equal(evmManifest.runtime, "evm-256");
  assert.equal(evmManifest.addressBytes, 20);
  assert.equal(qrlManifest.runtime, "qrvm-512");
  assert.equal(qrlManifest.addressBytes, 64);
  assert.equal(evmManifest.sourceBundleSha256, qrlManifest.sourceBundleSha256);
  assert.equal(
    evmManifest.contracts.HTLC.abiSha256,
    qrlManifest.contracts.HTLC.abiSha256
  );
  assert.notEqual(
    evmManifest.contracts.HTLC.bytecodeSha256,
    qrlManifest.contracts.HTLC.bytecodeSha256
  );
  assert.deepEqual(evmArtifact.abi, qrlArtifact.abi);
  assert.notEqual(evmArtifact.bytecode, qrlArtifact.bytecode);
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
