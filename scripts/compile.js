// Compile contracts/hyperion/*.hyp into build/hyperion/<Contract>.json
// ({ abi, bytecode }). Test contracts under contracts/test/ are compiled
// on the fly by scripts/test-local.js and are not written here.

const fs = require("fs");
const path = require("path");
const { compileDirs } = require("./hypc");

const repoRoot = path.join(__dirname, "..");
const artifactsDir = path.join(repoRoot, "build", "hyperion");

const artifacts = compileDirs([path.join(repoRoot, "contracts", "hyperion")]);

fs.mkdirSync(artifactsDir, { recursive: true });
for (const [name, artifact] of Object.entries(artifacts)) {
  const outPath = path.join(artifactsDir, `${name}.json`);
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log(
    `[compile] ${name} -> ${path.relative(repoRoot, outPath)} (${(artifact.bytecode.length - 2) / 2} bytes)`
  );
}
