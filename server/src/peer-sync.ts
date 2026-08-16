// Pull-based mirror synchronization. Peers are explicit operator
// configuration. Every received protocol event is still verified by the
// supplied apply callback before it enters local state or the relay feed.

import {
  federationEventId,
  parseFederationEvent,
  type FederationEvent,
  type FederationPage,
  type FederationRecord,
} from "./federation.js";

export type FederationApplyResult = "applied" | "deferred" | "rejected";

export type FederationEventApplier = (
  event: FederationEvent,
  peer: string,
) => Promise<FederationApplyResult | void> | FederationApplyResult | void;

interface PeerSyncOptions {
  peers: string[];
  timeoutMs: number;
  apply: FederationEventApplier;
  onError?: (peer: string, error: unknown) => void;
}

const CURSOR_RE = /^[0-9a-f]{32}:[0-9]+$/;
const MAX_PAGES_PER_SYNC = 16;
const MAX_SNAPSHOT_EVENTS = 6144;
const MAX_PEER_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_DEFERRED_EVENTS = 4096;
const MAX_DEFERRED_EVENTS_PER_PEER = 512;
const MAX_DEFERRED_PASSES = 8;
const MAX_DEFERRED_AGE_MS = 60 * 60 * 1000;
const MAX_DEFERRED_ATTEMPTS = 512;
const MAX_DEFERRED_BACKOFF_MS = 60 * 1000;
const PEER_BACKOFF_BASE_MS = 10 * 1000;
const MAX_PEER_BACKOFF_MS = 5 * 60 * 1000;

interface PeerSyncResult {
  feedId: string | null;
  reset: boolean;
  forcedReset: boolean;
}

interface PeerHealth {
  failures: number;
  resetStreak: number;
  nextSyncAt: number;
  lastFeedId?: string;
}

function peerBackoffMs(streak: number): number {
  return Math.min(
    MAX_PEER_BACKOFF_MS,
    PEER_BACKOFF_BASE_MS * 2 ** Math.min(Math.max(streak - 1, 0), 5),
  );
}

export async function readFederationJson(
  response: Response,
  maxBytes = MAX_PEER_RESPONSE_BYTES,
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("federation response byte limit is invalid");
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new Error("federation peer returned a non-JSON response");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > maxBytes) {
      throw new Error("federation peer response exceeds the size limit");
    }
  }
  if (response.body === null) throw new Error("federation peer returned an empty response");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("federation peer response exceeds the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
  } catch {
    throw new Error("federation peer returned invalid JSON");
  }
}

