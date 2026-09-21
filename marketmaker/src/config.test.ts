import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, readRequiredSecret } from "./config.js";

describe("bounded signed quote lifetime", () => {
  it("uses five minutes by default and rejects unsafe or noninteger bounds", () => {
    const keys = ["MM_ORDER_LIFETIME_S", "MM_ETH_PRIVATE_KEY", "MM_ETH_PRIVATE_KEY_FILE",
      "MM_QRL_HEXSEED", "MM_QRL_HEXSEED_FILE"];
    const before = new Map(keys.map(key => [key, process.env[key]]));
    try {
      process.env.MM_ETH_PRIVATE_KEY = "test-only-unused-key";
      process.env.MM_QRL_HEXSEED = "test-only-unused-seed";
      delete process.env.MM_ETH_PRIVATE_KEY_FILE;
      delete process.env.MM_QRL_HEXSEED_FILE;
      delete process.env.MM_ORDER_LIFETIME_S;
      assert.equal(loadConfig().orderLifetimeS, 300);
      for (const value of ["180", "300", "1800"]) {
        process.env.MM_ORDER_LIFETIME_S = value;
        assert.equal(loadConfig().orderLifetimeS, Number(value));
      }
      for (const value of ["0", "179", "1801", "300.5", "NaN", "Infinity"]) {
        process.env.MM_ORDER_LIFETIME_S = value;
        assert.throws(() => loadConfig(), /MM_ORDER_LIFETIME_S/);
      }
    } finally {
      for (const [key, value] of before) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

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
