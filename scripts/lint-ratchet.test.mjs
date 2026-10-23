import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hardenedRules, suppressionGuard } from "./eslint-policy.mjs";
import {
  assertNodeTestsRun,
  nodeTestScope,
} from "./lint-ratchet-node-tests.mjs";
import {
  assertExactFindings,
  assertNoGrowth,
  assertNoTrackedNodeModules,
  collectFindings,
  collectPairs,
  isBootstrapSetupFile,
  isSourceFile,
  legacyManifest,
  onlyPackageScriptsChanged,
} from "./lint-ratchet-lib.mjs";

process.env.TSESTREE_SINGLE_RUN = "false";
const root = process.cwd();
const require = createRequire(path.join(root, "package.json"));
const { ESLint } = require("eslint");
const configName =
  path.basename(root) === "frontend" ? "eslint.config.js" : "eslint.config.mjs";
const { strictConfig } = await import(
  pathToFileURL(path.join(root, configName)).href
);
const entry = { file: "src/example.ts", rule: "no-console", count: 2 };
const manifest = (entries) => ({ version: 1, entries });

test("tracked node_modules path segments are forbidden at every depth", () => {
  assert.doesNotThrow(() =>
    assertNoTrackedNodeModules([
      "src/node_modules.ts",
      "src/my_node_modules/probe.ts",
      "src/node_modules_backup/probe.ts",
      "docs/node_modules-guide.md",
    ]),
  );
  const forbidden = [
    "node_modules/dependency/index.js",
    "frontend/node_modules/dependency/package.json",
    "server/src/node_modules/probe.ts",
    "marketmaker/test/fixtures/node_modules/data.json",
    "packages/shared/node_modules/types.d.ts",
    "docs/node_modules/README.md",
    "src/space and\nnewline/node_modules/probe.ts",
  ];
  for (const file of forbidden) {
    assert.throws(
      () => assertNoTrackedNodeModules(["src/allowed.ts", file]),
      (error) =>
        /node_modules directory segment/u.test(error.message) &&
        error.message.includes(JSON.stringify(file)),
      file,
    );
  }
  assert.throws(
    () => assertNoTrackedNodeModules(forbidden),
    (error) =>
      forbidden.every((file) => error.message.includes(JSON.stringify(file))),
  );
});

test("a pair cannot move to another file or rule, or increase its count", () => {
  const base = collectPairs(manifest([entry]));
  for (const changed of [
    { ...entry, count: 3 },
    { ...entry, file: "test/example.ts" },
    { ...entry, rule: "@typescript-eslint/no-explicit-any" },
  ]) {
    assert.throws(
      () => assertNoGrowth(collectPairs(manifest([changed])), base, "base"),
      /Ratchet growth/u,
    );
  }
  assert.doesNotThrow(() =>
    assertNoGrowth(
      collectPairs(manifest([{ ...entry, count: 1 }])),
      base,
      "base",
    ),
  );
  assert.doesNotThrow(() => assertNoGrowth(new Map(), base, "base"));
});

test("bootstrap requires identical pairs and counts in both directions", () => {
  const current = collectPairs(manifest([entry]));
  assert.doesNotThrow(() => assertExactFindings(current, new Map(current)));
  for (const entries of [
    [],
    [{ ...entry, count: 1 }],
    [{ ...entry, count: 3 }],
    [entry, { ...entry, file: "test/example.ts" }],
    [{ ...entry, rule: "@typescript-eslint/no-explicit-any" }],
  ]) {
    assert.throws(
      () => assertExactFindings(current, collectPairs(manifest(entries))),
      /Bootstrap manifest must equal current findings exactly/u,
    );
  }
});

