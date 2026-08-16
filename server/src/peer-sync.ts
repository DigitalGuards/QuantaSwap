// Pull-based mirror synchronization. Peers are explicit operator
// configuration. Every received protocol event is still verified by the
// supplied apply callback before it enters local state or the relay feed.

import { performance } from "node:perf_hooks";
import {
  MAX_FEDERATION_RESPONSE_BYTES,
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
  peerIds?: string[];
  peerTokens?: readonly (string | null)[];
  timeoutMs: number;
  staleAfterMs?: number;
  apply: FederationEventApplier;
  onError?: (peer: string, error: unknown) => void;
}

const CURSOR_RE = /^([0-9a-f]{32}):(0|[1-9][0-9]{0,15})$/;
const MAX_PAGES_PER_SYNC = 16;
const MAX_SNAPSHOT_EVENTS = 6144;
const MAX_DEFERRED_EVENTS = 4096;
const MAX_DEFERRED_EVENTS_PER_PEER = 512;
const MAX_DEFERRED_PASSES = 8;
const MAX_DEFERRED_AGE_MS = 60 * 60 * 1000;
const MAX_DEFERRED_ATTEMPTS = 512;
const MAX_DEFERRED_BACKOFF_MS = 60 * 1000;
const PEER_BACKOFF_BASE_MS = 10 * 1000;
const MAX_PEER_BACKOFF_MS = 5 * 60 * 1000;
const MAX_REJECTED_EVENTS_PER_SYNC = 8;
const MAX_CONCURRENT_PEER_SYNCS = 2;
const MAX_CONFIGURED_PEERS = 16;

interface PeerSyncResult {
  feedId: string | null;
  reset: boolean;
  forcedReset: boolean;
  rejectedEvents: number;
}

interface EventApplication {
  peer: string;
  result: Promise<FederationApplyResult>;
}

interface PeerHealth {
  failures: number;
  resetStreak: number;
  nextSyncAt: number;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastFeedId?: string;
}

interface ParsedCursor {
  feedId: string;
  sequence: number;
}

export type FederationPeerState = "pending" | "syncing" | "healthy" | "degraded" | "stale";

export interface FederationPeerStatus {
  id: string;
  state: FederationPeerState;
  consecutiveFailures: number;
  resetStreak: number;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  nextAttemptAt: number | null;
}

