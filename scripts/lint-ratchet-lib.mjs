import { readFileSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { generatedDirectories } from "./eslint-policy.mjs";

const protectedRules = new Set([
  "lint-policy/no-inline-config",
  "node-test/direct-calls",
  "no-warning-comments",
  "@typescript-eslint/ban-ts-comment",
]);

export function isTypeScript(file) {
  return /\.(?:ts|tsx|mts|cts)$/u.test(file);
}

export function isSourceFile(file, repositoryRelative = false) {
  const parts = file.split("/");
  if (
    repositoryRelative &&
    ["frontend", "server", "marketmaker"].includes(parts[0])
  )
    parts.shift();
  return !generatedDirectories.includes(parts[0]);
}

export function collectPairs(manifest) {
  if (
    manifest?.version !== 1 ||
    Object.keys(manifest).sort().join() !== "entries,version" ||
    !Array.isArray(manifest.entries)
  ) {
    throw new Error("Expected a version 1 ratchet with an entries array");
  }
  const pairs = new Map();
  for (const entry of manifest.entries) {
    if (
      !entry ||
      Object.keys(entry).sort().join() !== "count,file,rule" ||
      typeof entry.file !== "string" ||
      !isTypeScript(entry.file) ||
      !isSourceFile(entry.file) ||
      path.posix.isAbsolute(entry.file) ||
      path.posix.normalize(entry.file) !== entry.file ||
      entry.file.startsWith("../") ||
      /[*?{}[\]!\\:]/u.test(entry.file) ||
      typeof entry.rule !== "string" ||
      !/^(?:@[\w-]+\/)?[\w-]+(?:\/[\w-]+)?$/u.test(entry.rule) ||
      protectedRules.has(entry.rule) ||
      !Number.isSafeInteger(entry.count) ||
      entry.count < 1
    ) {
      throw new Error(`Invalid ratchet entry: ${JSON.stringify(entry)}`);
    }
    const key = `${entry.file}: ${entry.rule}`;
    if (pairs.has(key)) throw new Error(`Duplicate ratchet pair: ${key}`);
    pairs.set(key, entry.count);
  }
  return pairs;
}

export function readRatchet(file) {
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  collectPairs(manifest);
  return manifest;
}

export function editorOverrides(manifest) {
  collectPairs(manifest);
  return manifest.entries.map(({ file, rule }) => ({
    files: [file],
    rules: { [rule]: "off" },
  }));
}

export function assertNoGrowth(current, baseline, label) {
  const grown = [...current].filter(
    ([pair, count]) => count > (baseline.get(pair) ?? 0),
  );
  if (grown.length) {
    throw new Error(
      `Ratchet growth against ${label}:\n${grown
        .map(
          ([pair, count]) => `${pair}: ${baseline.get(pair) ?? 0} -> ${count}`,
        )
        .join("\n")}`,
    );
  }
}

export function assertExactFindings(current, manifest) {
  const differences = [...new Set([...current.keys(), ...manifest.keys()])]
    .filter((pair) => current.get(pair) !== manifest.get(pair))
    .map(
      (pair) =>
        `${pair}: manifest ${manifest.get(pair) ?? 0}, current ${current.get(pair) ?? 0}`,
    );
  if (differences.length) {
    throw new Error(
      `Bootstrap manifest must equal current findings exactly:\n${differences.join("\n")}`,
    );
  }
}

const bootstrapTooling = new Set([
  "scripts/eslint-policy.mjs",
  "scripts/eslint-node-test.mjs",
  "scripts/lint-ratchet.mjs",
  "scripts/lint-ratchet-lib.mjs",
  "scripts/lint-ratchet.test.mjs",
  "scripts/lint-ratchet.integration.test.mjs",
  "frontend/scripts/check-lint-ratchet.mjs",
  "server/lint.mjs",
  "marketmaker/lint.mjs",
]);

export function isBootstrapSetupFile(file) {
  return (
    bootstrapTooling.has(file) ||
    /^(?:frontend|server|marketmaker)\/(?:eslint\.config\.(?:js|mjs)|eslint-ratchet\.json|tsconfig(?:\.eslint)?\.json)$/u.test(
      file,
    ) ||
    /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(file) ||
    (file.endsWith(".md") && !file.startsWith("config/"))
  );
}

export function onlyPackageScriptsChanged(base, current) {
  const { scripts: baseScripts, ...baseFields } = JSON.parse(base);
  const { scripts: currentScripts, ...currentFields } = JSON.parse(current);
  const validScripts = (scripts) =>
    scripts === undefined ||
    (scripts !== null &&
      typeof scripts === "object" &&
      !Array.isArray(scripts) &&
      Object.values(scripts).every((script) => typeof script === "string"));
  return (
    validScripts(baseScripts) &&
    validScripts(currentScripts) &&
    isDeepStrictEqual(baseFields, currentFields)
  );
}

export async function assertBootstrapSources(repository, commit, git) {
  // Freeze the whole repository so local packages, sibling imports and shared
  // inputs are covered without maintaining an incomplete dependency graph.
  const base = new Map(
    git(["ls-tree", "-r", "-z", commit])
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        const [mode, type, oid] = line.slice(0, tab).split(" ");
        return [line.slice(tab + 1), { mode, type, oid }];
      }),
  );
  const current = git([
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ])
    .split("\0")
    .filter((file) => file && isSourceFile(file, true));
  // ESLint does not honor .gitignore. Include authored JS/TS even when Git
  // ignores it, so an ignored declaration or source cannot alter the scan.
  async function includeAuthoredFiles(directory = "") {
    for (const item of await readdir(path.join(repository, directory), {
      withFileTypes: true,
    })) {
      const file = path.posix.join(directory, item.name);
      if (file === ".git" || !isSourceFile(file, true)) continue;
      if (item.isDirectory()) await includeAuthoredFiles(file);
      else if (/\.(?:[cm]?[jt]s|[jt]sx)$/u.test(file)) current.push(file);
    }
  }
  await includeAuthoredFiles();
  const algorithm = git(["rev-parse", "--show-object-format"]).trim();
  let verified = 0;
  for (const file of new Set([...base.keys(), ...current])) {
    if (isBootstrapSetupFile(file)) continue;
    const fail = () => {
      throw new Error(
        `Bootstrap setup PR must not change sources: ${file}. Only lint configuration, ratchet tooling, lint tsconfigs, package.json scripts, CI and docs may differ.`,
      );
    };
    const entry = base.get(file);
    if (!entry || entry.type !== "blob" || entry.mode === "120000") fail();
    let bytes;
    try {
      const target = path.join(repository, file);
      if (!(await lstat(target)).isFile()) fail();
      bytes = await readFile(target);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") fail();
      throw error;
    }
    // Hash raw bytes as a Git blob, bypassing clean filters and line-ending
    // normalization. The index may be dirty and is never the byte authority.
    const oid = createHash(algorithm)
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (
      oid !== entry.oid &&
      !(
        path.posix.basename(file) === "package.json" &&
        onlyPackageScriptsChanged(git(["show", `${commit}:${file}`]), bytes)
      )
    )
      fail();
    verified += 1;
  }
  return verified;
}