test("bootstrap exceptions are confined to setup files", () => {
  for (const file of [
    "scripts/eslint-policy.mjs",
    "scripts/lint-ratchet.mjs",
    "scripts/lint-ratchet-lib.mjs",
    "scripts/lint-ratchet-node-tests.mjs",
    "scripts/lint-ratchet.test.mjs",
    "scripts/lint-ratchet.integration.test.mjs",
    "scripts/eslint-node-test.mjs",
    "frontend/scripts/check-lint-ratchet.mjs",
    "server/lint.mjs",
    "marketmaker/lint.mjs",
    "frontend/eslint.config.js",
    "server/eslint.config.mjs",
    "marketmaker/eslint-ratchet.json",
    "server/tsconfig.json",
    "frontend/tsconfig.eslint.json",
    ".github/workflows/frontend-ci.yml",
    "docs/LINT_CENSUS.md",
    "frontend/TYPE_SAFETY.md",
  ])
    assert.equal(isBootstrapSetupFile(file), true, file);
  for (const file of [
    "config/protocol-v2.json",
    "config/protocol-v2-vectors.json",
    "config/README.md",
    "frontend/vite.config.ts",
    "frontend/src/example.d.ts",
    "server/src/guards.ts",
    "server/smoke.js",
    "marketmaker/src/state.test.ts",
    "packages/local/src/index.ts",
    "scripts/compile.js",
    "scripts/lint-ratchet-extra.mjs",
    "server/tsconfig.loadtest.json",
    "frontend/package.json",
    "frontend/package-lock.json",
    ".gitignore",
  ])
    assert.equal(isBootstrapSetupFile(file), false, file);
});

test("package metadata permits script edits and preserves dependency inputs", () => {
  const base = { name: "example", dependencies: { example: "1.0.0" } };
  assert.equal(
    onlyPackageScriptsChanged(
      JSON.stringify(base),
      JSON.stringify({ ...base, scripts: { lint: "node lint.mjs" } }),
    ),
    true,
  );
  for (const changed of [
    { ...base, dependencies: { example: "2.0.0" } },
    { ...base, devDependencies: { example: "1.0.0" } },
    { ...base, exports: "./other.ts" },
    { ...base, types: "./other.d.ts" },
    { ...base, type: "module" },
    { ...base, scripts: [] },
    { ...base, scripts: { lint: null } },
  ]) {
    assert.equal(
      onlyPackageScriptsChanged(JSON.stringify(base), JSON.stringify(changed)),
      false,
    );
  }
});

test("ratchets reject globs, traversal, duplicates, invalid counts and suppression guards", () => {
  for (const changed of [
    { ...entry, file: "src/*.ts" },
    { ...entry, file: "../example.ts" },
    { ...entry, file: "/example.ts" },
    { ...entry, file: "dist/example.ts" },
    { ...entry, count: 0 },
    { ...entry, count: 1.5 },
    { ...entry, rule: "no-warning-comments" },
    { ...entry, rule: "@typescript-eslint/ban-ts-comment" },
    { ...entry, rule: "lint-policy/no-inline-config" },
  ]) {
    assert.throws(() => collectPairs(manifest([changed])), /Invalid ratchet/u);
  }
  assert.throws(() => collectPairs(manifest([entry, entry])), /Duplicate/u);
  assert.throws(() => collectPairs({ version: 2, entries: [] }), /version 1/u);
  assert.throws(() => legacyManifest({ version: 2, entries: [] }), /legacy/u);
  assert.doesNotThrow(() => legacyManifest([entry]));
  assert.doesNotThrow(() =>
    legacyManifest({ [entry.file]: { [entry.rule]: 2 } }),
  );
});

test("fatal diagnostics and suppression comments cannot become debt", () => {
  for (const message of [
    { ruleId: null, fatal: true, message: "Parser failed" },
    { ruleId: "no-warning-comments", message: "TypeScript directive" },
    { ruleId: "lint-policy/no-inline-config", message: "Inline override" },
  ]) {
    assert.throws(() =>
      collectFindings(
        [{ filePath: path.join(root, entry.file), messages: [message] }],
        root,
      ),
    );
  }
});

test("strict and stylistic type-aware rules cover apps, tests, tooling and every TS extension", async () => {
  const eslint = new ESLint({
    cwd: root,
    applySuppressions: false,
    overrideConfigFile: true,
    overrideConfig: strictConfig,
  });
  for (const file of [
    "src/example.ts",
    "src/example.test.ts",
    "test/example.tsx",
    "scripts/example.mts",
    "example.cts",
  ]) {
    const config = await eslint.calculateConfigForFile(path.join(root, file));
    for (const rule of [
      ...Object.keys(hardenedRules),
      "@typescript-eslint/no-unsafe-assignment",
      "@typescript-eslint/require-await",
      "@typescript-eslint/array-type",
      "@typescript-eslint/consistent-type-definitions",
      "lint-policy/no-inline-config",
    ]) {
      assert.equal(config.rules[rule][0], 2, `${file}: ${rule}`);
    }
    assert.equal(
      config.languageOptions.parserOptions.project,
      "./tsconfig.eslint.json",
    );
  }
});