function parseRecord(raw: unknown, label: string): FederationRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${label} must be an object`);
  }
  const row = raw as Record<string, unknown>;
  const seq = row["seq"];
  const eventId = row["eventId"];
  const event = row["event"];
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
    throw new Error(`${label} has an invalid sequence`);
  }
  if (typeof eventId !== "string" || !/^[0-9a-f]{64}$/.test(eventId)) {
    throw new Error(`${label} has an invalid event id`);
  }
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    throw new Error(`${label} has an invalid event`);
  }
  const parsed = parseFederationEvent(event, label);
  if (federationEventId(parsed) !== eventId) {
    throw new Error(`${label} content hash does not match`);
  }
  return { seq, eventId, event: parsed };
}

export function parseFederationPage(raw: unknown): FederationPage {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("federation peer returned an invalid page");
  }
  const row = raw as Record<string, unknown>;
  if (typeof row["reset"] !== "boolean") {
    throw new Error("federation peer returned an invalid reset flag");
  }
  if (typeof row["cursor"] !== "string" || !CURSOR_RE.test(row["cursor"])) {
    throw new Error("federation peer returned an invalid cursor");
  }
  if (typeof row["hasMore"] !== "boolean") {
    throw new Error("federation peer returned an invalid continuation flag");
  }
  if (!Array.isArray(row["events"]) || row["events"].length > 256) {
    throw new Error("federation peer returned an invalid event batch");
  }
  const events = row["events"].map((entry, index) =>
    parseRecord(entry, `federation event ${index}`),
  );
  let snapshot: FederationRecord[] | undefined;
  if (row["snapshot"] !== undefined) {
    if (!Array.isArray(row["snapshot"]) || row["snapshot"].length > MAX_SNAPSHOT_EVENTS) {
      throw new Error("federation peer returned an invalid snapshot");
    }
    snapshot = row["snapshot"].map((entry, index) =>
      parseRecord(entry, `federation snapshot event ${index}`),
    );
  }
  if (row["reset"] && snapshot === undefined) {
    throw new Error("federation peer reset omitted its snapshot");
  }
  if (!row["reset"] && snapshot !== undefined) {
    throw new Error("federation peer sent a snapshot without a reset");
  }
  return {
    reset: row["reset"],
    cursor: row["cursor"],
    hasMore: row["hasMore"],
    events,
    ...(snapshot === undefined ? {} : { snapshot }),
  };
}

export class FederationPeerSync {
  private readonly cursors = new Map<string, string>();
  private readonly deferred = new Map<
    string,
    {
      event: FederationEvent;
      peer: string;
      sources: Set<string>;
      firstSeenAt: number;
      nextAttemptAt: number;
      attempts: number;
    }
  >();
  private readonly forceResetPeers = new Set<string>();
  private readonly peerHealth = new Map<string, PeerHealth>();
  private running = false;

  constructor(private readonly options: PeerSyncOptions) {}

  async syncAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await Promise.all(
        this.options.peers.map(async (peer) => {
          const health = this.healthFor(peer);
          if (health.nextSyncAt > Date.now()) return;
          try {
            const result = await this.syncPeer(peer);
            health.failures = 0;
            const repeatedReset =
              result.forcedReset ||
              (result.reset && health.lastFeedId !== undefined);
            if (repeatedReset) {
              health.resetStreak += 1;
              health.nextSyncAt = Date.now() + peerBackoffMs(health.resetStreak);
            } else if (!result.reset) {
              health.resetStreak = 0;
              health.nextSyncAt = 0;
            }
            if (result.feedId !== null) health.lastFeedId = result.feedId;
          } catch (error) {
            health.failures += 1;
            health.nextSyncAt = Date.now() + peerBackoffMs(health.failures);
            this.options.onError?.(peer, error);
          }
        }),
      );
      await this.retryDeferred();
    } finally {
      this.running = false;
    }
  }

  private healthFor(peer: string): PeerHealth {
    const existing = this.peerHealth.get(peer);
    if (existing !== undefined) return existing;
    const created: PeerHealth = {
      failures: 0,
      resetStreak: 0,
      nextSyncAt: 0,
    };
    this.peerHealth.set(peer, created);
    return created;
  }

  private async syncPeer(peer: string): Promise<PeerSyncResult> {
    let cursor = this.cursors.get(peer) ?? null;
    let feedId = cursor?.split(":", 1)[0] ?? null;
    let reset = false;
    for (let pageNumber = 0; pageNumber < MAX_PAGES_PER_SYNC; pageNumber += 1) {
      const query = new URLSearchParams({ limit: "256" });
      if (cursor !== null) query.set("cursor", cursor);
      const response = await fetch(`${peer}/federation/v1/events?${query}`, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`federation peer request failed with HTTP ${response.status}`);
      }
      const page = parseFederationPage(await readFederationJson(response));
      reset ||= page.reset;
      feedId = page.cursor.split(":", 1)[0] ?? null;
      const records = page.reset ? (page.snapshot ?? []) : page.events;
      for (const record of records) await this.applyRecord(record, peer);
      if (this.forceResetPeers.delete(peer)) {
        this.cursors.delete(peer);
        return { feedId, reset, forcedReset: true };
      }
      cursor = page.cursor;
      this.cursors.set(peer, cursor);
      if (!page.hasMore) return { feedId, reset, forcedReset: false };
    }
    throw new Error("federation peer exceeded the per-sync page limit");
  }

  private async applyRecord(record: FederationRecord, peer: string): Promise<void> {
    if (this.forceResetPeers.has(peer)) return;
    const result = await this.options.apply(record.event, peer);
    if (result !== "deferred") {
      this.deferred.delete(record.eventId);
      return;
    }
    const existing = this.deferred.get(record.eventId);
    if (existing !== undefined) {
      if (
        !existing.sources.has(peer) &&
        this.deferredCountForPeer(peer) >= MAX_DEFERRED_EVENTS_PER_PEER
      ) {
        this.resetDeferredPeer(
          peer,
          "federation peer reached its deferred-event quota; peer cursor reset",
        );
        return;
      }
      existing.sources.add(peer);
      return;
    }
    const peerDeferred = this.deferredCountForPeer(peer);
    if (peerDeferred >= MAX_DEFERRED_EVENTS_PER_PEER) {
      this.resetDeferredPeer(
        peer,
        "federation peer reached its deferred-event quota; peer cursor reset",
      );
      return;
    }
    if (this.deferred.size >= MAX_DEFERRED_EVENTS) {
      this.resetDeferredPeer(
        peer,
        "federation deferred-event queue reached its global bound; peer cursor reset",
      );
      return;
    }
    const now = Date.now();
    this.deferred.set(record.eventId, {
      event: record.event,
      peer,
      sources: new Set([peer]),
      firstSeenAt: now,
      nextAttemptAt: now,
      attempts: 0,
    });
  }

  private deferredCountForPeer(peer: string): number {
    let count = 0;
    for (const deferred of this.deferred.values()) {
      if (deferred.sources.has(peer)) count += 1;
    }
    return count;
  }

  private resetDeferredPeer(peer: string, reason: string): void {
    for (const [eventId, deferred] of this.deferred) {
      deferred.sources.delete(peer);
      if (deferred.sources.size === 0) {
        this.deferred.delete(eventId);
      } else if (deferred.peer === peer) {
        deferred.peer = deferred.sources.values().next().value as string;
      }
    }
    this.forceResetPeers.add(peer);
    this.cursors.delete(peer);
    this.options.onError?.(peer, new Error(reason));
  }

  private async retryDeferred(): Promise<void> {
    for (let pass = 0; pass < MAX_DEFERRED_PASSES; pass += 1) {
      let applied = 0;
      for (const [eventId, deferred] of [...this.deferred]) {
        const now = Date.now();
        if (
          now - deferred.firstSeenAt >= MAX_DEFERRED_AGE_MS ||
          deferred.attempts >= MAX_DEFERRED_ATTEMPTS
        ) {
          this.deferred.delete(eventId);
          for (const peer of deferred.sources) {
            this.cursors.delete(peer);
            this.options.onError?.(
              peer,
              new Error("federation deferred event expired; peer cursor reset"),
            );
          }
          continue;
        }
        if (deferred.nextAttemptAt > now) continue;
        deferred.attempts += 1;
        try {
          const result = await this.options.apply(deferred.event, deferred.peer);
          if (result === "deferred") {
            deferred.nextAttemptAt =
              now +
              Math.min(
                MAX_DEFERRED_BACKOFF_MS,
                250 * 2 ** Math.min(deferred.attempts, 8),
              );
            continue;
          }
          this.deferred.delete(eventId);
          if (result !== "rejected") applied += 1;
        } catch (error) {
          deferred.nextAttemptAt = now + MAX_DEFERRED_BACKOFF_MS;
          this.options.onError?.(deferred.peer, error);
        }
      }
      if (applied === 0) return;
    }
  }
}
