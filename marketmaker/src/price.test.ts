// The pure parts of the price feed: cross-rate math, garbage rejection,
// drift detection, and the never-quote-blind staleness gate.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { PriceFeed, midMilliFromUsd, needsReprice } from "./price.js";

describe("midMilliFromUsd", () => {
  it("derives the cross rate in integer milli", () => {
    assert.equal(midMilliFromUsd(1700, 1), 1_700_000n);
    assert.equal(midMilliFromUsd(1712.34, 1.02), BigInt(Math.round((1712.34 / 1.02) * 1000)));
  });

  it("derives the USDC cross rate with the same math", () => {
    // 1 USD USDC over 0.5 USD QRL = 2 QRL per USDC = 2000 milli
    assert.equal(midMilliFromUsd(1, 0.5), 2_000n);
    assert.equal(midMilliFromUsd(0.9998, 0.02), BigInt(Math.round((0.9998 / 0.02) * 1000)));
  });

  it("rejects garbage quotes", () => {
    assert.equal(midMilliFromUsd(0, 1), null);
    assert.equal(midMilliFromUsd(1700, 0), null);
    assert.equal(midMilliFromUsd(Number.NaN, 1), null);
    assert.equal(midMilliFromUsd(1700, -1), null);
    assert.equal(midMilliFromUsd(1700, Number.POSITIVE_INFINITY), null);
  });
});

describe("needsReprice", () => {
  it("triggers only beyond the threshold", () => {
    // 1% threshold around 1,700,000
    assert.equal(needsReprice(1_700_000n, 1_700_000n, 100n), false);
    assert.equal(needsReprice(1_700_000n, 1_716_999n, 100n), false); // 0.99% below
    assert.equal(needsReprice(1_700_000n, 1_717_180n, 100n), true); // just past 1%
    assert.equal(needsReprice(1_700_000n, 1_682_000n, 100n), true); // downward drift
  });
});

describe("staleness gate", () => {
  const opts = { url: "unused", refreshS: 300, maxAgeS: 1800, timeoutMs: 20_000, log: () => undefined };

  it("static mode always quotes the ETH pair", () => {
    const feed = new PriceFeed({ ...opts, staticMilli: 1_700_000n });
    assert.equal(feed.current(0, "ETH"), 1_700_000n);
    assert.equal(feed.current(10_000_000, "ETH"), 1_700_000n);
  });

  it("static mode never quotes token pairs (no static mid exists for them)", () => {
    const feed = new PriceFeed({ ...opts, staticMilli: 1_700_000n });
    assert.equal(feed.current(0, "USDC"), null);
    assert.equal(feed.current(0, "tUSDT"), null);
  });

  it("feed mode quotes nothing before the first successful fetch", () => {
    const feed = new PriceFeed({ ...opts, staticMilli: null });
    assert.equal(feed.current(1000, "ETH"), null);
    assert.equal(feed.current(1000, "USDC"), null);
  });
});