test("node:test allowance is confined to exact test scopes and keeps ordinary promises checked", async () => {
  const registrations = ["test", "register", "describe", "it", "suite"]
    .flatMap((name) => [name, `${name}.skip`, `${name}.only`, `${name}.todo`])
    .concat(["skip", "only", "todo"]);
  const lines = [
    'import test, { test as register, describe, it, suite, skip, only, todo } from "node:test";',
    ...registrations.map((name) => `${name}("registration", () => {});`),
    'Promise.reject(new Error("ordinary rejection"));',
    ...["test", "describe", "it", "suite", "skip", "only", "todo"].map(
      (name) => `{ const ${name} = () => Promise.resolve(); ${name}(); }`,
    ),
  ];
  const helperPaths = [
    "src/protocol-v2-test-helper.ts",
    "src/taker-test-harness.ts",
    "src/taker-survival-child.ts",
  ];
  // This existing test is selected by both Node packages' build/test commands.
  const testPaths = ["src/config.test.ts"];
  const paths = [
    ...testPaths,
    ...helperPaths,
    "test/probe.test.ts",
    "src/nested/probe.test.ts",
    "src/.hidden.test.ts",
    "src/legacy-v1-test-helper.ts",
    "src/runtime.ts",
    "scripts/probe.mts",
    "src/probe.spec.ts",
    "test/probe.ts",
    "tests/probe.cts",
    "src/__tests__/probe.ts",
    "src/jsx-probe.test.tsx",
    "src/module-probe.test.mts",
    "src/common-probe.test.cts",
    "src/other-test-helper.ts",
    "src/nested/taker-test-harness.ts",
  ];
  const fixture = await makePolicyFixture(
    Object.fromEntries(paths.map((file) => [file, lines.join("\n")])),
  );
  try {
    const results = await fixture.eslint.lintFiles(["."]);
    assert.equal(results.length, paths.length);
    for (const result of results) {
      assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
      const file = path.relative(fixture.root, result.filePath);
      const exempt =
        (path.basename(root) !== "frontend" && testPaths.includes(file)) ||
        (path.basename(root) === "marketmaker" && helperPaths.includes(file));
      const config = await fixture.eslint.calculateConfigForFile(
        result.filePath,
      );
      const allowance =
        config.rules["@typescript-eslint/no-floating-promises"][1]
          ?.allowForKnownSafeCalls ?? [];
      assert.equal(allowance.length, exempt ? 1 : 0, file);
      assert.deepEqual(
        result.messages
          .filter(
            (message) =>
              message.ruleId === "@typescript-eslint/no-floating-promises",
          )
          .map((message) => message.line),
        lines.flatMap((_, index) =>
          index > (exempt ? registrations.length : 0) ? [index + 1] : [],
        ),
        file,
      );
    }
  } finally {
    await fixture.cleanup();
  }
});

test("unawaited context.test is checked outside executed test files", async () => {
  const source = [
    'import test from "node:test";',
    'test("parent", (context) => {',
    '  context.test("child", async () => {',
    "    await new Promise((resolve) => setTimeout(resolve, 25));",
    "  });",
    "});",
  ].join("\n");
  const fixture = await makePolicyFixture({
    "src/config.test.ts": source,
    "src/nested/probe.test.ts": source,
  });
  try {
    const results = await fixture.eslint.lintFiles(["."]);
    for (const result of results) {
      assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
      const file = path.relative(fixture.root, result.filePath);
      const exempt =
        path.basename(root) !== "frontend" && file === "src/config.test.ts";
      assert.deepEqual(
        result.messages
          .filter(
            (message) =>
              message.ruleId === "@typescript-eslint/no-floating-promises",
          )
          .map((message) => message.line),
        exempt ? [] : [2, 3],
        file,
      );
    }
  } finally {
    await fixture.cleanup();
  }
});

