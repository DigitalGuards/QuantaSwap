// Target-bound hypc (native Hyperion compiler) invocation. The EVM and QRL
// targets deliberately use different compiler lines and code formats.

const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { spawnSync } = require("child_process");

const repoRoot = path.join(__dirname, "..");
const targetsConfig = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "config", "hyperion-targets.json"), "utf8")
);

function getTargetConfig(target) {
  const config = Object.hasOwn(targetsConfig.targets, target)
    ? targetsConfig.targets[target]
    : undefined;
  if (!config) {
    throw new Error(`unknown Hyperion artifact target ${target}; expected evm or qrl`);
  }
  return config;
}

function compilerBinary(config) {
  const configured = process.env[config.compilerEnv] || config.defaultCompiler;
  if (path.isAbsolute(configured) || configured.includes(path.sep)) {
    return path.resolve(repoRoot, configured);
  }
  return configured;
}

function collectSources(dirs) {
  const sources = {};
  for (const dir of dirs) {
    for (const file of fs.readdirSync(dir).sort()) {
      if (!file.endsWith(".hyp")) continue;
      if (sources[file]) throw new Error(`duplicate Hyperion source name ${file}`);
      sources[file] = { content: fs.readFileSync(path.join(dir, file), "utf8") };
    }
  }
  if (Object.keys(sources).length === 0) throw new Error(`no .hyp sources in ${dirs.join(", ")}`);
  return sources;
}

function hashSourceBundle(sources) {
  const hash = createHash("sha256");
  for (const sourceName of Object.keys(sources).sort()) {
    hash.update(sourceName);
    hash.update("\0");
    hash.update(sources[sourceName].content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

// Compile every .hyp file in the given directories.
// Returns target-bound artifacts and skips interfaces.
function compileDirs(dirs, target) {
  const targetConfig = getTargetConfig(target);
  const sources = collectSources(dirs);
  const sourceBundleSha256 = hashSourceBundle(sources);

  const input = {
    language: "Hyperion",
    sources,
    settings: {
      qrvmVersion: targetConfig.qrvmVersion,
      viaIR: targetConfig.viaIR,
      optimizer: targetConfig.optimizer,
      // hypc 0.2.x uses the qrvm namespace; request zvm too for older binaries.
      outputSelection: {
        "*": { "*": ["abi", "metadata", "qrvm.bytecode.object", "zvm.bytecode.object", "qrvm.deployedBytecode.object", "zvm.deployedBytecode.object"] },
      },
    },
  };

  const binary = compilerBinary(targetConfig);
  const r = spawnSync(binary, ["--standard-json"], {
    input: JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) {
    throw new Error(
      `spawn ${target} hypc failed: ${r.error.message} (set ${targetConfig.compilerEnv})`
    );
  }
  if (r.status !== 0) throw new Error(`hypc exited ${r.status}: ${r.stderr || r.stdout}`);

  const out = JSON.parse(r.stdout);
  if (out.errors) {
    const fatal = out.errors.filter((e) => e.severity === "error");
    for (const e of out.errors) {
      (e.severity === "error" ? console.error : console.warn)(e.formattedMessage || e.message);
    }
    if (fatal.length > 0) throw new Error("compilation failed");
  }

  const artifacts = {};
  for (const byName of Object.values(out.contracts || {})) {
    for (const [name, artifact] of Object.entries(byName)) {
      const bytecode = artifact?.qrvm?.bytecode?.object || artifact?.zvm?.bytecode?.object;
      if (!bytecode) continue; // interface or abstract contract
      const metadata =
        typeof artifact.metadata === "string" ? JSON.parse(artifact.metadata) : artifact.metadata;
      if (metadata?.compiler?.version !== targetConfig.compilerVersion) {
        throw new Error(
          `${target} compiler mismatch for ${name}; expected ${targetConfig.compilerVersion}, ` +
            `got ${metadata?.compiler?.version || "missing"}`
        );
      }
      if ((metadata?.settings?.viaIR === true) !== targetConfig.viaIR) {
        throw new Error(`${target} artifact ${name} records the wrong viaIR setting`);
      }
      if (
        metadata?.settings?.optimizer?.enabled !== targetConfig.optimizer.enabled ||
        metadata?.settings?.optimizer?.runs !== targetConfig.optimizer.runs
      ) {
        throw new Error(`${target} artifact ${name} records the wrong optimizer settings`);
      }
      if (metadata?.settings?.qrvmVersion !== targetConfig.qrvmVersion) {
        throw new Error(`${target} artifact ${name} records the wrong QRVM version`);
      }
      if (Object.hasOwn(artifacts, name)) {
        throw new Error(`duplicate compiled contract name ${name}`);
      }
      artifacts[name] = {
        schemaVersion: targetsConfig.schemaVersion,
        target,
        runtime: targetConfig.runtime,
        addressBytes: targetConfig.addressBytes,
        sourceBundleSha256,
        abi: artifact.abi,
        bytecode: `0x${bytecode}`,
        deployedBytecode: `0x${artifact?.qrvm?.deployedBytecode?.object || artifact?.zvm?.deployedBytecode?.object || ""}`,
        compiler: { version: metadata.compiler.version },
        compilerSettings: {
          qrvmVersion: targetConfig.qrvmVersion,
          viaIR: targetConfig.viaIR,
          optimizer: { ...targetConfig.optimizer },
        },
        metadata,
      };
    }
  }
  return artifacts;
}

module.exports = {
  collectSources,
  compileDirs,
  getTargetConfig,
  hashSourceBundle,
  targetsConfig,
};
