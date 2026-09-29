// Live mids for the QRL pairs, derived from USD quotes (the pairs
// themselves trade nowhere). Sources are tried in order: CoinGecko first,
// then CoinPaprika for whatever the earlier sources left unpriced. Each
// pair keeps its own cache and staleness clock. Fail-safe posture: never
// quote blind. Before the first successful fetch, and once a pair's cache
// exceeds its staleness bound, current() returns null for that pair and
// the maker simply stops posting it; in-flight swaps are untouched (their
// amounts were fixed at listing).

import { ASSETS, type AssetSymbol, type PriceIds } from "./assets.js";

export const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,usd-coin,quantum-resistant-ledger&vs_currencies=usd";

export const COINPAPRIKA_TICKER_URL = "https://api.coinpaprika.com/v1/tickers/";
const COINPAPRIKA_QRL_ID = "qrl-quantum-resistant-ledger";

const USER_AGENT = "quantaswap-marketmaker/0.1";

/** QRL per one whole unit of the base asset, in integer milli, or null
 *  for garbage inputs. */
export function midMilliFromUsd(baseUsd: number, qrlUsd: number): bigint | null {
  if (!Number.isFinite(baseUsd) || !Number.isFinite(qrlUsd) || baseUsd <= 0 || qrlUsd <= 0) {
    return null;
  }
  const milli = Math.round((baseUsd / qrlUsd) * 1000);
  return milli > 0 ? BigInt(milli) : null;
}

/** Has the mid drifted beyond `thresholdBps` from what an order was
 *  quoted at? Drives cancel-and-repost of open listings. */
export function needsReprice(
  quotedMilli: bigint,
  currentMilli: bigint,
  thresholdBps: bigint,
): boolean {
  const diff = quotedMilli > currentMilli ? quotedMilli - currentMilli : currentMilli - quotedMilli;
  return diff * 10_000n > currentMilli * thresholdBps;
}

/** One USD quote; `atS` is the upstream timestamp when the source has one. */
export interface UsdQuote {
  usd: number;
  atS?: number;
}

/** What one source returned: the QRL quote plus whichever requested
 *  assets it could price. */
