const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const {
  collectSources,
  getTargetConfig,
  hashSourceBundle,
  targetsConfig,
} = require("./hypc");

const repoRoot = path.join(__dirname, "..");
const artifactsRoot = path.join(repoRoot, "build", "hyperion");
const sourceDir = path.join(repoRoot, "contracts", "hyperion");

function expectedSourceBundleSha256() {
  return hashSourceBundle(collectSources([sourceDir]));
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sha256Bytecode(bytecode) {
  if (!/^0x[0-9a-fA-F]+$/.test(bytecode) || bytecode.length % 2 !== 0) {
    throw new Error("artifact bytecode is not canonical hexadecimal");
  }
  return createHash("sha256").update(Buffer.from(bytecode.slice(2), "hex")).digest("hex");
}

function targetArtifactsDir(target) {
  getTargetConfig(target);
  return path.join(artifactsRoot, target);
}

function validateManifest(manifest, target) {
  const config = getTargetConfig(target);
  if (manifest.schemaVersion !== targetsConfig.schemaVersion) {
    throw new Error(`${target} manifest schema mismatch`);
  }
  if (manifest.target !== target) throw new Error(`${target} manifest target mismatch`);
  if (manifest.runtime !== config.runtime || manifest.addressBytes !== config.addressBytes) {
    throw new Error(`${target} manifest runtime mismatch`);
  }
  if (manifest.compiler?.version !== config.compilerVersion) {
    throw new Error(`${target} manifest compiler mismatch`);
  }
  if (
    manifest.compilerSettings?.qrvmVersion !== config.qrvmVersion ||
    manifest.compilerSettings?.viaIR !== config.viaIR ||
    manifest.compilerSettings?.optimizer?.enabled !== config.optimizer.enabled ||
    manifest.compilerSettings?.optimizer?.runs !== config.optimizer.runs
  ) {
    throw new Error(`${target} manifest codegen mismatch`);
  }
  if (!/^[0-9a-f]{64}$/.test(manifest.sourceBundleSha256 || "")) {
    throw new Error(`${target} manifest source hash is invalid`);
  }
  if (manifest.sourceBundleSha256 !== expectedSourceBundleSha256()) {
    throw new Error(`${target} manifest does not match the current Hyperion source bundle`);
  }
  if (
    !manifest.contracts ||
    typeof manifest.contracts !== "object" ||
    Array.isArray(manifest.contracts)
  ) {
    throw new Error(`${target} manifest contract index is missing`);
  }
  if (Object.keys(manifest.contracts).length === 0) {
    throw new Error(`${target} manifest contract index is empty`);
  }
  for (const [contractName, entry] of Object.entries(manifest.contracts)) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(contractName)) {
      throw new Error(`${target} manifest contains an invalid contract name`);
    }
    if (entry?.artifact !== `${contractName}.json`) {
      throw new Error(`${target} manifest contains an unsafe artifact path for ${contractName}`);
    }
    if (!/^[0-9a-f]{64}$/.test(entry.abiSha256 || "")) {
      throw new Error(`${target} manifest contains an invalid ABI hash for ${contractName}`);
    }
    if (!/^[0-9a-f]{64}$/.test(entry.bytecodeSha256 || "")) {
      throw new Error(`${target} manifest contains an invalid bytecode hash for ${contractName}`);
    }
    if (!/^[0-9a-f]{64}$/.test(entry.deployedBytecodeSha256 || "")) {
      throw new Error(`${target} manifest contains an invalid runtime hash for ${contractName}`);
    }
  }
  return manifest;
}

function validateArtifactEnvelope(artifact, manifest, target, contractName) {
  const config = getTargetConfig(target);
  const entry = Object.hasOwn(manifest.contracts, contractName)
    ? manifest.contracts[contractName]
    : undefined;
  if (!entry) throw new Error(`${target} manifest does not include ${contractName}`);
  if (artifact.schemaVersion !== targetsConfig.schemaVersion) {
    throw new Error(`${contractName} artifact schema mismatch`);
  }
  if (artifact.target !== target) throw new Error(`${contractName} artifact target mismatch`);
  if (artifact.runtime !== config.runtime || artifact.addressBytes !== config.addressBytes) {
    throw new Error(`${contractName} artifact runtime mismatch`);
  }
  if (artifact.sourceBundleSha256 !== manifest.sourceBundleSha256) {
    throw new Error(`${contractName} artifact source hash mismatch`);
  }
  if (artifact.compiler?.version !== manifest.compiler.version) {
    throw new Error(`${contractName} artifact compiler mismatch`);
  }
  if (
    artifact.compilerSettings?.qrvmVersion !== manifest.compilerSettings.qrvmVersion ||
    artifact.compilerSettings?.viaIR !== manifest.compilerSettings.viaIR ||
    artifact.compilerSettings?.optimizer?.enabled !==
      manifest.compilerSettings.optimizer.enabled ||
    artifact.compilerSettings?.optimizer?.runs !== manifest.compilerSettings.optimizer.runs
  ) {
    throw new Error(`${contractName} artifact codegen mismatch`);
  }
  if (artifact.metadata?.compiler?.version !== manifest.compiler.version) {
    throw new Error(`${contractName} compiler metadata mismatch`);
  }
  if ((artifact.metadata?.settings?.viaIR === true) !== manifest.compilerSettings.viaIR) {
    throw new Error(`${contractName} viaIR metadata mismatch`);
  }
  if (
    artifact.metadata?.settings?.qrvmVersion !== manifest.compilerSettings.qrvmVersion ||
    artifact.metadata?.settings?.optimizer?.enabled !==
      manifest.compilerSettings.optimizer.enabled ||
    artifact.metadata?.settings?.optimizer?.runs !== manifest.compilerSettings.optimizer.runs
  ) {
    throw new Error(`${contractName} codegen metadata mismatch`);
  }
  if (sha256Json(artifact.abi) !== entry.abiSha256) {
    throw new Error(`${contractName} ABI hash mismatch`);
  }
  if (sha256Bytecode(artifact.bytecode) !== entry.bytecodeSha256) {
    throw new Error(`${contractName} bytecode hash mismatch`);
  }
  if (sha256Bytecode(artifact.deployedBytecode) !== entry.deployedBytecodeSha256) {
    throw new Error(`${contractName} runtime bytecode hash mismatch`);
  }
  return artifact;
}

function loadManifest(target) {
  const manifestPath = path.join(targetArtifactsDir(target), "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return validateManifest(manifest, target);
}

function loadArtifact(target, contractName) {
  const manifest = loadManifest(target);
  const entry = Object.hasOwn(manifest.contracts, contractName)
    ? manifest.contracts[contractName]
    : undefined;
  if (!entry) throw new Error(`${target} manifest does not include ${contractName}`);
  const artifactPath = path.join(targetArtifactsDir(target), entry.artifact);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  return validateArtifactEnvelope(artifact, manifest, target, contractName);
}

module.exports = {
  expectedSourceBundleSha256,
  loadArtifact,
  loadManifest,
  sha256Bytecode,
  sha256Json,
  targetArtifactsDir,
  validateArtifactEnvelope,
  validateManifest,
};
