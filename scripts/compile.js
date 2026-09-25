// Compile one reviewed Hyperion source bundle into target-specific artifacts.
// EVM and QRL use distinct compiler lines because current QRVM-512 bytecode is
// not valid EVM-256 bytecode. Test contracts are compiled on demand.

const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { compileDirs } = require("./hypc");
const { sha256Bytecode, sha256Json, targetArtifactsDir } = require("./artifacts");

const repoRoot = path.join(__dirname, "..");
const sourceDir = path.join(repoRoot, "contracts", "hyperion");

function writeTarget(target) {
  const artifacts = compileDirs([sourceDir], target);
  const artifactsDir = targetArtifactsDir(target);
  fs.mkdirSync(artifactsDir, { recursive: true });

  const firstArtifact = Object.values(artifacts)[0];
  if (!firstArtifact) throw new Error(`${target} compilation produced no deployable contracts`);
  const manifest = {
    schemaVersion: firstArtifact.schemaVersion,
    target: firstArtifact.target,
    runtime: firstArtifact.runtime,
    addressBytes: firstArtifact.addressBytes,
    sourceBundleSha256: firstArtifact.sourceBundleSha256,
    compiler: firstArtifact.compiler,
    compilerSettings: firstArtifact.compilerSettings,
    contracts: {},
  };

  for (const [name, artifact] of Object.entries(artifacts).sort(([a], [b]) => a.localeCompare(b))) {
    const artifactFile = `${name}.json`;
    manifest.contracts[name] = {
      artifact: artifactFile,
      abiSha256: sha256Json(artifact.abi),
      bytecodeSha256: sha256Bytecode(artifact.bytecode),
      deployedBytecodeSha256: sha256Bytecode(artifact.deployedBytecode),
    };
    const outPath = path.join(artifactsDir, artifactFile);
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
    console.log(
      `[compile:${target}] ${name} -> ${path.relative(repoRoot, outPath)} ` +
        `(${(artifact.bytecode.length - 2) / 2} bytes)`
    );
  }

  fs.writeFileSync(path.join(artifactsDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { artifacts, manifest };
}

function assertTargetParity(evm, qrl) {
  assert.equal(
    evm.manifest.sourceBundleSha256,
    qrl.manifest.sourceBundleSha256,
    "EVM and QRL artifacts were not compiled from the same source bundle"
  );
  assert.deepEqual(
    Object.keys(evm.manifest.contracts).sort(),
    Object.keys(qrl.manifest.contracts).sort(),
    "EVM and QRL manifests contain different contracts"
  );
  for (const name of Object.keys(evm.manifest.contracts)) {
    assert.equal(
      evm.manifest.contracts[name].abiSha256,
      qrl.manifest.contracts[name].abiSha256,
      `${name} ABI differs between EVM and QRL targets`
    );
  }
  console.log("[compile] target parity passed: identical source bundle and ABI across EVM and QRL");
}

function main() {
  const requestedTarget = process.argv[2];
  if (requestedTarget && requestedTarget !== "evm" && requestedTarget !== "qrl") {
    throw new Error("usage: node scripts/compile.js [evm|qrl]");
  }
  const targets = requestedTarget ? [requestedTarget] : ["evm", "qrl"];
  const results = Object.fromEntries(targets.map((target) => [target, writeTarget(target)]));
  if (results.evm && results.qrl) assertTargetParity(results.evm, results.qrl);
}

if (require.main === module) main();

module.exports = { assertTargetParity, main, writeTarget };
