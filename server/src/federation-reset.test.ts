import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  FederationConcurrencyLimiter,
  FederationResetLimiter,
  FederationResponseCache,
  federationBearerAuthorized,
  federationResponseCacheKey,
} from "./federation-reset.js";

describe("federation bearer authentication", () => {
  it("accepts only the exact configured 32-byte bearer token", () => {
    const token = "ab".repeat(32);
    assert.equal(federationBearerAuthorized(`Bearer ${token}`, token), true);
    assert.equal(federationBearerAuthorized(`bearer ${token}`, token), false);
    assert.equal(federationBearerAuthorized(`Bearer ${"ac".repeat(32)}`, token), false);
    assert.equal(federationBearerAuthorized(`Bearer ${token} `, token), false);
    assert.equal(federationBearerAuthorized([`Bearer ${token}`], token), false);
    assert.equal(federationBearerAuthorized(undefined, token), false);
    assert.equal(federationBearerAuthorized(`Bearer ${token}`, null), false);
  });
});

describe("federation reset limiter", () => {
  it("defaults to four resets per source and sixty-four globally each minute", () => {
    const perSource = new FederationResetLimiter();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      assert.equal(perSource.allow("source-a", 0), true);
    }
    assert.equal(perSource.allow("source-a", 0), false);

    const global = new FederationResetLimiter();
    for (let source = 0; source < 64; source += 1) {
      assert.equal(global.allow(`source-${source}`, 0), true);
    }
    assert.equal(global.allow("source-64", 0), false);
  });

  it("enforces the per-source allowance independently", () => {
    const limiter = new FederationResetLimiter({
      perSourceLimit: 2,
      globalLimit: 8,
      windowMs: 1_000,
    });

    assert.equal(limiter.allow("source-a", 100), true);
    assert.equal(limiter.allow("source-a", 200), true);
    assert.equal(limiter.allow("source-a", 300), false);
    assert.equal(limiter.allow("source-b", 300), true);
  });

  it("bounds accepted resets globally across distinct sources", () => {
    const limiter = new FederationResetLimiter({
      perSourceLimit: 4,
      globalLimit: 3,
      windowMs: 1_000,
    });

    assert.equal(limiter.allow("source-a", 100), true);
    assert.equal(limiter.allow("source-b", 200), true);
    assert.equal(limiter.allow("source-c", 300), true);
    assert.equal(limiter.allow("source-d", 400), false);
    assert.equal(limiter.allow("source-a", 400), false);
  });

  it("resets source and global counters at the next fixed window", () => {
    const limiter = new FederationResetLimiter({
      perSourceLimit: 1,
      globalLimit: 2,
      windowMs: 1_000,
    });

    assert.equal(limiter.allow("source-a", 0), true);
    assert.equal(limiter.allow("source-b", 999), true);
    assert.equal(limiter.allow("source-a", 999), false);
    assert.equal(limiter.allow("source-a", 1_000), true);
    assert.equal(limiter.allow("source-c", 1_001), true);
    assert.equal(limiter.allow("source-b", 1_002), false);
  });

  it("does not reopen a spent window when the clock moves backward", () => {
    const limiter = new FederationResetLimiter({
      perSourceLimit: 1,
      globalLimit: 1,
      windowMs: 1_000,
    });

    assert.equal(limiter.allow("source-a", 1_100), true);
    assert.equal(limiter.allow("source-b", 900), false);
  });

  it("rejects invalid configuration, sources, and timestamps", () => {
    assert.throws(
      () => new FederationResetLimiter({ perSourceLimit: 0 }),
      /positive integer/,
    );
    const limiter = new FederationResetLimiter();
    assert.throws(() => limiter.allow("", 0), /source is invalid/);
    assert.throws(() => limiter.allow("source", -1), /time is invalid/);
  });
});

describe("federation response concurrency", () => {
  it("limits each source and the global active response count", () => {
    const limiter = new FederationConcurrencyLimiter({
      perSourceLimit: 1,
      globalLimit: 2,
    });
    const releaseA = limiter.acquire("source-a");
    const releaseB = limiter.acquire("source-b");
    assert.ok(releaseA);
    assert.ok(releaseB);
    assert.equal(limiter.acquire("source-a"), null);
    assert.equal(limiter.acquire("source-c"), null);
    releaseA();
    const releaseC = limiter.acquire("source-c");
    assert.ok(releaseC);
    releaseA();
    releaseB();
    releaseC();
  });

  it("keeps capacity available for another authenticated source", () => {
    const limiter = new FederationConcurrencyLimiter({
      perSourceLimit: 1,
      globalLimit: 16,
    });
    const releaseHostile = limiter.acquire("peer:192.0.2.10");
    assert.ok(releaseHostile);
    assert.equal(limiter.acquire("peer:192.0.2.10"), null);
    const releaseHonest = limiter.acquire("peer:192.0.2.11");
    assert.ok(releaseHonest);
    releaseHostile();
    releaseHonest();
  });
});

describe("federation serialized response cache", () => {
  it("shares one reset buffer across caller-supplied page limits", () => {
    const cache = new FederationResponseCache();
    let calls = 0;
    const create = (): string => {
      calls += 1;
      return "reset-body";
    };
    const limitOne = federationResponseCacheKey(true, "foreign:1", 1, 1, 9);
    const limitMax = federationResponseCacheKey(true, null, 256, 1, 9);
    assert.equal(limitOne, limitMax);
    assert.equal(cache.getOrCreate(limitOne, create, 0).toString(), "reset-body");
    assert.equal(cache.getOrCreate(limitMax, create, 0).toString(), "reset-body");
    assert.equal(calls, 1);

    assert.notEqual(
      federationResponseCacheKey(false, "feed:1", 1, 1, 9),
      federationResponseCacheKey(false, "feed:1", 256, 1, 9),
    );
  });

  it("reuses identical pages and expires or evicts within fixed bounds", () => {
    const cache = new FederationResponseCache({
      maxEntries: 2,
      maxBytes: 8,
      ttlMs: 100,
    });
    let calls = 0;
    const create = (value: string) => () => {
      calls += 1;
      return value;
    };

    assert.equal(cache.getOrCreate("one", create("1111"), 0).toString(), "1111");
    assert.equal(cache.getOrCreate("one", create("xxxx"), 50).toString(), "1111");
    assert.equal(calls, 1);
    cache.getOrCreate("two", create("2222"), 50);
    cache.getOrCreate("three", create("3333"), 50);
    assert.equal(cache.getOrCreate("one", create("4444"), 50).toString(), "4444");
    assert.equal(calls, 4);
    assert.equal(cache.getOrCreate("one", create("5555"), 150).toString(), "5555");
    assert.equal(calls, 5);
  });
});