export interface UsdQuotes {
  qrl: UsdQuote;
  assets: Partial<Record<AssetSymbol, UsdQuote>>;
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface PriceSource {
  name: string;
  /** Minimum seconds between two attempts at this source. */
  minIntervalS: number;
  /** Throws when the QRL quote is unusable (no pair can be priced then). */
  fetch(symbols: readonly AssetSymbol[], timeoutMs: number): Promise<UsdQuotes>;
}

async function getJson(fetchFn: FetchFn, url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetchFn(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function priceIdsOf(symbol: AssetSymbol): PriceIds | null {
  return ASSETS[symbol].priceIds;
}

/** One request covers every asset: /simple/price keyed by CoinGecko id. */
export function coingeckoSource(fetchFn: FetchFn = fetch): PriceSource {
  return {
    name: "coingecko",
    minIntervalS: 0,
    async fetch(symbols, timeoutMs) {
      const body = await getJson(fetchFn, COINGECKO_URL, timeoutMs);
      const usdOf = (id: string): number => {
        const entry = isRecord(body) ? body[id] : undefined;
        const usd = isRecord(entry) ? entry["usd"] : undefined;
        return typeof usd === "number" ? usd : Number.NaN;
      };
      const quotes: UsdQuotes = { qrl: { usd: usdOf("quantum-resistant-ledger") }, assets: {} };
      for (const symbol of symbols) {
        const ids = priceIdsOf(symbol);
        if (ids !== null) quotes.assets[symbol] = { usd: usdOf(ids.coingecko) };
      }
      return quotes;
    },
  };
}

/** One /v1/tickers/<id> request per coin (QRL plus each requested asset),
 *  so the keyless monthly budget (20,000 calls per IP) caps how often this
 *  source may run: keep `minIntervalS` at 900 or more. */
export function coinpaprikaSource(minIntervalS: number, fetchFn: FetchFn = fetch): PriceSource {
  const ticker = async (id: string, timeoutMs: number): Promise<UsdQuote> => {
    const body = await getJson(fetchFn, `${COINPAPRIKA_TICKER_URL}${id}?quotes=USD`, timeoutMs);
    const quotes = isRecord(body) ? body["quotes"] : undefined;
    const usdQuote = isRecord(quotes) ? quotes["USD"] : undefined;
    const price = isRecord(usdQuote) ? usdQuote["price"] : undefined;
    const updated = isRecord(body) ? body["last_updated"] : undefined;
    const atMs = typeof updated === "string" ? Date.parse(updated) : Number.NaN;
    if (typeof price !== "number" || !Number.isFinite(atMs)) {
      throw new Error(`${id}: malformed ticker`);
    }
    return { usd: price, atS: Math.floor(atMs / 1000) };
  };
  return {
    name: "coinpaprika",
    minIntervalS,
    async fetch(symbols, timeoutMs) {
      const priced = symbols.flatMap((symbol) => {
        const ids = priceIdsOf(symbol);
        return ids === null ? [] : [{ symbol, id: ids.coinpaprika }];
      });
      const [qrl, ...rest] = await Promise.allSettled([
        ticker(COINPAPRIKA_QRL_ID, timeoutMs),
        ...priced.map((p) => ticker(p.id, timeoutMs)),
      ]);
      if (qrl.status === "rejected") {
        throw qrl.reason instanceof Error ? qrl.reason : new Error("QRL ticker failed");
      }
      const quotes: UsdQuotes = { qrl: qrl.value, assets: {} };
      priced.forEach((p, i) => {
        const result = rest[i];
        if (result?.status === "fulfilled") quotes.assets[p.symbol] = result.value;
      });
      return quotes;
    },
  };
}

export class PriceFeed {
  private readonly mids = new Map<AssetSymbol, { milli: bigint; atS: number }>();
  private readonly lastAttemptAtS = new Map<string, number>();
  private lastFetchAtS = 0;

  constructor(
    private readonly opts: {
      /** The stocked assets; only these are fetched and cached. */
      assets: readonly AssetSymbol[];
      /** Tried in order; a later source only sees what earlier ones missed. */
      sources: readonly PriceSource[];
      refreshS: number;
      maxAgeS: number;
      /** Non-null pins the ETH pair's mid and disables fetching entirely;
       *  token pairs then never quote (there is no static mid for them). */
      staticMilli: bigint | null;
      /** Hard deadline on each price request. */
      timeoutMs: number;
      log: (...args: unknown[]) => void;
    },
  ) {}

  /** Fetch if the refresh interval elapsed; errors keep the caches. Each
   *  feed-backed asset updates independently, so one unusable quote never
   *  blanks the others, and a failed source hands its assets to the next. */
  async maybeRefresh(nowS: number): Promise<void> {
    if (this.opts.staticMilli !== null) return;
    if (nowS - this.lastFetchAtS < this.opts.refreshS) return;
    this.lastFetchAtS = nowS;
    const pending = new Set(this.opts.assets.filter((s) => priceIdsOf(s) !== null));
    const errors: string[] = [];
    for (const source of this.opts.sources) {
      if (pending.size === 0) break;
      const lastAttemptS = this.lastAttemptAtS.get(source.name);
      if (lastAttemptS !== undefined && nowS - lastAttemptS < source.minIntervalS) {
        errors.push(`${source.name}: next attempt in ${source.minIntervalS - (nowS - lastAttemptS)}s`);
        continue;
      }
      this.lastAttemptAtS.set(source.name, nowS);
      try {
        const quotes = await source.fetch([...pending], this.opts.timeoutMs);
        const priced = this.apply(nowS, quotes, pending);
        if (priced.length === 0) throw new Error("unusable quotes");
        if (source !== this.opts.sources[0]) {
          this.opts.log(`price feed: ${priced.join(",")} from ${source.name} (${errors.join("; ")})`);
        }
      } catch (err) {
        errors.push(`${source.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (pending.size > 0) {
      this.opts.log(
        `price feed error (existing caches kept) for ${[...pending].join(",")}:`,
        errors.join("; "),
      );
    }
  }

  /** Cache every usable pending mid; returns the symbols it priced. The
   *  cache age runs from the older upstream timestamp of the two legs, so
   *  a source serving stale data cannot extend the staleness bound. */
  private apply(nowS: number, quotes: UsdQuotes, pending: Set<AssetSymbol>): AssetSymbol[] {
    const priced: AssetSymbol[] = [];
    for (const symbol of pending) {
      const quote = quotes.assets[symbol];
      if (quote === undefined) continue;
      const milli = midMilliFromUsd(quote.usd, quotes.qrl.usd);
      if (milli === null) continue;
      const atS = Math.min(nowS, quotes.qrl.atS ?? nowS, quote.atS ?? nowS);
      if (nowS - atS > this.opts.maxAgeS) continue;
      const prev = this.mids.get(symbol);
      if (prev !== undefined && needsReprice(prev.milli, milli, 100n)) {
        this.opts.log(`${symbol} mid moved ${prev.milli} -> ${milli} milli-QRL/${symbol}`);
      }
      this.mids.set(symbol, { milli, atS });
      priced.push(symbol);
    }
    for (const symbol of priced) pending.delete(symbol);
    return priced;
  }

  /** The mid to quote `asset` at (milli-QRL per whole unit), or null when
   *  quoting that pair must pause. */
  current(nowS: number, asset: AssetSymbol): bigint | null {
    if (this.opts.staticMilli !== null) return asset === "ETH" ? this.opts.staticMilli : null;
    const cached = this.mids.get(asset);
    if (cached === undefined || nowS - cached.atS > this.opts.maxAgeS) return null;
    return cached.milli;
  }
}
