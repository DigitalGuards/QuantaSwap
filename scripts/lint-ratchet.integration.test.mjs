import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { collectPairs } from "./lint-ratchet-lib.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const anyRule = "@typescript-eslint/no-explicit-any";
const packageNames = ["frontend", "server", "marketmaker"];
const currentPackage = path.basename(process.cwd());
const selectedPackage =
  process.env.LINT_RATCHET_TEST_PACKAGE ??
  (packageNames.includes(currentPackage) ? currentPackage : undefined);
assert.ok(!selectedPackage || packageNames.includes(selectedPackage));
const packages = selectedPackage ? [selectedPackage] : packageNames;
const git = (args) =>
  execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
const equalityFailure = /Bootstrap setup PR must not change sources:/u;
const exactFailure = /Bootstrap manifest must equal current findings exactly:/u;

async function fixture(t, pkg) {
  const temporary = await fs.mkdtemp(path.join(tmpdir(), "qs ratchet test-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const directory = path.join(temporary, "repository");
  const objects = path.join(temporary, "objects");
  await fs.mkdir(directory);
  await fs.mkdir(objects);
  const files = git([
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ])
    .split("\0")
    .filter(Boolean);
  const copied = [];
  // Keep every sibling and shared input in the fixture. Dependencies stay in
  // the installed package; no dependency installation or ref mutation occurs.
  for (const file of new Set(files)) {
    await fs.mkdir(path.dirname(path.join(directory, file)), {
      recursive: true,
    });
    try {
      await fs.copyFile(
        path.join(repository, file),
        path.join(directory, file),
      );
      copied.push(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await fs.writeFile(
    path.join(directory, ".git"),
    `gitdir: ${git(["rev-parse", "--absolute-git-dir"])}\n`,
  );
  const root = path.join(directory, pkg);
  await fs.symlink(
    path.join(repository, pkg, "node_modules"),
    path.join(root, "node_modules"),
    "dir",
  );
  const ledgerPath = path.join(root, "eslint-ratchet.json");
  const original = await fs.readFile(ledgerPath, "utf8");
  const env = {
    ...process.env,
    CI: "true",
    TSESTREE_SINGLE_RUN: "true",
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
    GIT_OBJECT_DIRECTORY: objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: git([
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
    ]),
  };
  const fixtureGit = (args, input) =>
    execFileSync("git", args, {
      cwd: directory,
      env,
      input,
      encoding: "utf8",
    }).trim();

  // Snapshot the checked sources so these tests survive later cleanup PRs.
  // All synthetic Git objects live outside the fixture in its private store.
  const entries = new Map();
  for (const file of copied) {
    let tree = entries;
    const parts = file.split("/");
    const name = parts.pop();
    for (const part of parts) {
      if (!tree.has(part)) tree.set(part, new Map());
      tree = tree.get(part);
    }
    const blob = fixtureGit(
      ["hash-object", "-w", "--stdin"],
      await fs.readFile(path.join(directory, file)),
    );
    tree.set(name, blob);
  }
  function writeTree(tree) {
    const rows = [...tree].map(([name, value]) =>
      value instanceof Map
        ? `040000 tree ${writeTree(value)}\t${name}`
        : `100644 blob ${value}\t${name}`,
    );
    return fixtureGit(["mktree", "-z"], `${rows.join("\0")}\0`);
  }
  const sourceTree = writeTree(entries);

  function replaceTreeEntry(tree, name, entry) {
    const rows = fixtureGit(["ls-tree", "-z", tree])
      .split("\0")
      .filter((line) => line && line.slice(line.indexOf("\t") + 1) !== name);
    if (entry) rows.push(entry);
    return fixtureGit(["mktree", "-z"], `${rows.join("\0")}\0`);
  }

  function baseWithManifest(source) {
    const blob =
      source === undefined
        ? undefined
        : fixtureGit(["hash-object", "-w", "--stdin"], source);
    const packageTree = replaceTreeEntry(
      `${sourceTree}:${pkg}`,
      "eslint-ratchet.json",
      blob && `100644 blob ${blob}\teslint-ratchet.json`,
    );
    const tree = replaceTreeEntry(
      sourceTree,
      pkg,
      `040000 tree ${packageTree}\t${pkg}`,
    );
    return fixtureGit(
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      `tree ${tree}\nauthor Ratchet Test <ratchet@example.invalid> 0 +0000\ncommitter Ratchet Test <ratchet@example.invalid> 0 +0000\n\nRatchet fixture\n`,
    );
  }

  function run(args, code, pattern) {
    const result = spawnSync("npm", args, {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.ifError(result.error);
    const output = result.stdout + result.stderr;
    assert.equal(result.status, code, output);
    if (pattern) assert.match(output, pattern);
    return output;
  }
  const check = (base, code = 0, pattern) =>
    run(["run", "lint:ratchet", "--", "--base-ref", base], code, pattern);
  const update = (base, code = 0, pattern) =>
    run(
      ["run", "lint:ratchet:update", "--", "--base-ref", base],
      code,
      pattern,
    );

  async function ledger(data) {
    collectPairs(data);
    data.entries.sort(
      (a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule),
    );
    await fs.writeFile(ledgerPath, `${JSON.stringify(data, null, 2)}\n`);
  }
  const backups = new Map();
  async function edit(file, transform) {
    const target = path.join(directory, file);
    if (!backups.has(file)) {
      backups.set(
        file,
        await fs.readFile(target).catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        }),
      );
    }
    const value =
      typeof transform === "function"
        ? transform(backups.get(file).toString())
        : transform;
    if (value === undefined) await fs.rm(target, { force: true });
    else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, value);
    }
  }
  async function restore() {
    await fs.writeFile(ledgerPath, original);
    for (const [file, bytes] of backups) {
      const target = path.join(directory, file);
      await fs.rm(target, { force: true });
      if (bytes !== undefined) await fs.writeFile(target, bytes);
    }
    backups.clear();
  }
  return {
    directory,
    root,
    ledgerPath,
    original,
    run,
    check,
    update,
    ledger,
    edit,
    restore,
    baseWithManifest,
    bootstrap: baseWithManifest(),
    withLedger: baseWithManifest(original),
  };
}

for (const pkg of packages) {
  test(`${pkg} lint ratchet integration`, async (t) => {
    const f = await fixture(t, pkg);
    t.beforeEach(f.restore);
    t.afterEach(f.restore);
    const probe = `${pkg}/src/review-bypass.ts`;
    const newPair = JSON.parse(f.original);
    const probeEntry = {
      file: "src/review-bypass.ts",
      rule: anyRule,
      count: 1,
    };
    newPair.entries.push(probeEntry);

    await t.test(
      "unchanged sources and exact manifest pass bootstrap check and update",
      async () => {
        f.check(f.bootstrap, 0, /bootstrap source equality verified/u);
        f.update(f.bootstrap, 0, /bootstrap source equality verified/u);
        assert.equal(await fs.readFile(f.ledgerPath, "utf8"), f.original);
        assert.doesNotMatch(
          f.check(f.withLedger),
          /bootstrap source equality/u,
        );
        f.check(f.baseWithManifest("{}\n"), 0, /legacy migration verified/u);
      },
    );

    await t.test(
      "only allowed setup files and package scripts may differ",
      async () => {
        for (const file of [
          `${pkg}/tsconfig.json`,
          `${pkg}/tsconfig.eslint.json`,
          `${pkg}/${pkg === "frontend" ? "eslint.config.js" : "eslint.config.mjs"}`,
          "scripts/eslint-policy.mjs",
          ".github/workflows/frontend-ci.yml",
          "docs/LINT_CENSUS.md",
        ])
          await f.edit(file, (source) => `${source}\n`);
        await f.edit(`${pkg}/package.json`, (source) => {
          const data = JSON.parse(source);
          data.scripts["lint:fixture"] = "node --version";
          return `${JSON.stringify(data, null, 2)}\n`;
        });
        f.check(f.bootstrap);
      },
    );

    await t.test(
      "new any without an allowance fails checks and regeneration",
      async () => {
        await f.edit(probe, "export type ReviewEscape = any;\n");
        f.check(f.bootstrap, 1, equalityFailure);
        f.check(f.withLedger, 1, /against eslint-ratchet.json[\s\S]*0 -> 1/u);
        f.update(f.withLedger, 1, /0 -> 1/u);
        assert.equal(await fs.readFile(f.ledgerPath, "utf8"), f.original);
      },
    );

    await t.test(
      "new any plus its allowance fails bootstrap and saved bases",
      async () => {
        await f.edit(probe, "export type ReviewEscape = any;\n");
        await f.ledger(newPair);
        f.run(["run", "lint"], 0);
        f.check(f.bootstrap, 1, equalityFailure);
        f.check(f.withLedger, 1, /0 -> 1/u);
        const before = await fs.readFile(f.ledgerPath, "utf8");
        f.update(f.bootstrap, 1, equalityFailure);
        assert.equal(await fs.readFile(f.ledgerPath, "utf8"), before);
      },
    );

    await t.test(
      "Git-ignored authored sources still fail bootstrap",
      async () => {
        const file = `${pkg}/src/.env.review.ts`;
        await f.edit(file, "export type ReviewEscape = any;\n");
        assert.ok(f.check(f.bootstrap, 1, equalityFailure).includes(file));
      },
    );

    const sibling = {
      frontend: "server/src/guards.ts",
      server: "marketmaker/src/guards.ts",
      marketmaker: "frontend/src/lib/protocol-v2-wire.ts",
    }[pkg];
    for (const file of [
      "config/protocol-v2.json",
      "config/protocol-v2-vectors.json",
      sibling,
    ]) {
      await t.test(
        `shared or sibling source plus allowance fails: ${file}`,
        async () => {
          await f.edit(file, (source) => `${source}\n`);
          const data = JSON.parse(f.original);
          data.entries[0].count += 1;
          await f.ledger(data);
          const before = await fs.readFile(f.ledgerPath, "utf8");
          assert.ok(f.check(f.bootstrap, 1, equalityFailure).includes(file));
          f.update(f.bootstrap, 1, equalityFailure);
          assert.equal(await fs.readFile(f.ledgerPath, "utf8"), before);
        },
      );
    }

    for (const [label, mutate] of [
      [
        "raised count",
        (data) => {
          data.entries[0].count += 1;
        },
      ],
      [
        "lowered count",
        (data) => {
          data.entries.find((entry) => entry.count > 1).count -= 1;
        },
      ],
      [
        "extra pair",
        (data) => {
          data.entries.push(probeEntry);
        },
      ],
      [
        "missing pair",
        (data) => {
          data.entries.shift();
        },
      ],
    ]) {
      await t.test(
        `unchanged sources with ${label} fail bootstrap check and update`,
        async () => {
          const data = JSON.parse(f.original);
          mutate(data);
          await f.ledger(data);
          const before = await fs.readFile(f.ledgerPath, "utf8");
          f.check(f.bootstrap, 1, exactFailure);
          f.update(f.bootstrap, 1, exactFailure);
          assert.equal(await fs.readFile(f.ledgerPath, "utf8"), before);
        },
      );
    }

    await t.test(
      "deleted, renamed and symlinked sources fail bootstrap",
      async () => {
        const file = `${pkg}/${JSON.parse(f.original).entries[0].file}`;
        const bytes = await fs.readFile(path.join(f.directory, file));
        await f.edit(file, undefined);
        f.check(f.bootstrap, 1, equalityFailure);
        await f.edit(`${pkg}/src/renamed.ts`, bytes);
        f.check(f.bootstrap, 1, equalityFailure);
        await fs.symlink(
          path.join(f.directory, pkg, "src/renamed.ts"),
          path.join(f.directory, file),
        );
        f.check(f.bootstrap, 1, equalityFailure);
      },
    );

    await t.test(
      "package dependency metadata and lockfiles stay frozen",
      async () => {
        for (const file of [
          `${pkg}/package.json`,
          `${pkg}/package-lock.json`,
        ]) {
          await f.edit(file, (source) => {
            const data = JSON.parse(source);
            data.version = "0.0.0-fixture";
            return `${JSON.stringify(data, null, 2)}\n`;
          });
          f.check(f.bootstrap, 1, equalityFailure);
          await f.restore();
        }
      },
    );

    await t.test(
      "saved bases preserve ceilings and permit shrinking resolved debt",
      async () => {
        const data = JSON.parse(f.original);
        data.entries[0].count += 1;
        await f.ledger(data);
        f.check(f.withLedger, 1, /Ratchet growth/u);
        const largerBase = f.baseWithManifest(JSON.stringify(data));
        f.check(largerBase, 1, /Ratchet shrank or is not canonical/u);
        f.update(largerBase);
        assert.equal(await fs.readFile(f.ledgerPath, "utf8"), f.original);
        const file = `${pkg}/${data.entries[0].file}`;
        await f.edit(file, (source) => `${source}\n`);
        f.check(f.withLedger);
        f.check(
          f.baseWithManifest("{}\n"),
          1,
          /requires unchanged TypeScript/u,
        );
      },
    );

    await t.test(
      "typed debt in an existing file cannot gain an allowance",
      async () => {
        const file = JSON.parse(f.original).entries[0].file;
        await f.edit(
          `${pkg}/${file}`,
          (source) =>
            `${source}\nexport const reviewUnsafe = JSON.parse("null");\n`,
        );
        const data = JSON.parse(f.original);
        const rule = "@typescript-eslint/no-unsafe-assignment";
        const entry = data.entries.find(
          (item) => item.file === file && item.rule === rule,
        );
        if (entry) entry.count += 1;
        else data.entries.push({ file, rule, count: 1 });
        await f.ledger(data);
        f.run(["run", "lint"], 0);
        f.check(f.bootstrap, 1, equalityFailure);
        f.check(f.withLedger, 1, /no-unsafe-assignment/u);
      },
    );

    await t.test("bulk suppressions cannot hide new debt", async () => {
      await f.edit(probe, "export type ReviewEscape = any;\n");
      await f.edit(
        `${pkg}/eslint-suppressions.json`,
        JSON.stringify({
          "src/review-bypass.ts": { [anyRule]: { count: 1 } },
        }),
      );
      f.check(f.withLedger, 1, /against eslint-ratchet.json[\s\S]*0 -> 1/u);
    });

    for (const [label, comment, diagnostic] of [
      [
        "disable",
        "/* eslint-disable @typescript-eslint/no-explicit-any */",
        /lint-policy\/no-inline-config/u,
      ],
      [
        "inline override",
        '/* eslint "@typescript-eslint/no-explicit-any": "off" */',
        /lint-policy\/no-inline-config/u,
      ],
      ["mixed-case nocheck", "/// @Ts-NoChEcK", /@ts-nocheck/iu],
    ]) {
      await t.test(`${label} is rejected`, async () => {
        await f.edit(probe, `${comment}\nexport const reviewValue = 1;\n`);
        f.check(f.withLedger, 1, diagnostic);
      });
    }

    await t.test(
      "invalid saved manifests fail without a bootstrap fallback",
      () => {
        f.check(
          f.baseWithManifest('{"version":2,"entries":[]}\n'),
          1,
          /Unrecognized legacy ratchet/u,
        );
        f.check(f.baseWithManifest("invalid JSON\n"), 1, /JSON/u);
      },
    );
  });
}
