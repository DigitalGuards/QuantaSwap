import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRequiredSecret } from "./config.js";

function withSecretEnv(run: () => void): void {
  const direct = process.env.TEST_SIGNING_SECRET;
  const file = process.env.TEST_SIGNING_SECRET_FILE;
  try {
    delete process.env.TEST_SIGNING_SECRET;
    delete process.env.TEST_SIGNING_SECRET_FILE;
    run();
  } finally {
    if (direct === undefined) delete process.env.TEST_SIGNING_SECRET;
    else process.env.TEST_SIGNING_SECRET = direct;
    if (file === undefined) delete process.env.TEST_SIGNING_SECRET_FILE;
    else process.env.TEST_SIGNING_SECRET_FILE = file;
  }
}

describe("file-backed signing secrets", () => {
  it("reads a secret file and strips its trailing newline", () =>
    withSecretEnv(() => {
      const dir = mkdtempSync(join(tmpdir(), "mm-secret-test-"));
      try {
        const file = join(dir, "key");
        writeFileSync(file, "0xabc\n", { mode: 0o600 });
        process.env.TEST_SIGNING_SECRET_FILE = file;
        assert.equal(readRequiredSecret("TEST_SIGNING_SECRET"), "0xabc");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }));

  it("rejects ambiguous direct and file sources", () =>
    withSecretEnv(() => {
      process.env.TEST_SIGNING_SECRET = "direct";
      process.env.TEST_SIGNING_SECRET_FILE = "/not/read";
      assert.throws(
        () => readRequiredSecret("TEST_SIGNING_SECRET"),
        /mutually exclusive/,
      );
    }));

  it("rejects missing and empty secrets", () =>
    withSecretEnv(() => {
      assert.throws(() => readRequiredSecret("TEST_SIGNING_SECRET"), /is required/);
      const dir = mkdtempSync(join(tmpdir(), "mm-secret-test-"));
      try {
        const file = join(dir, "key");
        writeFileSync(file, "\n", { mode: 0o600 });
        process.env.TEST_SIGNING_SECRET_FILE = file;
        assert.throws(() => readRequiredSecret("TEST_SIGNING_SECRET"), /empty secret file/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }));
});
