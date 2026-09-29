// The pure parts of the price feed: cross-rate math, garbage rejection,
// drift detection, and the never-quote-blind staleness gate.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  COINPAPRIKA_TICKER_URL,
  PriceFeed,
  coingeckoSource,
  coingeckoUrl,
  coinpaprikaSource,
  midMilliFromUsd,
  needsReprice,
  type FetchFn,
  type PriceSource,
  type UsdQuotes,
} from "./price.js";
import type { AssetSymbol } from "./assets.js";

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
  const opts = {
    sources: [],
    refreshS: 300,
    maxAgeS: 1800,
    timeoutMs: 20_000,
    log: () => undefined,
  };

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

/** A scripted source: each call shifts the next outcome off `script` and
 *  records which symbols it was asked for. */
function scripted(
  name: string,
  minIntervalS: number,
  script: (UsdQuotes | Error)[],
): PriceSource & { calls: AssetSymbol[][]; timeouts: number[] } {
  const calls: AssetSymbol[][] = [];
  const timeouts: number[] = [];
  return {
    name,
    minIntervalS,
    calls,
    timeouts,
    fetch(symbols, timeoutMs) {
      calls.push([...symbols]);
      timeouts.push(timeoutMs);
      const next = script.shift();
      if (next === undefined) return Promise.reject(new Error("script exhausted"));
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
}

const QUOTES: UsdQuotes = {
  qrl: { usd: 0.5 },
  assets: { ETH: { usd: 2000 }, USDC: { usd: 1 } },
};

function feedWith(sources: PriceSource[], logs: string[] = []): PriceFeed {
  return new PriceFeed({
    sources,
    refreshS: 300,
    maxAgeS: 1800,
    staticMilli: null,
    timeoutMs: 1000,
    log: (...args) => logs.push(args.map(String).join(" ")),
  });
}

describe("source fallback", () => {
  it("uses the primary alone when it prices every stocked asset", async () => {
    const primary = scripted("primary", 0, [QUOTES]);
    const fallback = scripted("fallback", 900, [QUOTES]);
    const feed = feedWith([primary, fallback]);
    await feed.maybeRefresh(1000);
    assert.equal(feed.current(1000, "ETH"), 4_000_000n);
    assert.equal(feed.current(1000, "USDC"), 2_000n);
    assert.deepEqual(primary.calls, [["ETH", "USDC"]]);
    assert.equal(fallback.calls.length, 0);
  });

  it("falls back when the primary fails, and says so", async () => {
    const logs: string[] = [];
    const primary = scripted("primary", 0, [new Error("HTTP 403")]);
    const fallback = scripted("fallback", 900, [QUOTES]);
    const feed = feedWith([primary, fallback], logs);
    await feed.maybeRefresh(1000);
    assert.equal(feed.current(1000, "ETH"), 4_000_000n);
    assert.equal(feed.current(1000, "USDC"), 2_000n);
    assert.ok(logs.some((l) => l.includes("ETH,USDC from fallback (primary: HTTP 403)")));
    assert.ok(!logs.some((l) => l.includes("price feed error")));
  });

  it("asks the fallback only for what the primary left unpriced", async () => {
    const primary = scripted("primary", 0, [{ qrl: { usd: 0.5 }, assets: { ETH: { usd: 2000 } } }]);
    const fallback = scripted("fallback", 900, [{ qrl: { usd: 0.5 }, assets: { USDC: { usd: 1 } } }]);
    const feed = feedWith([primary, fallback]);
    await feed.maybeRefresh(1000);
    assert.deepEqual(fallback.calls, [["USDC"]]);
    assert.equal(feed.current(1000, "USDC"), 2_000n);
  });

  it("holds the fallback to its minimum interval and keeps the caches", async () => {
    const logs: string[] = [];
    const down = new Error("HTTP 403");
    const primary = scripted("primary", 0, [down, down, down, down]);
    const fallback = scripted("fallback", 900, [QUOTES, QUOTES]);
    const feed = feedWith([primary, fallback], logs);
    await feed.maybeRefresh(1000);
    await feed.maybeRefresh(1300);
    await feed.maybeRefresh(1600);
    assert.equal(fallback.calls.length, 1);
    assert.equal(feed.current(1600, "ETH"), 4_000_000n);
    assert.ok(logs.some((l) => l.includes("fallback: next attempt in 600s")));
    await feed.maybeRefresh(1900);
    assert.equal(fallback.calls.length, 2);
  });

  it("stops quoting once every source stays down past the max age", async () => {
    const down = new Error("HTTP 403");
    const primary = scripted("primary", 0, [QUOTES, down, down, down, down, down, down, down]);
    const fallback = scripted("fallback", 900, [down, down, down]);
    const feed = feedWith([primary, fallback]);
    await feed.maybeRefresh(1000);
    for (let t = 1300; t <= 2800; t += 300) await feed.maybeRefresh(t);
    assert.equal(feed.current(2800, "ETH"), 4_000_000n);
    assert.equal(feed.current(2801, "ETH"), null);
  });

  it("ages a mid from the older upstream timestamp", async () => {
    const primary = scripted("primary", 0, [
      { qrl: { usd: 0.5, atS: 900 }, assets: { ETH: { usd: 2000, atS: 950 } } },
    ]);
    const feed = feedWith([primary]);
    await feed.maybeRefresh(1000);
    assert.equal(feed.current(2700, "ETH"), 4_000_000n);
    assert.equal(feed.current(2701, "ETH"), null);
  });

  it("rejects a quote already older than the max age", async () => {
    const primary = scripted("primary", 0, [
      { qrl: { usd: 0.5, atS: 100 }, assets: { ETH: { usd: 2000 } } },
    ]);
    const fallback = scripted("fallback", 0, [QUOTES]);
    const feed = feedWith([primary, fallback]);
    await feed.maybeRefresh(2000);
    assert.equal(fallback.calls.length, 1);
    assert.equal(feed.current(2000, "ETH"), 4_000_000n);
  });

  it("names the assets a partly usable primary left to the fallback", async () => {
    const logs: string[] = [];
    const primary = scripted("primary", 0, [
      { qrl: { usd: 0.5 }, assets: { ETH: { usd: 2000 }, USDC: { usd: Number.NaN } } },
    ]);
    const fallback = scripted("fallback", 900, [{ qrl: { usd: 0.5 }, assets: { USDC: { usd: 1 } } }]);
    const feed = feedWith([primary, fallback], logs);
    await feed.maybeRefresh(1000);
    assert.ok(logs.some((l) => l.includes("USDC from fallback (primary: USDC unusable)")));
  });

  it("reports a stale quote with its age", async () => {
    const logs: string[] = [];
    const primary = scripted("primary", 0, [
      { qrl: { usd: 0.5, atS: 100 }, assets: { ETH: { usd: 2000 }, USDC: { usd: 1 } } },
    ]);
    const feed = feedWith([primary], logs);
    await feed.maybeRefresh(2000);
    assert.ok(logs.some((l) => l.includes("primary: ETH stale (1900s old), USDC stale (1900s old)")));
  });

  it("never replaces a cached mid with an older quote", async () => {
    const logs: string[] = [];
    const primary = scripted("primary", 0, [
      { qrl: { usd: 0.5, atS: 1000 }, assets: { ETH: { usd: 2000, atS: 1000 }, USDC: { usd: 1 } } },
      new Error("HTTP 403"),
    ]);
    const fallback = scripted("fallback", 0, [
      { qrl: { usd: 0.5, atS: 900 }, assets: { ETH: { usd: 2100, atS: 900 }, USDC: { usd: 1 } } },
    ]);
    const feed = feedWith([primary, fallback], logs);
    await feed.maybeRefresh(1000);
    await feed.maybeRefresh(1300);
    assert.equal(feed.current(1300, "ETH"), 4_000_000n);
    assert.ok(logs.some((l) => l.includes("fallback: ETH older than cache, USDC older than cache")));
    assert.ok(!logs.some((l) => l.includes("mid moved")));
  });

  it("splits one refresh deadline across the sources", async () => {
    const primary = scripted("primary", 0, [new Error("timeout")]);
    const fallback = scripted("fallback", 900, [QUOTES]);
    const feed = feedWith([primary, fallback]);
    await feed.maybeRefresh(1000);
    assert.deepEqual([...primary.timeouts, ...fallback.timeouts], [500, 500]);
  });

  it("keeps pricing a feed-backed asset whether or not it is stocked", async () => {
    const primary = scripted("primary", 0, [QUOTES]);
    const feed = feedWith([primary]);
    await feed.maybeRefresh(1000);
    assert.deepEqual(primary.calls, [["ETH", "USDC"]]);
  });

  it("never fetches in static mode", async () => {
    const primary = scripted("primary", 0, [QUOTES]);
    const feed = new PriceFeed({
      sources: [primary],
      refreshS: 300,
      maxAgeS: 1800,
      staticMilli: 1_700_000n,
      timeoutMs: 1000,
      log: () => undefined,
    });
    await feed.maybeRefresh(1000);
    assert.equal(primary.calls.length, 0);
  });
});

function fakeFetch(routes: Record<string, { status: number; body: unknown }>): FetchFn & {
  urls: string[];
} {
  const urls: string[] = [];
  const fn = (url: string): Promise<Response> => {
    urls.push(url);
    const route = routes[url];
    if (route === undefined) return Promise.reject(new Error(`unexpected ${url}`));
    return Promise.resolve(new Response(JSON.stringify(route.body), { status: route.status }));
  };
  return Object.assign(fn, { urls });
}

const paprika = (id: string): string => `${COINPAPRIKA_TICKER_URL}${id}?quotes=USD`;
const ticker = (price: number, lastUpdated = "2026-09-29T07:57:13Z"): unknown => ({
  last_updated: lastUpdated,
  quotes: { USD: { price } },
});

describe("coingeckoSource", () => {
  const both = coingeckoUrl(["ethereum", "usd-coin"]);

  it("builds the request from the registry ids plus QRL, with timestamps", () => {
    assert.equal(
      both,
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,quantum-resistant-ledger,usd-coin&vs_currencies=usd&include_last_updated_at=true",
    );
    assert.equal(coingeckoUrl(["ethereum"]).includes("usd-coin"), false);
  });

  it("maps /simple/price by CoinGecko id and keeps upstream timestamps", async () => {
    const fetchFn = fakeFetch({
      [both]: {
        status: 200,
        body: {
          ethereum: { usd: 2000, last_updated_at: 1700 },
          "usd-coin": { usd: 1 },
          "quantum-resistant-ledger": { usd: 0.5, last_updated_at: 1650 },
        },
      },
    });
    const quotes = await coingeckoSource(fetchFn).fetch(["ETH", "USDC"], 1000);
    assert.deepEqual(quotes, {
      qrl: { usd: 0.5, atS: 1650 },
      assets: { ETH: { usd: 2000, atS: 1700 }, USDC: { usd: 1 } },
    });
  });

  it("surfaces an HTTP refusal", async () => {
    const fetchFn = fakeFetch({ [coingeckoUrl(["ethereum"])]: { status: 403, body: {} } });
    await assert.rejects(coingeckoSource(fetchFn).fetch(["ETH"], 1000), /HTTP 403/);
  });
});

describe("coinpaprikaSource", () => {
  const atS = Math.floor(Date.parse("2026-09-29T07:57:13Z") / 1000);

  it("fetches QRL plus each requested asset, with upstream timestamps", async () => {
    const fetchFn = fakeFetch({
      [paprika("qrl-quantum-resistant-ledger")]: { status: 200, body: ticker(0.5) },
      [paprika("eth-ethereum")]: { status: 200, body: ticker(2000) },
      [paprika("usdc-usd-coin")]: { status: 200, body: ticker(1) },
    });
    const quotes = await coinpaprikaSource(900, fetchFn).fetch(["ETH", "USDC"], 1000);
    assert.deepEqual(quotes, {
      qrl: { usd: 0.5, atS },
      assets: { ETH: { usd: 2000, atS }, USDC: { usd: 1, atS } },
    });
    assert.equal(fetchFn.urls.length, 3);
  });

  it("skips assets without a feed and costs no request for them", async () => {
    const fetchFn = fakeFetch({
      [paprika("qrl-quantum-resistant-ledger")]: { status: 200, body: ticker(0.5) },
    });
    const quotes = await coinpaprikaSource(900, fetchFn).fetch(["tUSDT"], 1000);
    assert.deepEqual(quotes.assets, {});
    assert.equal(fetchFn.urls.length, 1);
  });

  it("drops one failed asset ticker and keeps the rest", async () => {
    const fetchFn = fakeFetch({
      [paprika("qrl-quantum-resistant-ledger")]: { status: 200, body: ticker(0.5) },
      [paprika("eth-ethereum")]: { status: 429, body: {} },
      [paprika("usdc-usd-coin")]: { status: 200, body: ticker(1) },
    });
    const quotes = await coinpaprikaSource(900, fetchFn).fetch(["ETH", "USDC"], 1000);
    assert.deepEqual(quotes.assets, { USDC: { usd: 1, atS } });
  });

  it("fails when the QRL ticker fails or is malformed, without asset calls", async () => {
    const down = fakeFetch({
      [paprika("qrl-quantum-resistant-ledger")]: { status: 429, body: {} },
      [paprika("eth-ethereum")]: { status: 200, body: ticker(2000) },
    });
    await assert.rejects(coinpaprikaSource(900, down).fetch(["ETH"], 1000), /HTTP 429/);
    assert.deepEqual(down.urls, [paprika("qrl-quantum-resistant-ledger")]);
    const malformed = fakeFetch({
      [paprika("qrl-quantum-resistant-ledger")]: { status: 200, body: ticker(0.5, "not a date") },
      [paprika("eth-ethereum")]: { status: 200, body: ticker(2000) },
    });
    await assert.rejects(coinpaprikaSource(900, malformed).fetch(["ETH"], 1000), /malformed ticker/);
  });
});