test("node:test inventory reports nested, hidden, excluded and out-of-source tests", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "qs-node-tests-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const packageRoot = path.join(temporary, "server");
  await mkdir(path.join(packageRoot, "src"), { recursive: true });
  await symlink(
    path.join(root, "node_modules"),
    path.join(packageRoot, "node_modules"),
    "dir",
  );
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      scripts: {
        build: "tsc",
        test: "npm run build && node --test dist/*.test.js && node smoke.js && node federation-smoke.js",
      },
    }),
  );
  await writeFile(
    path.join(packageRoot, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { rootDir: "src", outDir: "dist" },
      include: ["src"],
      exclude: ["src/excluded.test.ts"],
    }),
  );
  await writeFile(
    path.join(packageRoot, "src/executed.test.ts"),
    "export {};\n",
  );
  assert.deepEqual((await assertNodeTestsRun(packageRoot)).files, [
    "src/executed.test.ts",
  ]);
  const unrun = [
    "src/nested/probe.test.ts",
    "src/build/probe.test.ts",
    "src/.hidden.test.ts",
    "src/.ignored/probe.test.ts",
    "src/excluded.test.ts",
    "test/probe.test.ts",
    "scripts/probe.test.ts",
    "probe.test.ts",
    "dist/probe.test.ts",
  ];
  for (const file of unrun) {
    await mkdir(path.dirname(path.join(packageRoot, file)), {
      recursive: true,
    });
    await writeFile(path.join(packageRoot, file), "export {};\n");
  }
  assert.deepEqual(nodeTestScope(packageRoot).files, ["src/executed.test.ts"]);
  await assert.rejects(
    assertNodeTestsRun(packageRoot),
    (error) =>
      /test files not executed by npm test/u.test(error.message) &&
      unrun.every((file) => error.message.includes(JSON.stringify(file))),
  );
});

test("CI passes base and integration refs for main adoption", async () => {
  for (const name of [
    "frontend-ci",
    "orderbook-ci",
    "marketmaker-ci",
    "orderbook-release",
    "marketmaker-release",
  ]) {
    const source = await readFile(
      new URL(`../.github/workflows/${name}.yml`, import.meta.url),
      "utf8",
    );
    const commands = source
      .split("\n")
      .filter((line) => line.includes("npm run lint:ratchet --"));
    assert.ok(commands.length, name);
    for (const command of commands)
      assert.ok(
        command.includes(
          '--base-ref "$LINT_BASE_REF" --integration-ref "$LINT_INTEGRATION_REF"',
        ),
        name,
      );
    assert.equal(
      (source.match(/LINT_INTEGRATION_REF: origin\/dev/gu) ?? []).length,
      commands.length,
    );
    assert.ok(source.includes("fetch-depth: 0"), name);
    if (name.endsWith("-ci")) {
      assert.equal(
        source.split("'**/node_modules/**'").length - 1,
        2,
        `${name}: both event filters must cover tracked dependency paths`,
      );
      assert.equal(
        source.split("'scripts/lint-ratchet*.mjs'").length - 1,
        2,
        `${name}: both event filters must cover the node:test scope guard`,
      );
      assert.match(
        source,
        /  push:\n    branches:\n(?:      - [^\n]+\n)*      - main\n/u,
        name,
      );
    }
  }
});

test("generated output exclusions apply only at repository and package roots", () => {
  assert.equal(isSourceFile("frontend/dist/authored.ts"), true);
  for (const root of ["", "frontend/", "server/", "marketmaker/"]) {
    for (const directory of ["dist", "dist-loadtest", "build", "coverage"]) {
      assert.equal(isSourceFile(`${root}${directory}/output.ts`, true), false);
      for (const prefix of ["src/", "test/fixtures/", "scripts/"]) {
        const file = `${root}${prefix}${directory}/authored.ts`;
        assert.equal(isSourceFile(file, true), true, file);
        assert.doesNotThrow(() => collectPairs(manifest([{ ...entry, file }])));
      }
    }
  }
});