export interface FederationSyncStatus {
  enabled: boolean;
  state: "disabled" | "starting" | "healthy" | "degraded";
  running: boolean;
  configuredPeers: number;
  healthyPeers: number;
  deferredEvents: number;
  lastCompletedAt: number | null;
  peers: FederationPeerStatus[];
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} has invalid fields`);
  }
}

function parseCursor(cursor: string, label: string): ParsedCursor {
  const match = CURSOR_RE.exec(cursor);
  const rawSequence = match?.[2];
  if (match === null || rawSequence === undefined) {
    throw new Error(`${label} has an invalid cursor`);
  }
  const sequence = Number(rawSequence);
  if (!Number.isSafeInteger(sequence)) {
    throw new Error(`${label} has an invalid cursor`);
  }
  return { feedId: match[1]!, sequence };
}

function peerBackoffMs(streak: number): number {
  return Math.min(
    MAX_PEER_BACKOFF_MS,
    PEER_BACKOFF_BASE_MS * 2 ** Math.min(Math.max(streak - 1, 0), 5),
  );
}

export async function readFederationJson(
  response: Response,
  maxBytes = MAX_FEDERATION_RESPONSE_BYTES,
): Promise<unknown> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_FEDERATION_RESPONSE_BYTES
  ) {
    throw new Error("federation response byte limit is invalid");
  }
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
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

function parseRecord(
  raw: unknown,
  label: string,
  eventIds: Set<string>,
  collectionLabel: string,
  minimumSequence: 0 | 1,
): FederationRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${label} must be an object`);
  }
  const row = raw as Record<string, unknown>;
  assertExactKeys(row, ["seq", "eventId", "event"], label);
  const seq = row["seq"];
  const eventId = row["eventId"];
  const event = row["event"];
  if (
    typeof seq !== "number" ||
    !Number.isSafeInteger(seq) ||
    seq < minimumSequence
  ) {
    throw new Error(`${label} has an invalid sequence`);
  }
  if (typeof eventId !== "string" || !/^[0-9a-f]{64}$/.test(eventId)) {
    throw new Error(`${label} has an invalid event id`);
  }
  if (eventIds.has(eventId)) {
    throw new Error(`${collectionLabel} contains a duplicate event id`);
  }
  eventIds.add(eventId);
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    throw new Error(`${label} has an invalid event`);
  }
  assertExactKeys(event as Record<string, unknown>, ["kind", "payload"], `${label} event`);
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
  const hasSnapshot = Object.hasOwn(row, "snapshot");
  if (row["reset"] && !hasSnapshot) {
    throw new Error("federation peer reset omitted its snapshot");
  }
  if (!row["reset"] && hasSnapshot) {
    throw new Error("federation peer sent a snapshot without a reset");
  }
  assertExactKeys(
    row,
    row["reset"]
      ? ["reset", "cursor", "hasMore", "events", "snapshot"]
      : ["reset", "cursor", "hasMore", "events"],
    "federation peer page",
  );
  if (typeof row["cursor"] !== "string") {
    throw new Error("federation peer returned an invalid cursor");
  }
  const cursor = parseCursor(row["cursor"], "federation peer");
  if (typeof row["hasMore"] !== "boolean") {
    throw new Error("federation peer returned an invalid continuation flag");
  }
  if (!Array.isArray(row["events"]) || row["events"].length > 256) {
    throw new Error("federation peer returned an invalid event batch");
  }
  if (row["reset"] && row["hasMore"]) {
    throw new Error("federation peer reset cannot continue across pages");
  }
  if (row["reset"] && row["events"].length > 0) {
    throw new Error("federation peer reset cannot include incremental events");
  }
  if (!row["reset"] && row["hasMore"] && row["events"].length === 0) {
    throw new Error("federation peer continuation page cannot be empty");
  }
  const eventIds = new Set<string>();
  const events = row["events"].map((entry, index) =>
    parseRecord(
      entry,
      `federation event ${index}`,
      eventIds,
      "federation event batch",
      1,
    ),
  );
  let snapshot: FederationRecord[] | undefined;
  if (hasSnapshot) {
    if (!Array.isArray(row["snapshot"]) || row["snapshot"].length > MAX_SNAPSHOT_EVENTS) {
      throw new Error("federation peer returned an invalid snapshot");
    }
    const snapshotEventIds = new Set<string>();
    snapshot = row["snapshot"].map((entry, index) =>
      parseRecord(
        entry,
        `federation snapshot event ${index}`,
        snapshotEventIds,
        "federation snapshot",
        0,
      ),
    );
  }
  if (!row["reset"]) {
    for (let index = 1; index < events.length; index += 1) {
      if (events[index]?.seq !== (events[index - 1]?.seq ?? -1) + 1) {
        throw new Error("federation peer event sequences are not contiguous");
      }
    }
    const lastSequence = events.at(-1)?.seq;
    if (lastSequence !== undefined && cursor.sequence !== lastSequence) {
      throw new Error("federation peer cursor does not match its event batch");
    }
  } else {
    if (snapshot?.some((entry) => entry.seq !== cursor.sequence)) {
      throw new Error("federation peer snapshot sequence does not match its cursor");
    }
  }
  return {
    reset: row["reset"],
    cursor: row["cursor"],
    hasMore: row["hasMore"],
    events,
    ...(snapshot === undefined ? {} : { snapshot }),
  };
}

