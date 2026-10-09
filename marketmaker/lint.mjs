import { ESLint } from "eslint";
import { writeFileSync } from "node:fs";
import { relative } from "node:path";
import { strictConfig, ratchet } from "./eslint.config.mjs";

const protectedRules = new Set([
  "@typescript-eslint/consistent-type-assertions",
  "@typescript-eslint/no-explicit-any",
  "@typescript-eslint/no-non-null-assertion",
  "@typescript-eslint/ban-ts-comment",
  "no-restricted-syntax",
]);
const prune = process.argv.includes("--prune");
if (process.argv.slice(2).some((arg) => arg !== "--prune")) {
  throw new Error("Usage: node lint.mjs [--prune]");
}
for (const [file, rules] of Object.entries(ratchet)) {
  if (!/^src\/(?:[\w-]+\/)*[\w.-]+\.(?:ts|tsx|mts|cts)$/.test(file)) {
    throw new Error("Ratchet paths must name individual source files");
  }
  for (const [rule, count] of Object.entries(rules)) {
    if (protectedRules.has(rule) || !Number.isSafeInteger(count) || count < 1) {
      throw new Error(`Invalid ratchet entry: ${file} ${rule}`);
    }
  }
}

// Count the strict diagnostics before applying the editor's file overrides.
// Existing pairs have a ceiling; every new file or rule starts at zero.
const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: strictConfig,
});
const results = await eslint.lintFiles(["src"]);
const actual = {};
const failures = [];
for (const result of results) {
  const file = relative(import.meta.dirname, result.filePath).replaceAll(
    "\\",
    "/",
  );
  for (const message of result.messages) {
    if (message.ruleId === null || message.severity !== 2) {
      failures.push(`${file}:${message.line} ${message.message}`);
      continue;
    }
    const rules = (actual[file] ??= {});
    rules[message.ruleId] = (rules[message.ruleId] ?? 0) + 1;
  }
  const counts = actual[file] ?? {};
  for (const [rule, count] of Object.entries(counts)) {
    const allowed = ratchet[file]?.[rule] ?? 0;
    if (count > allowed) {
      failures.push(
        `${file}: ${rule} has ${count} errors (ceiling ${allowed})`,
      );
      for (const message of result.messages.filter(
        (item) => item.ruleId === rule,
      )) {
        failures.push(`  ${message.line}:${message.column} ${message.message}`);
      }
    }
  }
}
for (const [file, rules] of Object.entries(ratchet)) {
  for (const [rule, count] of Object.entries(rules)) {
    if ((actual[file]?.[rule] ?? 0) < count && !prune) {
      failures.push(`${file}: ${rule} shrank; run npm run lint:prune`);
    }
  }
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  if (prune) {
    const sorted = Object.fromEntries(
      Object.entries(actual)
        .sort()
        .map(([file, rules]) => [
          file,
          Object.fromEntries(Object.entries(rules).sort()),
        ]),
    );
    writeFileSync(
      new URL("./eslint-ratchet.json", import.meta.url),
      `${JSON.stringify(sorted, null, 2)}\n`,
    );
  }
  const entries = Object.values(actual).reduce(
    (total, rules) => total + Object.keys(rules).length,
    0,
  );
  const errors = Object.values(actual).reduce(
    (total, rules) =>
      total + Object.values(rules).reduce((sum, count) => sum + count, 0),
    0,
  );
  console.log(
    `Lint passed: ${entries} existing file/rule pairs (${errors} diagnostics); zero growth.`,
  );
}
