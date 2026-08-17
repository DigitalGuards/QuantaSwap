import { timingSafeEqual } from "node:crypto";

export interface FederationResetLimiterOptions {
  perSourceLimit?: number;
  globalLimit?: number;
  windowMs?: number;
}

export interface FederationConcurrencyLimiterOptions {
  perSourceLimit?: number;
  globalLimit?: number;
}

export interface FederationResponseCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  ttlMs?: number;
}

const DEFAULT_PER_SOURCE_LIMIT = 4;
const DEFAULT_GLOBAL_LIMIT = 64;
const DEFAULT_WINDOW_MS = 60_000;
const FEDERATION_TOKEN_RE = /^[0-9a-f]{64}$/;

export function federationBearerAuthorized(
  authorization: string | string[] | undefined,
  expectedToken: string | null,
): boolean {
  if (
    expectedToken === null ||
    !FEDERATION_TOKEN_RE.test(expectedToken) ||
    typeof authorization !== "string"
  ) {
    return false;
  }
  const match = /^Bearer ([0-9a-f]{64})$/.exec(authorization);
  if (match === null) return false;
  const supplied = Buffer.from(match[1] ?? "", "hex");
  const expected = Buffer.from(expectedToken, "hex");
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

export function federationResponseCacheKey(
  reset: boolean,
  cursor: string | null,
  limit: number,
  oldestSequence: number | null,
  latestSequence: number | null,
): string {
  return [
    reset ? "reset:all" : `incremental:${cursor ?? "initial"}:${limit}`,
    String(oldestSequence ?? 0),
    String(latestSequence ?? 0),
  ].join(":");
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

/**
 * Fixed-window limiter for reset snapshots. Only accepted sources are stored,
 * so the map cannot grow beyond the global allowance within one window.
 */
export class FederationResetLimiter {
  private readonly perSourceLimit: number;
  private readonly globalLimit: number;
  private readonly windowMs: number;
  private window = -1;
  private globalCount = 0;
  private readonly sourceCounts = new Map<string, number>();

  constructor(options: FederationResetLimiterOptions = {}) {
    this.perSourceLimit = positiveInteger(
      options.perSourceLimit ?? DEFAULT_PER_SOURCE_LIMIT,
      "federation per-source reset limit",
    );
    this.globalLimit = positiveInteger(
      options.globalLimit ?? DEFAULT_GLOBAL_LIMIT,
      "federation global reset limit",
    );
    this.windowMs = positiveInteger(
      options.windowMs ?? DEFAULT_WINDOW_MS,
      "federation reset window",
    );
  }

  allow(source: string, now = Date.now()): boolean {
    if (source.length < 1 || source.length > 256) {
      throw new Error("federation reset source is invalid");
    }
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("federation reset time is invalid");
    }

    const window = Math.floor(now / this.windowMs);
    if (window > this.window) {
      this.window = window;
      this.globalCount = 0;
      this.sourceCounts.clear();
    }

    if (this.globalCount >= this.globalLimit) return false;
    const sourceCount = this.sourceCounts.get(source) ?? 0;
    if (sourceCount >= this.perSourceLimit) return false;

    this.globalCount += 1;
    this.sourceCounts.set(source, sourceCount + 1);
    return true;
  }
}

export class FederationConcurrencyLimiter {
  private readonly perSourceLimit: number;
  private readonly globalLimit: number;
  private globalCount = 0;
  private readonly sourceCounts = new Map<string, number>();

  constructor(options: FederationConcurrencyLimiterOptions = {}) {
    this.perSourceLimit = positiveInteger(
      options.perSourceLimit ?? 1,
      "federation per-source concurrency limit",
    );
    this.globalLimit = positiveInteger(
      options.globalLimit ?? 2,
      "federation global concurrency limit",
    );
  }

  acquire(source: string): (() => void) | null {
    if (source.length < 1 || source.length > 256) {
      throw new Error("federation concurrency source is invalid");
    }
    const sourceCount = this.sourceCounts.get(source) ?? 0;
    if (sourceCount >= this.perSourceLimit || this.globalCount >= this.globalLimit) {
      return null;
    }
    this.globalCount += 1;
    this.sourceCounts.set(source, sourceCount + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.globalCount -= 1;
      const remaining = (this.sourceCounts.get(source) ?? 1) - 1;
      if (remaining === 0) this.sourceCounts.delete(source);
      else this.sourceCounts.set(source, remaining);
    };
  }
}

interface CachedResponse {
  body: Buffer;
  expiresAt: number;
}

export class FederationResponseCache {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly entries = new Map<string, CachedResponse>();
  private retainedBytes = 0;
  private lastNow = -1;

  constructor(options: FederationResponseCacheOptions = {}) {
    this.maxEntries = positiveInteger(
      options.maxEntries ?? 128,
      "federation response cache entry limit",
    );
    this.maxBytes = positiveInteger(
      options.maxBytes ?? 64 * 1024 * 1024,
      "federation response cache byte limit",
    );
    this.ttlMs = positiveInteger(
      options.ttlMs ?? 5_000,
      "federation response cache lifetime",
    );
  }

  getOrCreate(key: string, create: () => string, now = Date.now()): Buffer {
    if (key.length < 1 || key.length > 512) {
      throw new Error("federation response cache key is invalid");
    }
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("federation response cache time is invalid");
    }
    if (now < this.lastNow) this.clear();
    this.lastNow = Math.max(this.lastNow, now);
    this.prune(now);
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.body;
    }

    const body = Buffer.from(create(), "utf8");
    if (body.byteLength > this.maxBytes) return body;
    while (
      this.entries.size >= this.maxEntries ||
      this.retainedBytes + body.byteLength > this.maxBytes
    ) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.remove(oldestKey);
    }
    this.entries.set(key, { body, expiresAt: now + this.ttlMs });
    this.retainedBytes += body.byteLength;
    return body;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(key);
    }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.retainedBytes -= entry.body.byteLength;
    this.entries.delete(key);
  }

  private clear(): void {
    this.entries.clear();
    this.retainedBytes = 0;
  }
}
