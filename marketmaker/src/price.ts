// Live mids for the QRL pairs, derived from USD quotes (the pairs
// themselves trade nowhere). One CoinGecko fetch covers every feed-backed
// asset; each pair keeps its own cache and staleness clock. Fail-safe
// posture: never quote blind. Before the first successful fetch, and once
// a pair's cache exceeds its staleness bound, current() returns null for
// that pair and the maker simply stops posting it; in-flight swaps are
// untouched (their amounts were fixed at listing).

import { ASSETS, ASSET_SYMBOLS, type AssetSymbol } from "./assets.js";

export const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,usd-coin,quantum-resistant-ledger&vs_currencies=usd";

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

type FeedShape = Record<string, { usd?: number } | undefined>;

export class PriceFeed {
  private readonly mids = new Map<AssetSymbol, { milli: bigint; atS: number }>();
  private lastFetchAtS = 0;

  constructor(
    private readonly opts: {
      url: string;
      refreshS: number;
      maxAgeS: number;
      /** Non-null pins the ETH pair's mid and disables fetching entirely;
       *  token pairs then never quote (there is no static mid for them). */
      staticMilli: bigint | null;
      /** Hard deadline on the price fetch. */
      timeoutMs: number;
      log: (...args: unknown[]) => void;
    },
  ) {}

  /** Fetch if the refresh interval elapsed; errors keep the caches. Each
   *  feed-backed asset updates independently, so one unusable quote never
   *  blanks the others. */
  async maybeRefresh(nowS: number): Promise<void> {
    if (this.opts.staticMilli !== null) return;
    if (nowS - this.lastFetchAtS < this.opts.refreshS) return;
    this.lastFetchAtS = nowS;
    try {
      const res = await fetch(this.opts.url, {
        headers: { Accept: "application/json", "User-Agent": "quantaswap-marketmaker/0.1" },
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as FeedShape;
      const qrlUsd = body["quantum-resistant-ledger"]?.usd ?? Number.NaN;
      let updated = 0;
      for (const symbol of ASSET_SYMBOLS) {
        const id = ASSETS[symbol].coingeckoId;
        if (id === null) continue;
        const milli = midMilliFromUsd(body[id]?.usd ?? Number.NaN, qrlUsd);
        if (milli === null) continue;
        const prev = this.mids.get(symbol);
        if (prev !== undefined && needsReprice(prev.milli, milli, 100n)) {
          this.opts.log(`${symbol} mid moved ${prev.milli} -> ${milli} milli-QRL/${symbol}`);
        }
        this.mids.set(symbol, { milli, atS: nowS });
        updated += 1;
      }
      if (updated === 0) throw new Error("feed returned unusable quotes");
    } catch (err) {
      this.opts.log(
        `price feed error (existing caches kept):`,
        err instanceof Error ? err.message : err,
      );
    }
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