export function validateFederationPageProgress(
  requestedCursor: string | null,
  page: FederationPage,
): void {
  if (page.reset) return;
  if (requestedCursor === null) {
    throw new Error("federation peer omitted the required initial reset");
  }
  const requested = parseCursor(requestedCursor, "requested federation cursor");
  const returned = parseCursor(page.cursor, "returned federation cursor");
  if (requested.feedId !== returned.feedId) {
    throw new Error("federation peer changed feed id without a reset");
  }
  if (page.events.length === 0) {
    if (returned.sequence !== requested.sequence || page.hasMore) {
      throw new Error("federation peer returned a nonadvancing empty page");
    }
    return;
  }
  if (
    requested.sequence === Number.MAX_SAFE_INTEGER ||
    page.events[0]?.seq !== requested.sequence + 1
  ) {
    throw new Error("federation peer event batch does not continue its cursor");
  }
  if (returned.sequence <= requested.sequence) {
    throw new Error("federation peer cursor did not advance");
  }
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
  private readonly activePeers = new Set<string>();
  private readonly peerIds: string[];
  private readonly peerTokens: readonly (string | null)[];
  private readonly staleAfterMs: number;
  private running = false;
  private lastCompletedAt: number | null = null;

  constructor(private readonly options: PeerSyncOptions) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new Error("federation peer timeout is invalid");
    }
    if (options.peers.length > MAX_CONFIGURED_PEERS) {
      throw new Error("federation peer count exceeds the configured limit");
    }
    if (new Set(options.peers).size !== options.peers.length) {
      throw new Error("federation peers contain duplicates");
    }
    this.peerTokens =
      options.peerTokens ?? options.peers.map((): string | null => null);
    if (
      this.peerTokens.length !== options.peers.length ||
      this.peerTokens.some(
        (token) =>
          token !== null &&
          (typeof token !== "string" ||
            token.length > 4096 ||
            !/^[A-Za-z0-9._~+\/-]+=*$/.test(token)),
      )
    ) {
      throw new Error("federation peer tokens are invalid");
    }
    this.peerIds = options.peerIds ?? options.peers.map((_peer, index) => `peer-${index + 1}`);
    if (
      this.peerIds.length !== options.peers.length ||
      new Set(this.peerIds).size !== this.peerIds.length ||
      this.peerIds.some((id) => !/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(id))
    ) {
      throw new Error("federation peer ids are invalid");
    }
    this.staleAfterMs = options.staleAfterMs ?? Math.max(30_000, options.timeoutMs * 3);
    if (!Number.isSafeInteger(this.staleAfterMs) || this.staleAfterMs < 1_000) {
      throw new Error("federation stale threshold is invalid");
    }
  }

  /**
   * Return an operator-facing snapshot without exposing configured peer URLs,
   * feed ids, cursors, response bodies, or validation errors. Peer ids follow
   * the stable order in ORDERBOOK_FEDERATION_PEERS.
   */
  status(now = Date.now()): FederationSyncStatus {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("federation status time is invalid");
    }
    const peers = this.options.peers.map((peer, index): FederationPeerStatus => {
      const health = this.healthFor(peer);
      let state: FederationPeerState;
      if (health.failures > 0 || health.resetStreak > 0) state = "degraded";
      else if (health.lastAttemptAt === undefined) state = "pending";
      else if (
        health.lastSuccessAt !== undefined &&
        now - health.lastSuccessAt > this.staleAfterMs
      ) {
        state = "stale";
      } else if (this.activePeers.has(peer)) state = "syncing";
      else if (health.lastSuccessAt === undefined) state = "pending";
      else state = "healthy";
      return {
        id: this.peerIds[index] ?? `peer-${index + 1}`,
        state,
        consecutiveFailures: health.failures,
        resetStreak: health.resetStreak,
        lastAttemptAt: health.lastAttemptAt ?? null,
        lastSuccessAt: health.lastSuccessAt ?? null,
        nextAttemptAt: health.nextSyncAt > now ? health.nextSyncAt : null,
      };
    });
    const configuredPeers = peers.length;
    const healthyPeers = peers.filter(
      (peer) =>
        peer.state === "healthy" ||
        (peer.state === "syncing" &&
          peer.lastSuccessAt !== null &&
          now - peer.lastSuccessAt <= this.staleAfterMs),
    ).length;
    let state: FederationSyncStatus["state"];
    if (configuredPeers === 0) state = "disabled";
    else if (peers.some((peer) => peer.state === "degraded" || peer.state === "stale")) {
      state = "degraded";
    } else if (peers.some((peer) => peer.lastSuccessAt === null)) state = "starting";
    else state = "healthy";
    return {
      enabled: configuredPeers > 0,
      state,
      running: this.running,
      configuredPeers,
      healthyPeers,
      deferredEvents: this.deferred.size,
      lastCompletedAt: this.lastCompletedAt,
      peers,
    };
  }

  async syncAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const applications = new Map<string, EventApplication>();
      const rejectedThisSync = new Map<string, number>();
      let nextPeerIndex = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const peerIndex = nextPeerIndex;
          nextPeerIndex += 1;
          const peer = this.options.peers[peerIndex];
          if (peer === undefined) return;
          await this.syncConfiguredPeer(peer, applications, rejectedThisSync);
        }
      };
      const workerCount = Math.min(MAX_CONCURRENT_PEER_SYNCS, this.options.peers.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      await this.retryDeferred(rejectedThisSync);
    } finally {
      this.lastCompletedAt = Date.now();
      this.running = false;
    }
  }

  private async syncConfiguredPeer(
    peer: string,
    applications: Map<string, EventApplication>,
    rejectedThisSync: Map<string, number>,
  ): Promise<void> {
    const health = this.healthFor(peer);
    if (health.nextSyncAt > Date.now()) return;
    health.lastAttemptAt = Date.now();
    this.activePeers.add(peer);
    try {
      const result = await this.syncPeer(peer, applications, rejectedThisSync);
      if (result.rejectedEvents === 0) health.failures = 0;
      const repeatedReset =
        result.forcedReset || (result.reset && health.lastFeedId !== undefined);
      if (repeatedReset) {
        health.resetStreak += 1;
        health.nextSyncAt = Date.now() + peerBackoffMs(health.resetStreak);
      } else if (!result.reset) {
        health.resetStreak = 0;
        health.nextSyncAt = 0;
      }
      if (result.rejectedEvents > 0) {
        this.recordRejectedEvents(peer, result.rejectedEvents, "events");
      }
      if (result.feedId !== null) health.lastFeedId = result.feedId;
      health.lastSuccessAt = Date.now();
    } catch (error) {
      health.failures += 1;
      health.nextSyncAt = Date.now() + peerBackoffMs(health.failures);
      this.options.onError?.(peer, error);
    } finally {
      this.activePeers.delete(peer);
    }
  }

  private recordRejectedEvents(peer: string, count: number, label: string): void {
    this.recordPeerIssue(
      peer,
      `federation peer supplied ${count} rejected ${label}`,
    );
  }

  private recordPeerIssue(peer: string, message: string): void {
    const health = this.healthFor(peer);
    health.failures += 1;
    health.nextSyncAt = Math.max(
      health.nextSyncAt,
      Date.now() + peerBackoffMs(health.failures),
    );
    this.options.onError?.(peer, new Error(message));
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

  private async syncPeer(
    peer: string,
    applications: Map<string, EventApplication>,
    rejectedThisSync: Map<string, number>,
  ): Promise<PeerSyncResult> {
    const signal = AbortSignal.timeout(this.options.timeoutMs);
    const deadlineAt = performance.now() + this.options.timeoutMs;
    const assertWithinDeadline = (): void => {
      if (signal.aborted || performance.now() >= deadlineAt) {
        throw new Error("federation peer exceeded the total sync deadline");
      }
    };
    let cursor = this.cursors.get(peer) ?? null;
    const peerIndex = this.options.peers.indexOf(peer);
    const peerToken = this.peerTokens[peerIndex] ?? null;
    let feedId = cursor === null ? null : parseCursor(cursor, "stored federation cursor").feedId;
    let reset = false;
    const seenEventIds = new Set<string>();
    let rejectedEvents = 0;
    for (let pageNumber = 0; pageNumber < MAX_PAGES_PER_SYNC; pageNumber += 1) {
      assertWithinDeadline();
      const requestedCursor = cursor;
      const query = new URLSearchParams({ limit: "256" });
      if (cursor !== null) query.set("cursor", cursor);
      let response: Response;
      try {
        response = await fetch(`${peer}/federation/v1/events?${query}`, {
          headers:
            peerToken === null
              ? { Accept: "application/json" }
              : {
                  Accept: "application/json",
                  Authorization: `Bearer ${peerToken}`,
                },
          redirect: "error",
          signal,
        });
      } catch (error) {
        if (signal.aborted) {
          throw new Error("federation peer exceeded the total sync deadline");
        }
        throw error;
      }
      assertWithinDeadline();
      if (!response.ok) {
        throw new Error(`federation peer request failed with HTTP ${response.status}`);
      }
      const page = parseFederationPage(await readFederationJson(response));
      assertWithinDeadline();
      validateFederationPageProgress(requestedCursor, page);
      if (page.reset && pageNumber > 0) {
        throw new Error("federation peer reset during pagination");
      }
      reset ||= page.reset;
      feedId = parseCursor(page.cursor, "federation peer").feedId;
      const pageRecords = page.reset ? (page.snapshot ?? []) : page.events;
      for (const record of pageRecords) {
        if (seenEventIds.has(record.eventId)) {
          throw new Error("federation peer repeated an event id across pages");
        }
        seenEventIds.add(record.eventId);
      }
      for (const record of pageRecords) {
        assertWithinDeadline();
        if ((await this.applyRecord(record, peer, applications)) === "rejected") {
          rejectedEvents += 1;
          const totalRejected = Math.min(
            (rejectedThisSync.get(peer) ?? 0) + 1,
            MAX_REJECTED_EVENTS_PER_SYNC + 1,
          );
          rejectedThisSync.set(peer, totalRejected);
          if (totalRejected >= MAX_REJECTED_EVENTS_PER_SYNC) {
            throw new Error("federation peer reached the rejected-event quota");
          }
        }
        assertWithinDeadline();
        if (this.forceResetPeers.has(peer)) break;
      }
      if (this.forceResetPeers.delete(peer)) {
        this.cursors.delete(peer);
        return { feedId, reset, forcedReset: true, rejectedEvents };
      }
      assertWithinDeadline();
      cursor = page.cursor;
      this.cursors.set(peer, cursor);
      if (!page.hasMore) {
        return { feedId, reset, forcedReset: false, rejectedEvents };
      }
    }
    throw new Error("federation peer exceeded the per-sync page limit");
  }

  private async applyRecord(
    record: FederationRecord,
    peer: string,
    applications: Map<string, EventApplication>,
  ): Promise<FederationApplyResult> {
    if (this.forceResetPeers.has(peer)) return "deferred";
    const deferred = this.deferred.get(record.eventId);
    if (deferred !== undefined) {
      if (deferred.sources.has(peer)) return "deferred";
      this.deferRecord(record, peer);
      const result = await Promise.resolve(this.options.apply(record.event, peer)).then(
        (value) => value ?? "applied",
      );
      if (result === "deferred") {
        const sources = [...deferred.sources];
        const currentIndex = sources.indexOf(peer);
        deferred.peer = sources[(currentIndex + 1) % sources.length] ?? peer;
        return "deferred";
      }
      if (result === "rejected") {
        for (const source of deferred.sources) {
          if (source !== peer) this.recordRejectedEvents(source, 1, "events");
        }
      }
      this.deferred.delete(record.eventId);
      return result;
    }
    let application = applications.get(record.eventId);
    if (application === undefined) {
      application = {
        peer,
        result: Promise.resolve()
          .then(() => this.options.apply(record.event, peer))
          .then((result) => result ?? "applied"),
      };
      applications.set(record.eventId, application);
    }
    const result = await application.result;
    if (result === "deferred") {
      if (applications.get(record.eventId) === application) {
        applications.delete(record.eventId);
      }
      this.deferRecord(record, application.peer);
      if (application.peer !== peer) {
        return this.applyRecord(record, peer, applications);
      }
      return "deferred";
    }
    return result;
  }

  private deferRecord(record: FederationRecord, peer: string): void {
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

  private async retryDeferred(rejectedThisSync: Map<string, number>): Promise<void> {
    const rejectedByPeer = new Map<string, number>();
    const expiredByPeer = new Map<string, number>();
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
            expiredByPeer.set(peer, (expiredByPeer.get(peer) ?? 0) + 1);
          }
          continue;
        }
        if (deferred.nextAttemptAt > now) continue;
        const eligibleSources = [...deferred.sources].filter(
          (peer) =>
            (rejectedThisSync.get(peer) ?? 0) < MAX_REJECTED_EVENTS_PER_SYNC,
        );
        if (eligibleSources.length === 0) continue;
        if (!eligibleSources.includes(deferred.peer)) {
          deferred.peer = eligibleSources[0]!;
        }
        deferred.attempts += 1;
        try {
          const result = await this.options.apply(deferred.event, deferred.peer);
          if (result === "deferred") {
            const currentSource = eligibleSources.indexOf(deferred.peer);
            deferred.peer =
              eligibleSources[(currentSource + 1) % eligibleSources.length] ?? deferred.peer;
            deferred.nextAttemptAt =
              now +
              Math.min(
                MAX_DEFERRED_BACKOFF_MS,
                250 * 2 ** Math.min(deferred.attempts, 8),
              );
            continue;
          }
          this.deferred.delete(eventId);
          if (result === "rejected") {
            for (const peer of deferred.sources) {
              const rejected = rejectedByPeer.get(peer) ?? 0;
              rejectedByPeer.set(
                peer,
                Math.min(rejected + 1, MAX_REJECTED_EVENTS_PER_SYNC + 1),
              );
              rejectedThisSync.set(
                peer,
                Math.min(
                  (rejectedThisSync.get(peer) ?? 0) + 1,
                  MAX_REJECTED_EVENTS_PER_SYNC + 1,
                ),
              );
            }
          } else {
            applied += 1;
          }
        } catch (error) {
          deferred.nextAttemptAt = now + MAX_DEFERRED_BACKOFF_MS;
          this.options.onError?.(deferred.peer, error);
        }
      }
      if (applied === 0) break;
    }
    for (const [peer, count] of rejectedByPeer) {
      this.recordRejectedEvents(
        peer,
        count,
        count >= MAX_REJECTED_EVENTS_PER_SYNC
          ? "deferred events and reached its rejected-event quota"
          : "deferred events",
      );
    }
    for (const [peer, count] of expiredByPeer) {
      this.recordPeerIssue(
        peer,
        `federation peer had ${count} expired deferred events; cursor reset`,
      );
    }
  }
}
