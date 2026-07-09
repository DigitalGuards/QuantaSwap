// Live mid price for the QRL/ETH pair, derived from USD quotes (the pair
// itself trades nowhere). Fail-safe posture: never quote blind. Before
// the first successful fetch, and once the cache exceeds its staleness
// bound, current() returns null and the maker simply stops posting;
// in-flight swaps are untouched (their amounts were fixed at listing).

export const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,quantum-resistant-ledger&vs_currencies=usd";

/** QRL per ETH in integer milli, or null for garbage inputs. */
export function midMilliFromUsd(ethUsd: number, qrlUsd: number): bigint | null {
  if (!Number.isFinite(ethUsd) || !Number.isFinite(qrlUsd) || ethUsd <= 0 || qrlUsd <= 0) {
    return null;
  }
  const milli = Math.round((ethUsd / qrlUsd) * 1000);
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

interface FeedShape {
  ethereum?: { usd?: number };
  "quantum-resistant-ledger"?: { usd?: number };
}

export class PriceFeed {
  private lastMilli: bigint | null = null;
  private lastAtS = 0;
  private lastFetchAtS = 0;

  constructor(
    private readonly opts: {
      url: string;
      refreshS: number;
      maxAgeS: number;
      /** Non-null pins the price and disables fetching entirely. */
      staticMilli: bigint | null;
      log: (...args: unknown[]) => void;
    },
  ) {}

  /** Fetch if the refresh interval elapsed; errors keep the cache. */
  async maybeRefresh(nowS: number): Promise<void> {
    if (this.opts.staticMilli !== null) return;
    if (nowS - this.lastFetchAtS < this.opts.refreshS) return;
    this.lastFetchAtS = nowS;
    try {
      const res = await fetch(this.opts.url, {
        headers: { Accept: "application/json", "User-Agent": "quantaswap-marketmaker/0.1" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as FeedShape;
      const milli = midMilliFromUsd(
        body.ethereum?.usd ?? Number.NaN,
        body["quantum-resistant-ledger"]?.usd ?? Number.NaN,
      );
      if (milli === null) throw new Error("feed returned unusable quotes");
      if (this.lastMilli !== null && needsReprice(this.lastMilli, milli, 100n)) {
        this.opts.log(`mid moved ${this.lastMilli} -> ${milli} milli-QRL/ETH`);
      }
      this.lastMilli = milli;
      this.lastAtS = nowS;
    } catch (err) {
      this.opts.log(
        `price feed error (cache ${this.lastMilli === null ? "empty" : `${nowS - this.lastAtS}s old`}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** The mid to quote at, or null when quoting must pause. */
  current(nowS: number): bigint | null {
    if (this.opts.staticMilli !== null) return this.opts.staticMilli;
    if (this.lastMilli === null || nowS - this.lastAtS > this.opts.maxAgeS) return null;
    return this.lastMilli;
  }
}
