import { readFileSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

// Pin the supported shell commands. A discovery or build change must update
// this contract and its tests before it can receive a registration exemption.
const testCommands = {
  server:
    "npm run build && node --test dist/*.test.js && node smoke.js && node federation-smoke.js",
  marketmaker: "npm run build && node --test dist/*.test.js",
};

const helperLoaders = {
  "src/protocol-v2-test-helper.ts": "src/protocol-signing.test.ts",
  "src/taker-test-harness.ts": "src/taker-e2e.test.ts",
  "src/taker-survival-child.ts": "src/taker-survival.test.ts",
};

export function nodeTestScope(root) {
  const packageName = path.basename(root);
  const testCommand = testCommands[packageName];
  if (!testCommand)
    throw new Error(`Unsupported node:test package: ${packageName}`);
  const packagePath = path.join(root, "package.json");
  const { scripts } = JSON.parse(readFileSync(packagePath, "utf8"));
  if (scripts?.test !== testCommand || scripts?.build !== "tsc") {
    throw new Error(
      `${packageName}: node:test scope requires build="tsc" and test=${JSON.stringify(testCommand)}; review the scope contract when changing test discovery`,
    );
  }

  // Use the package's installed compiler to honor JSONC, extends, include and
  // exclude. Only inputs that this build emits into the shell glob qualify.
  const ts = createRequire(packagePath)("typescript");
  const configPath = path.join(root, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error)
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
    );
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length) {
    throw new Error(
      parsed.errors
        .map((error) =>
          ts.flattenDiagnosticMessageText(error.messageText, "\n"),
        )
        .join("\n"),
    );
  }
  const { rootDir, outDir, noEmit, emitDeclarationOnly, outFile } =
    parsed.options;
  if (
    rootDir !== path.join(root, "src") ||
    outDir !== path.join(root, "dist") ||
    noEmit ||
    emitDeclarationOnly ||
    outFile
  ) {
    throw new Error(
      `${packageName}: node:test scope requires JavaScript emission from src to dist`,
    );
  }
  const compiled = new Set(
    parsed.fileNames.map((file) =>
      path.relative(root, file).split(path.sep).join("/"),
    ),
  );
  // Shell * omits leading dots and never descends into a subdirectory.
  const tests = [...compiled]
    .filter((file) => /^src\/[^/.][^/]*\.test\.ts$/u.test(file))
    .sort();
  if (!tests.length)
    throw new Error(
      `${packageName}: node:test scope found no compiled top-level tests`,
    );

  const helpers =
    packageName === "marketmaker" ? Object.keys(helperLoaders) : [];
  for (const helper of helpers) {
    const loader = helperLoaders[helper];
    const specifier = `./${path.basename(helper, ".ts")}.js`;
    const source = ts.createSourceFile(
      loader,
      readFileSync(path.join(root, loader), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    let loaded = false;
    function visit(node) {
      if (
        ts.isImportDeclaration(node) &&
        node.moduleSpecifier.text === specifier &&
        !node.importClause?.isTypeOnly &&
        (!node.importClause ||
          node.importClause.name ||
          (node.importClause.namedBindings &&
            (ts.isNamespaceImport(node.importClause.namedBindings) ||
              node.importClause.namedBindings.elements.some(
                (element) => !element.isTypeOnly,
              ))))
      )
        loaded = true;
      // The survival suite launches this helper in a child process.
      if (
        helper === "src/taker-survival-child.ts" &&
        ts.isNewExpression(node) &&
        node.expression.getText(source) === "URL" &&
        node.arguments?.length === 2 &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === specifier &&
        node.arguments[1].getText(source) === "import.meta.url"
      )
        loaded = true;
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (!compiled.has(helper) || !tests.includes(loader) || !loaded) {
      throw new Error(
        `${packageName}: node:test helper ${helper} must be compiled and loaded by executed test ${loader}`,
      );
    }
  }
  return { tests, helpers, files: [...tests, ...helpers], testCommand };
}

export async function assertNodeTestsRun(root) {
  const scope = nodeTestScope(root);
  const executed = new Set(scope.tests);
  const unrun = [];
  // Walk the filesystem, including Git-ignored files and generated-looking
  // paths. Installed dependencies and Git internals are the only exclusions.
  async function walk(directory = "", ancestors = new Set()) {
    const resolved = await realpath(path.join(root, directory));
    if (ancestors.has(resolved))
      throw new Error(`node:test inventory directory cycle: ${directory}`);
    const parents = new Set([...ancestors, resolved]);
    for (const item of await readdir(path.join(root, directory), {
      withFileTypes: true,
    })) {
      if (item.name === "node_modules" || item.name === ".git") continue;
      const file = path.posix.join(directory, item.name);
      const directoryEntry = item.isSymbolicLink()
        ? await stat(path.join(root, file))
        : item;
      if (directoryEntry.isDirectory()) await walk(file, parents);
      else if (file.endsWith(".test.ts") && !executed.has(file))
        unrun.push(file);
    }
  }
  await walk();
  if (unrun.length) {
    throw new Error(
      `${path.basename(root)}: test files not executed by npm test (${scope.testCommand}):\n${unrun
        .sort()
        .map((file) => JSON.stringify(file))
        .join("\n")}`,
    );
  }
  return scope;
}
