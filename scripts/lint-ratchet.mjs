#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  assertBootstrapSources,
  assertExactFindings,
  assertNoGrowth,
  collectFindings,
  collectPairs,
  isSourceFile,
  isTypeScript,
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
  if (baseRef !== undefined && !baseRef.trim()) {
    throw new Error("--base-ref must be a Git ref");
  }
  const manifestPath = path.join(root, "eslint-ratchet.json");
  const expected = readRatchet(manifestPath);
  const previous = collectPairs(expected);
  let migrationCommit;
  let bootstrap = false;
  if (baseRef !== undefined) {
    const commit = git([
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${baseRef}^{commit}`,
    ]).trim();
    const file = `${packageName}/eslint-ratchet.json`;
    const exists = git(["ls-tree", "--name-only", commit, "--", file]).trim();
    if (!exists) {
      bootstrap = true;
      const verified = await assertBootstrapSources(repository, commit, git);
      console.log(
        `lint-ratchet: bootstrap source equality verified ${verified} files against ${baseRef} (${commit})`,
      );
    } else {
      // JSON is data: never execute a base revision's config or scripts.
      const baseline = JSON.parse(git(["show", `${commit}:${file}`]));
      if (baseline?.version === 1) {
        assertNoGrowth(previous, collectPairs(baseline), baseRef);
        console.log(
          `lint-ratchet: allowances did not grow against ${baseRef} (${commit})`,
        );
      } else {
        legacyManifest(baseline);
        migrationCommit = commit;
      }
    }
  }

  // The API scan explicitly ignores every bulk suppression file, including a
  // custom ESLINT_SUPPRESSIONS_LOCATION. Inline directives fail the policy rule.
  const results = await lintPackage(root);

  if (migrationCommit) {
    // The initial setup enables rules that the legacy config did not run.
    // Permit that one migration only while all typed sources match the base.
    // Invalid base manifests fail above. Missing ones use bootstrap equality.
    const prefix = `${packageName}/`;
    const baseFiles = git([
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      migrationCommit,
      "--",
      packageName,
    ])
      .split("\0")
      .filter((file) => file.startsWith(prefix))
      .map((file) => file.slice(prefix.length))
      .filter((file) => isTypeScript(file) && isSourceFile(file))
      .sort();
    const currentFiles = results
      .map((result) =>
        path.relative(root, result.filePath).split(path.sep).join("/"),
      )
      .filter(isTypeScript)
      .sort();
    if (JSON.stringify(baseFiles) !== JSON.stringify(currentFiles)) {
      throw new Error(
        "Initial ratchet migration requires the base's exact TypeScript file set",
      );
    }
    for (const file of currentFiles) {
      if (
        (await readFile(path.join(root, file), "utf8")) !==
        git(["show", `${migrationCommit}:${prefix}${file}`])
      ) {
        throw new Error(
          `Initial ratchet migration requires unchanged TypeScript: ${file}`,
        );
      }
    }
    console.log(
      `lint-ratchet: legacy migration verified ${currentFiles.length} unchanged TypeScript files against ${baseRef}`,
    );
  }

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