export function collectFindings(results, root) {
  const entries = new Map();
  for (const result of results) {
    const file = path.relative(root, result.filePath).split(path.sep).join("/");
    for (const message of result.messages) {
      if (
        message.fatal ||
        !message.ruleId ||
        protectedRules.has(message.ruleId) ||
        !isTypeScript(file)
      ) {
        throw new Error(
          `${file}:${message.line}:${message.column}: ${message.ruleId ?? "lint error"}: ${message.message}`,
        );
      }
      const key = `${file}: ${message.ruleId}`;
      const entry = entries.get(key) ?? {
        file,
        rule: message.ruleId,
        count: 0,
      };
      entry.count += 1;
      entries.set(key, entry);
    }
  }
  return {
    version: 1,
    entries: [...entries.values()].sort(
      (a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule),
    ),
  };
}

export function legacyManifest(value) {
  if (Array.isArray(value)) {
    collectPairs({ version: 1, entries: value });
  } else if (value && typeof value === "object" && !("version" in value)) {
    const entries = Object.entries(value).flatMap(([file, rules]) => {
      if (!rules || typeof rules !== "object" || Array.isArray(rules)) {
        throw new Error("Invalid legacy ratchet rules");
      }
      return Object.entries(rules).map(([rule, count]) => ({
        file,
        rule,
        count,
      }));
    });
    collectPairs({ version: 1, entries });
  } else {
    throw new Error("Unrecognized legacy ratchet");
  }
}
