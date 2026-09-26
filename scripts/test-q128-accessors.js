const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.join(__dirname, "..");
const workspaceRoot = path.join(repoRoot, "..");
const hyperionRoot = process.env.HYPERION_SOURCE_ROOT || path.join(workspaceRoot, "hyperion");
const qrvmoneRoot = path.join(workspaceRoot, "qrvmone");
const semanticSourceRoot = path.join(repoRoot, "contracts", "test", "semantic");
const contractRoot = path.join(repoRoot, "contracts", "hyperion");
const contractTestRoot = path.join(repoRoot, "contracts", "test");
const contractTestnetRoot = path.join(repoRoot, "contracts", "testnet");
const hyptestBinary =
  process.env.HYPERION_HYPTEST || path.join(hyperionRoot, "build", "test", "hyptest");
const qrvmoneLibrary =
  process.env.QRVMONE_LIBRARY ||
  path.join(qrvmoneRoot, "build", "lib", "libqrvmone.so.0.11.0");

const WIDE_KEY_PUBLIC_GETTER = /mapping\s*\(\s*address\b[^;]*\)\s+public\b/;

function requireSafeSources() {
  for (const sourcePath of [
    path.join(contractTestRoot, "MockTokens.hyp"),
    path.join(contractTestnetRoot, "TestStable.hyp"),
  ]) {
    const source = fs.readFileSync(sourcePath, "utf8");
    assert.doesNotMatch(
      source,
      WIDE_KEY_PUBLIC_GETTER,
      `${path.basename(sourcePath)} exposes a compiler-generated address mapping getter`
    );
    assert.match(source, /function\s+balanceOf\s*\(\s*address\b/);
    assert.match(source, /function\s+allowance\s*\(\s*address\b[^)]*address\b/);
  }

  // Legacy QRVM-512 codegen truncates wide keys in compiler-generated
  // mapping getters, so every contract keyed by an account address has to
  // expose explicit view functions instead.
  for (const sourcePath of [
    path.join(contractRoot, "HTLC.hyp"),
    path.join(contractRoot, "HTLCv3.hyp"),
    path.join(contractTestRoot, "MockRecipients.hyp"),
  ]) {
    const source = fs.readFileSync(sourcePath, "utf8");
    assert.doesNotMatch(
      source,
      WIDE_KEY_PUBLIC_GETTER,
      `${path.basename(sourcePath)} exposes a compiler-generated address mapping getter`
    );
  }
  const htlcv3 = fs.readFileSync(path.join(contractRoot, "HTLCv3.hyp"), "utf8");
  assert.match(htlcv3, /function\s+creditOf\s*\(\s*address\b[^)]*address\b/);
  assert.match(htlcv3, /function\s+outstandingCredit\s*\(\s*address\b/);
}

function createTestTree() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quantaswap-hyptest-"));
  fs.symlinkSync(path.join(hyperionRoot, "test", "libyul"), path.join(temporaryRoot, "libyul"));

  const semanticRoot = path.join(temporaryRoot, "libhyperion", "semanticTests", "quantaswap");
  const externalRoot = path.join(semanticRoot, "_canonical");
  fs.mkdirSync(externalRoot, { recursive: true });

  for (const suiteDirectory of [
    "ABIJson",
    "ASTJSON",
    "astPropertyTests",
    "gasTests",
    "memoryGuardTests",
    "natspecJSON",
    "smtCheckerTests",
    "syntaxTests",
  ]) {
    fs.symlinkSync(
      path.join(hyperionRoot, "test", "libhyperion", suiteDirectory),
      path.join(temporaryRoot, "libhyperion", suiteDirectory)
    );
  }

  fs.copyFileSync(
    path.join(semanticSourceRoot, "Q128TokenAccessors.hyp"),
    path.join(semanticRoot, "Q128TokenAccessors.hyp")
  );
  fs.copyFileSync(
    path.join(contractTestRoot, "MockTokens.hyp"),
    path.join(externalRoot, "MockTokens.hyp")
  );
  fs.copyFileSync(
    path.join(contractTestnetRoot, "TestStable.hyp"),
    path.join(externalRoot, "TestStable.hyp")
  );
  fs.copyFileSync(
    path.join(contractRoot, "HTLC.hyp"),
    path.join(externalRoot, "HTLC.hyp")
  );
  fs.copyFileSync(
    path.join(contractRoot, "HTLCv3.hyp"),
    path.join(externalRoot, "HTLCv3.hyp")
  );
  fs.copyFileSync(
    path.join(semanticSourceRoot, "Q128HTLC.hyp"),
    path.join(semanticRoot, "Q128HTLC.hyp")
  );
  fs.copyFileSync(
    path.join(semanticSourceRoot, "Q128HTLCv3.hyp"),
    path.join(semanticRoot, "Q128HTLCv3.hyp")
  );

  return temporaryRoot;
}

function runSemanticMode(testRoot, testName, optimize) {
  const label = optimize
    ? "optimized legacy and via-IR codegen"
    : "default legacy and via-IR codegen";
  console.log(`[q128] running ${testName} with ${label}`);

  const customArguments = ["--vm", qrvmoneLibrary, "--testpath", testRoot, "--no-smt"];
  if (optimize) customArguments.push("--optimize");

  const result = spawnSync(
    hyptestBinary,
    [
      `--run_test=semanticTests/quantaswap/${testName}`,
      "--no_color_output",
      "--log_level=message",
      "--report_level=short",
      "--",
      ...customArguments,
    ],
    {
      cwd: hyperionRoot,
      env: process.env,
      stdio: "inherit",
    }
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Q128 ${testName} regression failed with ${label}`);
}

function main() {
  assert.ok(fs.existsSync(hyptestBinary), `Hyperion semantic runner is missing: ${hyptestBinary}`);
  assert.ok(fs.existsSync(qrvmoneLibrary), `qrvmone library is missing: ${qrvmoneLibrary}`);
  requireSafeSources();

  const temporaryRoot = createTestTree();
  try {
    for (const testName of ["Q128TokenAccessors", "Q128HTLC", "Q128HTLCv3"]) {
      runSemanticMode(temporaryRoot, testName, false);
      runSemanticMode(temporaryRoot, testName, true);
    }
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }

  console.log(
    "[q128] explicit token accessors, HTLC fields and HTLCv3 credit ledger passed " +
      "full-address alias regressions"
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { createTestTree, requireSafeSources, runSemanticMode };