test("authored files under generated-looking directory names are fully linted", async () => {
  const source =
    '/* eslint-disable */\nexport type ReviewEscape = any;\nPromise.reject(new Error("unhandled work"));\n';
  const authored = ["build", "dist", "dist-loadtest", "coverage"].flatMap(
    (directory) => [
      `src/${directory}/probe.ts`,
      `test/fixtures/${directory}/probe.ts`,
    ],
  );
  const fixture = await makePolicyFixture(
    Object.fromEntries([
      ...authored.map((file) => [file, source]),
      ...["build", "dist", "dist-loadtest", "coverage"].map((directory) => [
        `${directory}/output.ts`,
        source,
      ]),
    ]),
  );
  try {
    const results = await fixture.eslint.lintFiles(["."]);
    assert.deepEqual(
      results
        .map((result) => path.relative(fixture.root, result.filePath))
        .sort(),
      authored.sort(),
    );
    for (const result of results) {
      assert.equal(result.fatalErrorCount, 0);
      const rules = result.messages.map((message) => message.ruleId);
      for (const rule of [
        "lint-policy/no-inline-config",
        "@typescript-eslint/no-explicit-any",
        "@typescript-eslint/no-floating-promises",
      ])
        assert.ok(rules.includes(rule), `${result.filePath}: ${rule}`);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("console policy preserves tests and allows service log levels", async () => {
  const source = ["info", "warn", "error", "log", "debug"]
    .map((method) => `console.${method}("probe");`)
    .join("\n");
  const testPaths = [
    "src/probe.test.ts",
    "src/probe.spec.ts",
    "test/probe.tsx",
    "tests/probe.cts",
    "src/__tests__/probe.ts",
  ];
  if (path.basename(root) === "marketmaker") {
    testPaths.push(
      "src/legacy-v1-test-helper.ts",
      "src/protocol-v2-test-helper.ts",
      "src/taker-test-harness.ts",
      "src/taker-survival-child.ts",
    );
  }
  const runtimePaths = ["src/runtime.ts", "scripts/cli.mts"];
  const fixture = await makePolicyFixture(
    Object.fromEntries(
      [...testPaths, ...runtimePaths].map((file) => [file, source]),
    ),
  );
  try {
    const results = await fixture.eslint.lintFiles(["."]);
    assert.equal(results.length, testPaths.length + runtimePaths.length);
    for (const result of results) {
      assert.equal(result.fatalErrorCount, 0);
      const file = path.relative(fixture.root, result.filePath);
      const allForbidden =
        path.basename(root) === "frontend" || testPaths.includes(file);
      assert.deepEqual(
        result.messages
          .filter((message) => message.ruleId === "no-console")
          .map((message) => message.line),
        allForbidden ? [1, 2, 3, 4, 5] : [4, 5],
        file,
      );
    }
  } finally {
    await fixture.cleanup();
  }
});

async function makePolicyFixture(sources) {
  const temporary = await mkdtemp(path.join(tmpdir(), "qs-lint-policy-"));
  try {
    await symlink(
      path.join(root, "node_modules"),
      path.join(temporary, "node_modules"),
      "dir",
    );
    await writeFile(
      path.join(temporary, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, target: "ES2022", module: "NodeNext" },
        // Explicit inputs let policy probes lint hidden paths too.
        files: Object.keys(sources),
        include: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
      }),
    );
    for (const [file, source] of Object.entries(sources)) {
      await mkdir(path.dirname(path.join(temporary, file)), {
        recursive: true,
      });
      await writeFile(path.join(temporary, file), source);
    }
    return {
      root: temporary,
      eslint: new ESLint({
        cwd: temporary,
        applySuppressions: false,
        overrideConfigFile: true,
        overrideConfig: [
          ...strictConfig,
          {
            files: ["**/*.{ts,tsx,mts,cts}"],
            languageOptions: {
              parserOptions: {
                project: "./tsconfig.json",
                tsconfigRootDir: temporary,
              },
            },
          },
        ],
      }),
      cleanup: () => rm(temporary, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

test("repeated typed scans cover checked sources, tests and scripts", async () => {
  const fixture = await makePolicyFixture({
    "src/probe.ts": "export type ReviewEscape = any;\n",
    "test/probe.ts": "Promise.resolve(1);\n",
    "scripts/probe.mts": "export type ReviewExtra = Array<string>;\n",
  });
  try {
    const expected = new Map([
      ["src/probe.ts: @typescript-eslint/no-explicit-any", 1],
      ["test/probe.ts: @typescript-eslint/no-floating-promises", 1],
      ["scripts/probe.mts: @typescript-eslint/array-type", 1],
    ]);
    for (let index = 0; index < 2; index++) {
      assert.deepEqual(
        collectPairs(
          collectFindings(await fixture.eslint.lintFiles(["."]), fixture.root),
        ),
        expected,
      );
    }
  } finally {
    await fixture.cleanup();
  }
});

test("inline disables and rule overrides fail even with inline configuration disabled", async () => {
  const eslint = new ESLint({
    cwd: root,
    applySuppressions: false,
    allowInlineConfig: false,
    overrideConfigFile: true,
    overrideConfig: [suppressionGuard],
  });
  for (const directive of [
    "// eslint-disable-next-line no-console",
    "/* eslint-disable */",
    "/* eslint-disable no-console */",
    "/* eslint no-console: off */",
    "/* eslint no-console: 0 */",
    "// eslint-enable",
    "// eslint-disable-line no-console",
  ]) {
    const [result] = await eslint.lintText(`${directive}\n`, {
      filePath: "probe.mjs",
    });
    assert.equal(
      result.messages[0]?.ruleId,
      "lint-policy/no-inline-config",
      directive,
    );
  }
  const [result] = await eslint.lintText(
    'const example = "eslint-disable";\n',
    {
      filePath: "probe.mjs",
    },
  );
  assert.equal(result.messages.length, 0);
});

test("the core comment guard rejects mixed-case no-check and extra slashes", async () => {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: {
      rules: { "no-warning-comments": hardenedRules["no-warning-comments"] },
    },
  });
  const directive = ["@ts", "nocheck"].join("-");
  for (const comment of [
    `// ${directive}`,
    `// ${directive.toUpperCase()}`,
    `//// ${directive.replace("nocheck", "NoCheck")}`,
    `/* ${directive.toUpperCase()} */`,
    `// explanation\r// ${directive.toUpperCase()}`,
  ]) {
    const [result] = await eslint.lintText(`${comment}\n`);
    assert.equal(result.messages[0]?.ruleId, "no-warning-comments", comment);
  }
});

test("both default and custom bulk suppression files leave the strict findings visible", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "qs-lint-suppressions-"));
  const oldLocation = process.env.ESLINT_SUPPRESSIONS_LOCATION;
  try {
    await writeFile(path.join(temporary, "example.js"), "debugger;\n");
    const suppressed = JSON.stringify({
      "example.js": { "no-debugger": { count: 1 } },
    });
    for (const name of [
      "eslint-suppressions.json",
      "custom-suppressions.json",
    ]) {
      await writeFile(path.join(temporary, name), suppressed);
      if (name.startsWith("custom")) {
        process.env.ESLINT_SUPPRESSIONS_LOCATION = path.join(temporary, name);
      } else {
        delete process.env.ESLINT_SUPPRESSIONS_LOCATION;
      }
      const options = {
        cwd: temporary,
        overrideConfigFile: true,
        overrideConfig: { rules: { "no-debugger": "error" } },
      };
      const [hidden] = await new ESLint({
        ...options,
        applySuppressions: true,
      }).lintFiles(["."]);
      assert.equal(hidden.messages.length, 0);
      assert.equal(hidden.suppressedMessages.length, 1);
      const [visible] = await new ESLint({
        ...options,
        applySuppressions: false,
      }).lintFiles(["."]);
      assert.equal(visible.messages[0]?.ruleId, "no-debugger");
    }
  } finally {
    if (oldLocation === undefined)
      delete process.env.ESLINT_SUPPRESSIONS_LOCATION;
    else process.env.ESLINT_SUPPRESSIONS_LOCATION = oldLocation;
    await rm(temporary, { recursive: true, force: true });
  }
});

test("the CLI refuses growth without writing and only regenerates resolved debt", async () => {
  const fixture = await makeFixture();
  try {
    await writeFile(fixture.source, "console.log('one');\n");
    await writeFile(
      fixture.manifest,
      JSON.stringify(manifest([entry]), null, 2) + "\n",
    );
    assert.equal(
      fixture.run("--check").status,
      1,
      "stale count must fail check",
    );
    assert.equal(
      fixture.run().status,
      0,
      "update must prune the resolved occurrence",
    );
    const pruned = await readFile(fixture.manifest, "utf8");
    assert.equal(JSON.parse(pruned).entries[0].count, 1);
    assert.equal(fixture.run("--check").status, 0);

    await writeFile(
      fixture.source,
      "console.log('one');\nconsole.log('two');\n",
    );
    for (const args of [[], ["--check"]]) {
      const result = fixture.run(...args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Ratchet growth/u);
      assert.equal(await readFile(fixture.manifest, "utf8"), pruned);
    }

    // Resolving an old pair cannot fund an allowance for a different file.
    await writeFile(fixture.source, "export {};\n");
    const added = path.join(fixture.package, "scripts/new.ts");
    await mkdir(path.dirname(added));
    await writeFile(added, "console.log('new pair');\n");
    assert.equal(fixture.run().status, 1);
    assert.equal(await readFile(fixture.manifest, "utf8"), pruned);
    await rm(added);
    assert.equal(fixture.run().status, 0);
    assert.deepEqual(
      JSON.parse(await readFile(fixture.manifest, "utf8")).entries,
      [],
    );
    assert.equal(fixture.run("--check").status, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("versioned and legacy bases preserve their growth guards", async () => {
  const fixture = await makeFixture();
  try {
    await writeFile(
      fixture.source,
      "console.log('one');\nconsole.log('two');\n",
    );
    const current = JSON.stringify(manifest([entry]), null, 2) + "\n";
    await writeFile(fixture.manifest, current);
    const bin = path.join(fixture.root, "bin");
    await mkdir(bin, { recursive: true });
    const basePath = path.join(fixture.root, "base.json");
    const baseSourcePath = path.join(bin, "base-source");
    await copyFile(fixture.source, baseSourcePath);
    // A read-only Git fixture exercises CLI dispatch without creating commits.
    await writeFile(
      path.join(bin, "git"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const args = process.argv.slice(2);
const files = [
  ["frontend/src/example.ts", process.env.QS_LINT_TEST_SOURCE],
  ["frontend/package.json", "frontend/package.json"],
];
if (args[0] === "rev-parse") console.log(args.includes("--show-object-format") ? "sha1" : (args.at(-1) === "origin/dev^{commit}" ? "b" : "a").repeat(40));
else if (args[0] === "ls-tree") {
  if (args.includes("-r")) {
    for (const [name, source] of files) {
      const bytes = fs.readFileSync(source);
      const hash = crypto.createHash("sha1").update("blob " + bytes.length + "\\0").update(bytes).digest("hex");
      process.stdout.write("100644 blob " + hash + "\\t" + name + "\\0");
    }
  }
  else console.log("frontend/eslint-ratchet.json");
} else if (args[0] === "ls-files") {
  process.stdout.write(files.map(([name]) => name + "\\0").join(""));
} else if (args[0] === "show") {
  const file = args[1].endsWith("/eslint-ratchet.json")
    ? (args[1].startsWith("b".repeat(40)) ? process.env.QS_LINT_TEST_INTEGRATION ?? process.env.QS_LINT_TEST_BASE : process.env.QS_LINT_TEST_BASE)
    : process.env.QS_LINT_TEST_SOURCE;
  process.stdout.write(fs.readFileSync(file));
}
else process.exit(2);
`,
      { mode: 0o700 },
    );
    fixture.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    fixture.env.QS_LINT_TEST_BASE = basePath;
    fixture.env.QS_LINT_TEST_SOURCE = baseSourcePath;
    for (const baseline of [manifest([]), manifest([{ ...entry, count: 1 }])]) {
      await writeFile(basePath, JSON.stringify(baseline));
      for (const args of [[], ["--check"]]) {
        const result = fixture.run(...args, "--base-ref", "test-base");
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Ratchet growth against test-base/u);
        assert.equal(await readFile(fixture.manifest, "utf8"), current);
      }
    }
    await writeFile(basePath, current);
    assert.equal(fixture.run("--check", "--base-ref", "test-base").status, 0);

    for (const baseline of [[], {}]) {
      await writeFile(basePath, JSON.stringify(baseline));
      const result = fixture.run("--check", "--base-ref", "test-base");
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /bootstrap source equality verified/u);
    }
    await writeFile(
      fixture.source,
      "console.log('changed');\nconsole.log('two');\n",
    );
    const changed = fixture.run("--check", "--base-ref", "test-base");
    assert.equal(changed.status, 1);
    assert.match(changed.stderr, /Bootstrap setup PR must not change sources/u);
    await copyFile(baseSourcePath, fixture.source);
    await writeFile(path.join(fixture.package, "src/extra.ts"), "export {};\n");
    const added = fixture.run("--check", "--base-ref", "test-base");
    assert.equal(added.status, 1);
    assert.match(added.stderr, /Bootstrap setup PR must not change sources/u);
    assert.equal(await readFile(fixture.manifest, "utf8"), current);

    await rm(path.join(fixture.package, "src/extra.ts"));
    const integrationPath = path.join(fixture.root, "integration.json");
    await writeFile(integrationPath, current);
    fixture.env.QS_LINT_TEST_INTEGRATION = integrationPath;
    await writeFile(
      fixture.source,
      "console.log('changed on dev');\nconsole.log('two');\n",
    );
    const promoted = fixture.run("--check", "--base-ref", "test-base");
    assert.equal(promoted.status, 0, promoted.stderr);
    assert.match(
      promoted.stdout,
      /allowances did not grow against origin\/dev/u,
    );
    assert.doesNotMatch(promoted.stdout, /bootstrap/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("reference arguments reject empty refs and an integration ref without a base", async () => {
  const fixture = await makeFixture();
  try {
    for (const args of [
      ["--base-ref", " "],
      ["--base-ref", "HEAD", "--integration-ref", " "],
      ["--integration-ref", "origin/dev"],
    ]) {
      const result = fixture.run("--check", ...args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /must be a Git ref|requires --base-ref/u);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function makeFixture() {
  const temporary = await mkdtemp(path.join(tmpdir(), "qs-lint-cli-"));
  const scripts = path.join(temporary, "scripts");
  const packageRoot = path.join(temporary, "frontend");
  await mkdir(scripts);
  await mkdir(path.join(packageRoot, "src"), { recursive: true });
  for (const file of [
    "eslint-policy.mjs",
    "lint-ratchet-lib.mjs",
    "lint-ratchet-node-tests.mjs",
    "lint-ratchet.mjs",
  ]) {
    await copyFile(
      fileURLToPath(new URL(file, import.meta.url)),
      path.join(scripts, file),
    );
  }
  await symlink(
    path.join(root, "node_modules"),
    path.join(packageRoot, "node_modules"),
    "dir",
  );
  await writeFile(
    path.join(packageRoot, "package.json"),
    '{"type":"module"}\n',
  );
  await writeFile(
    path.join(packageRoot, "eslint.config.js"),
    'export const strictConfig = [{ files: ["**/*.ts"], rules: { "no-console": "error" } }];\n',
  );
  const env = { ...process.env, CI: "true", TSESTREE_SINGLE_RUN: "true" };
  const bin = path.join(temporary, "bin");
  await mkdir(bin);
  // CLI-only fixtures have an empty read-only index. Integration tests use Git.
  await writeFile(
    path.join(bin, "git"),
    '#!/usr/bin/env node\nprocess.exit(process.argv[2] === "ls-files" ? 0 : 2);\n',
    { mode: 0o700 },
  );
  env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  return {
    root: temporary,
    package: packageRoot,
    source: path.join(packageRoot, "src/example.ts"),
    manifest: path.join(packageRoot, "eslint-ratchet.json"),
    env,
    run: (...args) =>
      spawnSync(
        process.execPath,
        [path.join(scripts, "lint-ratchet.mjs"), ...args],
        {
          cwd: packageRoot,
          env,
          encoding: "utf8",
          timeout: 20_000,
        },
      ),
  };
}
