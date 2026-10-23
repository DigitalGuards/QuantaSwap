#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { assertNodeTestsRun } from "./lint-ratchet-node-tests.mjs";
import {
  assertBootstrapSources,
  assertExactFindings,
  assertNoGrowth,
  assertNoTrackedNodeModules,
  collectFindings,
  collectPairs,
  legacyManifest,
  readRatchet,
} from "./lint-ratchet-lib.mjs";

// Set this before loading ESLint or typescript-eslint. Repeated parses in CI
// must retain type information, including when a caller sets this to true.
process.env.TSESTREE_SINGLE_RUN = "false";

const repository = fileURLToPath(new URL("../", import.meta.url));
const git = (args) =>
  execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

export async function lintPackage(root) {
  const configName =
    path.basename(root) === "frontend"
      ? "eslint.config.js"
      : "eslint.config.mjs";
  const configPath = path.join(root, configName);
  const require = createRequire(configPath);
  const { ESLint } = require("eslint");
  const { strictConfig } = await import(pathToFileURL(configPath).href);
  const eslint = new ESLint({
    cwd: root,
    applySuppressions: false,
    allowInlineConfig: false,
    overrideConfigFile: true,
    overrideConfig: strictConfig,
  });
  return eslint.lintFiles(["."]);
}

async function main() {
  const { values } = parseArgs({
    options: {
      check: { type: "boolean" },
      "base-ref": { type: "string" },
      "integration-ref": { type: "string" },
      package: { type: "string", default: path.basename(process.cwd()) },
    },
  });
  const packageName = values.package;
  if (!["frontend", "server", "marketmaker"].includes(packageName)) {
    throw new Error(
      "Run from a package or pass --package frontend|server|marketmaker",
    );
  }
  const root = path.join(repository, packageName);
  const baseRef = values["base-ref"];
  const integrationRef =
    values["integration-ref"] ??
    (baseRef === undefined ? undefined : "origin/dev");
  for (const name of ["base-ref", "integration-ref"]) {
    if (values[name] !== undefined && !values[name].trim()) {
      throw new Error(`--${name} must be a Git ref`);
    }
  }
  if (integrationRef !== undefined && baseRef === undefined) {
    throw new Error("--integration-ref requires --base-ref");
  }
  // ESLint recursively ignores node_modules, even below authored directories.
  // Check the whole Git index before either checking or updating any manifest.
  assertNoTrackedNodeModules(
    git(["ls-files", "--cached", "-z"]).split("\0").filter(Boolean),
  );
  if (packageName !== "frontend") {
    const scope = await assertNodeTestsRun(root);
    console.log(
      `lint-ratchet: node:test coverage verified (${scope.tests.length} test files, ${scope.helpers.length} helpers; no unrun tests)`,
    );
  }
  const manifestPath = path.join(root, "eslint-ratchet.json");
  const expected = readRatchet(manifestPath);
  const previous = collectPairs(expected);
  let bootstrap = false;
  if (baseRef !== undefined) {
    function reference(ref) {
      const commit = git([
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${ref}^{commit}`,
      ]).trim();
      const file = `${packageName}/eslint-ratchet.json`;
      const exists = git(["ls-tree", "--name-only", commit, "--", file]).trim();
      let pairs;
      if (exists) {
        // JSON is data: never execute a reference's config or scripts.
        const baseline = JSON.parse(git(["show", `${commit}:${file}`]));
        if (baseline?.version === 1) pairs = collectPairs(baseline);
        else legacyManifest(baseline);
      }
      return { ref, commit, pairs };
    }
    const base = reference(baseRef);
    const selected =
      base.pairs || integrationRef === undefined
        ? base
        : reference(integrationRef);
    if (selected.pairs) {
      assertNoGrowth(previous, selected.pairs, selected.ref);
      console.log(
        `lint-ratchet: allowances did not grow against ${selected.ref} (${selected.commit})`,
      );
    } else {
      bootstrap = true;
      const verified = await assertBootstrapSources(
        repository,
        base.commit,
        git,
      );
      console.log(
        `lint-ratchet: bootstrap source equality verified ${verified} files against ${baseRef} (${base.commit})`,
      );
    }
  }

  // The API scan explicitly ignores every bulk suppression file, including a
  // custom ESLINT_SUPPRESSIONS_LOCATION. Inline directives fail the policy rule.
  const results = await lintPackage(root);

  const actual = collectFindings(results, root);
  const current = collectPairs(actual);
  if (bootstrap) assertExactFindings(current, previous);
  assertNoGrowth(current, previous, "eslint-ratchet.json");
  const canonical = `${JSON.stringify(actual, null, 2)}\n`;
  if (values.check) {
    if ((await readFile(manifestPath, "utf8")) !== canonical) {
      throw new Error(
        "Ratchet shrank or is not canonical; run npm run lint:ratchet:update",
      );
    }
  } else {
    // Both comparisons run before writing. Regeneration can only reduce counts
    // or remove resolved pairs, even if new findings coexist with old fixes.
    await writeFile(manifestPath, canonical);
  }
  const reports = actual.entries.reduce(
    (total, entry) => total + entry.count,
    0,
  );
  const files = new Set(actual.entries.map((entry) => entry.file)).size;
  console.log(
    `lint-ratchet: OK (${current.size} pairs, ${files} files, ${reports} findings; zero growth)`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    console.error(`lint-ratchet: ${error.message}`);
    process.exitCode = 1;
  }
}
