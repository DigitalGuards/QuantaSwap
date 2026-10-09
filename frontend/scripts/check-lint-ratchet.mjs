import { ESLint } from "eslint";
import { readFile, writeFile } from "node:fs/promises";
import { relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strictConfig } from "../eslint.config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = resolve(root, "eslint-ratchet.json");
const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: strictConfig });
const results = await eslint.lintFiles(["."]);
const current = new Map();
for (const result of results) {
  const file = relative(root, result.filePath).split("\\").join("/");
  for (const message of result.messages) {
    if (!message.ruleId || message.fatal) {
      throw new Error(`Cannot ratchet a parser or configuration error in ${file}`);
    }
    // Production exceptions retain existing defensive checks on typed values.
    if (
      !/\.test\.tsx?$/.test(file) &&
      message.ruleId !== "@typescript-eslint/no-unnecessary-condition"
    ) {
      throw new Error(`Unratchetable production error: ${file}: ${message.ruleId}`);
    }
    const key = `${file}:${message.ruleId}`;
    const entry = current.get(key) ?? { file, rule: message.ruleId, count: 0 };
    entry.count += 1;
    current.set(key, entry);
  }
}
const entries = [...current.values()].sort(
  (a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule),
);
if (process.argv.includes("--update")) {
  await writeFile(manifest, `${JSON.stringify(entries, null, 2)}\n`);
  console.log(`Generated ${entries.length} exact rule/file exceptions.`);
} else {
  const expected = JSON.parse(await readFile(manifest, "utf8"));
  if (JSON.stringify(entries) !== JSON.stringify(expected)) {
    throw new Error(
      "ESLint debt changed. Fix new violations and regenerate removed entries with npm run lint:ratchet.",
    );
  }
  console.log(`Verified ${entries.length} rule/file exceptions with unchanged counts.`);
}
