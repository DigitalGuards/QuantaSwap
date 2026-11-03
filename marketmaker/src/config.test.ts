import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidSeedError, Web3 } from "@theqrl/web3";
import {
  loadConfig,
  normalizeQrlHexseed,
  readRequiredSecret,
} from "./config.js";
import { ProtocolSigner } from "./protocol-signing.js";
import { canonicalQip55QrlAddress } from "./qip55.js";
import { loadTakerConfig } from "./taker-config.js";

describe("bounded signed quote lifetime", () => {
  it("uses five minutes by default and rejects unsafe or noninteger bounds", () => {
    const keys = [
      "MM_ORDER_LIFETIME_S",
      "MM_ETH_PRIVATE_KEY",
      "MM_ETH_PRIVATE_KEY_FILE",
      "MM_QRL_HEXSEED",
      "MM_QRL_HEXSEED_FILE",
    ];
    const before = new Map(keys.map((key) => [key, process.env[key]]));
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
  it("reads a secret file and strips its trailing newline", () => {
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
    });
  });

  it("rejects ambiguous direct and file sources", () => {
    withSecretEnv(() => {
      process.env.TEST_SIGNING_SECRET = "direct";
      process.env.TEST_SIGNING_SECRET_FILE = "/not/read";
      assert.throws(
        () => readRequiredSecret("TEST_SIGNING_SECRET"),
        /mutually exclusive/,
      );
    });
  });

  it("rejects missing and empty secrets", () => {
    withSecretEnv(() => {
      assert.throws(
        () => readRequiredSecret("TEST_SIGNING_SECRET"),
        /is required/,
      );
      const dir = mkdtempSync(join(tmpdir(), "mm-secret-test-"));
      try {
        const file = join(dir, "key");
        writeFileSync(file, "\n", { mode: 0o600 });
        process.env.TEST_SIGNING_SECRET_FILE = file;
        assert.throws(
          () => readRequiredSecret("TEST_SIGNING_SECRET"),
          /empty secret file/,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("CoinPaprika fallback interval", () => {
  it("defaults to the budget floor and rejects anything below it", () => {
    const keys = [
      "MM_PRICE_FALLBACK_INTERVAL_S",
      "MM_ETH_PRIVATE_KEY",
      "MM_ETH_PRIVATE_KEY_FILE",
      "MM_QRL_HEXSEED",
      "MM_QRL_HEXSEED_FILE",
    ];
    const before = new Map(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.MM_ETH_PRIVATE_KEY = "test-only-unused-key";
      process.env.MM_QRL_HEXSEED = "test-only-unused-seed";
      delete process.env.MM_ETH_PRIVATE_KEY_FILE;
      delete process.env.MM_QRL_HEXSEED_FILE;
      delete process.env.MM_PRICE_FALLBACK_INTERVAL_S;
      assert.equal(loadConfig().priceFallbackIntervalS, 900);
      process.env.MM_PRICE_FALLBACK_INTERVAL_S = "3600";
      assert.equal(loadConfig().priceFallbackIntervalS, 3600);
      for (const value of ["0", "60", "899"]) {
        process.env.MM_PRICE_FALLBACK_INTERVAL_S = value;
        assert.throws(() => loadConfig(), /MM_PRICE_FALLBACK_INTERVAL_S/);
      }
    } finally {
      for (const [key, value] of before) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

/** Run with the given variables set and every other listed one unset, then
 *  restore the environment as it was. */
function withEnv(
  keys: readonly string[],
  values: Readonly<Record<string, string>>,
  run: () => void,
): void {
  const before = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) {
      const value = values[key];
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}

void describe("QRL extended seed spelling", () => {
  // @theqrl/web3 2.0.0 parses a seed only with a lowercase 0x prefix and
  // throws InvalidSeedError on the bare hex and on 0X, both of which 1.0.3
  // signed with. A seed file written by hand can carry either, so the loaders
  // settle the spelling before web3 or the protocol signer reads the seed.
  const body = `010000${"c3".repeat(48)}`;
  const canonical = `0x${body}`;
  const spellings = [body, `0X${body}`, ` ${canonical}\n`, canonical];

  void it("hands web3 the 0x spelling of every accepted form", () => {
    assert.throws(
      () => new Web3().qrl.accounts.seedToAccount(body),
      InvalidSeedError,
    );
    const expected = new Web3().qrl.accounts.seedToAccount(canonical).address;
    for (const spelling of spellings) {
      const seed = normalizeQrlHexseed(spelling);
      assert.equal(seed, canonical);
      assert.equal(
        new Web3().qrl.accounts.seedToAccount(seed).address,
        expected,
      );
    }
    // The hex digits keep their case, which web3 parses as well.
    const upper = normalizeQrlHexseed(body.toUpperCase());
    assert.equal(upper, `0x${body.toUpperCase()}`);
    assert.equal(
      new Web3().qrl.accounts.seedToAccount(upper).address,
      expected,
    );
  });

  void it("binds web3 and the protocol signer to one account", () => {
    const seed = normalizeQrlHexseed(body);
    const signer = new ProtocolSigner(seed);
    try {
      assert.equal(
        canonicalQip55QrlAddress(
          new Web3().qrl.accounts.seedToAccount(seed).address,
        ),
        canonicalQip55QrlAddress(signer.address),
      );
    } finally {
      signer.close();
    }
  });

  void it("leaves any other value for the signer to refuse", () => {
    for (const value of [
      "test-only-unused-seed",
      `0x${body.slice(2)}`,
      `${canonical}00`,
      `0x${"zz".repeat(51)}`,
      `0x0x${body}`,
    ]) {
      assert.equal(normalizeQrlHexseed(value), value);
    }
  });

  void it("spells MM_QRL_HEXSEED for web3 from the environment and from a file", () => {
    const keys = [
      "MM_ETH_PRIVATE_KEY",
      "MM_ETH_PRIVATE_KEY_FILE",
      "MM_QRL_HEXSEED",
      "MM_QRL_HEXSEED_FILE",
    ];
    withEnv(
      keys,
      { MM_ETH_PRIVATE_KEY: "test-only-unused-key", MM_QRL_HEXSEED: body },
      () => {
        assert.equal(loadConfig().qrlHexseed, canonical);
      },
    );
    const dir = mkdtempSync(join(tmpdir(), "mm-seed-test-"));
    try {
      const file = join(dir, "qrl-hexseed");
      writeFileSync(file, `0X${body}\n`, { mode: 0o600 });
      withEnv(
        keys,
        {
          MM_ETH_PRIVATE_KEY: "test-only-unused-key",
          MM_QRL_HEXSEED_FILE: file,
        },
        () => {
          assert.equal(loadConfig().qrlHexseed, canonical);
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("spells TAKER_QRL_HEXSEED for web3", () => {
    withEnv(
      [
        "TAKER_ETH_PRIVATE_KEY",
        "TAKER_ETH_PRIVATE_KEY_FILE",
        "TAKER_QRL_HEXSEED",
        "TAKER_QRL_HEXSEED_FILE",
      ],
      {
        TAKER_ETH_PRIVATE_KEY: "test-only-unused-key",
        TAKER_QRL_HEXSEED: body,
      },
      () => {
        assert.equal(loadTakerConfig().qrlHexseed, canonical);
      },
    );
  });
});
