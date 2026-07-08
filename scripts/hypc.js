// Shared hypc (native Hyperion compiler) invocation. The npm @theqrl/hypc
// package is frozen at 0.0.2; the native hypc CLI (0.2.x) is the same
// compiler the zondscan verifier runs, so bytecode produced here
// byte-matches source verification. Override via HYPC_BIN.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const HYPC_BIN = process.env.HYPC_BIN || "hypc";

// Compile every .hyp file in the given directories.
// Returns { [contractName]: { abi, bytecode } }, skipping interfaces.
function compileDirs(dirs) {
  const sources = {};
  for (const dir of dirs) {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".hyp")) continue;
      sources[file] = { content: fs.readFileSync(path.join(dir, file), "utf8") };
    }
  }
  if (Object.keys(sources).length === 0) throw new Error(`no .hyp sources in ${dirs.join(", ")}`);

  const input = {
    language: "Hyperion",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // hypc 0.2.x uses the qrvm namespace; request zvm too for older binaries.
      outputSelection: { "*": { "*": ["abi", "qrvm.bytecode.object", "zvm.bytecode.object"] } },
    },
  };

  const r = spawnSync(HYPC_BIN, ["--standard-json"], {
    input: JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new Error(`spawn hypc failed: ${r.error.message} (set HYPC_BIN if not on PATH)`);
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
  for (const byName of Object.values(out.contracts)) {
    for (const [name, artifact] of Object.entries(byName)) {
      const bytecode = artifact?.qrvm?.bytecode?.object || artifact?.zvm?.bytecode?.object;
      if (!bytecode) continue; // interface or abstract contract
      artifacts[name] = { abi: artifact.abi, bytecode: `0x${bytecode}` };
    }
  }
  return artifacts;
}

module.exports = { compileDirs };
