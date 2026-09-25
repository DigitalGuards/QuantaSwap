// Durable, content-addressed event feed for order-book federation. The
// transport cursor is local to one mirror. Protocol validity is checked by
// OrderStore before an event is appended, so this module only handles stable
// encoding, replay deduplication, bounded history, and reset snapshots.

import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type FederationEventKind =
  | "order-v2"
  | "fill-intent-v2"
  | "fill-v2"
  | "cancel-v2"
  | "release-v2";

export interface FederationEvent {
  kind: FederationEventKind;
  payload: Record<string, unknown>;
}

export interface FederationRecord {
  seq: number;
  eventId: string;
  event: FederationEvent;
}

interface PersistedFederationRecord extends FederationRecord {
  receivedAt: number;
}

// The feed file is an append-only log of JSON lines. The first line is a
// header, and each later line is one retained event or a snapshot digest
// update. The log is compacted into a fresh header plus the retained ring
// once it holds a quarter more lines than the ring, so an append costs one
// line and one fsync rather than a rewrite of every retained proof. Version 2
// files, a single JSON envelope, are migrated on load.
interface FederationLogHeader {
  type: "header";
  version: 3;
  feedId: string;
  nextSeq: number;
  snapshotDigest: string | null;
}

export interface FederationPage {
  reset: boolean;
  cursor: string;
  hasMore: boolean;
  events: FederationRecord[];
  snapshot?: FederationRecord[];
}

export interface FederationFeedStatus {
  retainedEvents: number;
  oldestSequence: number | null;
  latestSequence: number | null;
  lastEventAt: number | null;
}

export const MAX_FEDERATION_RESPONSE_BYTES = 32 * 1024 * 1024;
export const MAX_FEDERATION_INCREMENTAL_BYTES = 4 * 1024 * 1024;

export class FederationResponseTooLargeError extends Error {
  readonly actualBytes: number;
  readonly maxBytes: number;

  constructor(actualBytes: number, maxBytes: number) {
    super(
      `federation response is ${actualBytes} bytes and exceeds the ${maxBytes} byte limit`,
    );
    this.name = "FederationResponseTooLargeError";
    this.actualBytes = actualBytes;
    this.maxBytes = maxBytes;
  }
}

const FEED_ID_RE = /^[0-9a-f]{32}$/;
const EVENT_ID_RE = /^[0-9a-f]{64}$/;
const FEDERATION_CURSOR_RE = /^([0-9a-f]{32}):(0|[1-9][0-9]{0,15})$/;
const MAX_EVENT_BYTES = 64 * 1024;
const DEFAULT_MAX_EVENTS = 4096;
const MAX_SNAPSHOT_EVENTS = 8192;
const RESET_CACHE_TTL_MS = 5_000;

interface CachedResetPage {
  expiresAt: number;
  page: FederationPage;
}

export function serializeFederationPage(
  page: FederationPage,
  maxBytes = MAX_FEDERATION_RESPONSE_BYTES,
): string {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_FEDERATION_RESPONSE_BYTES
  ) {
    throw new Error("federation response byte limit is invalid");
  }
  const serialized = JSON.stringify(page);
  const actualBytes = Buffer.byteLength(serialized, "utf8");
  if (actualBytes > maxBytes) {
    throw new FederationResponseTooLargeError(actualBytes, maxBytes);
  }
  return serialized;
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        "federation events may contain only safe integer numbers",
      );
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalValue(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("federation events may contain only plain objects");
    }
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    return `{${keys
      .map((key) => {
        const entry = object[key];
        if (entry === undefined)
          throw new Error("federation events cannot contain undefined");
        return `${JSON.stringify(key)}:${canonicalValue(entry)}`;
      })
      .join(",")}}`;
  }
  throw new Error("federation event contains an unsupported value");
}

export function canonicalFederationJson(event: FederationEvent): string {
  return canonicalValue(event);
}

export function federationEventId(event: FederationEvent): string {
  return createHash("sha256")
    .update(canonicalFederationJson(event))
    .digest("hex");
}

function federationSnapshotDigest(
  rawEvents: readonly FederationEvent[],
): string {
  if (rawEvents.length > MAX_SNAPSHOT_EVENTS) {
    throw new Error("federation snapshot exceeds the event limit");
  }
  const eventIds = new Set<string>();
  for (const raw of rawEvents) {
    const event = parseFederationEvent(raw, "federation reconciliation event");
    eventIds.add(federationEventId(event));
  }
  const hash = createHash("sha256").update(
    "QuantaSwap Federation snapshot V1\0",
  );
  for (const eventId of [...eventIds].sort()) hash.update(eventId);
  return hash.digest("hex");
}

function isEventKind(value: unknown): value is FederationEventKind {
  return (
    value === "order-v2" ||
    value === "fill-intent-v2" ||
    value === "fill-v2" ||
    value === "cancel-v2" ||
    value === "release-v2"
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => keys.includes(key))
  );
}

export function parseFederationEvent(
  raw: unknown,
  label = "federation event",
): FederationEvent {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${label} must be an object`);
  }
  const row = raw as Record<string, unknown>;
  if (!hasExactKeys(row, ["kind", "payload"])) {
    throw new Error(`${label} has unexpected fields`);
  }
  if (!isEventKind(row["kind"]))
    throw new Error(`${label} has an invalid kind`);
  const payload = row["payload"];
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new Error(`${label} has an invalid payload`);
  }
  const event: FederationEvent = {
    kind: row["kind"],
    payload: payload as Record<string, unknown>,
  };
  if (
    Buffer.byteLength(canonicalFederationJson(event), "utf8") > MAX_EVENT_BYTES
  ) {
    throw new Error(`${label} exceeds the size limit`);
  }
  return event;
}

function parseRecord(raw: unknown, index: number): PersistedFederationRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`persisted federation event ${index} is invalid`);
  }
  const row = raw as Record<string, unknown>;
  const seq = row["seq"];
  const eventId = row["eventId"];
  const receivedAt = row["receivedAt"];
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
    throw new Error(
      `persisted federation event ${index} has an invalid sequence`,
    );
  }
  if (typeof eventId !== "string" || !EVENT_ID_RE.test(eventId)) {
    throw new Error(`persisted federation event ${index} has an invalid id`);
  }
  if (
    typeof receivedAt !== "number" ||
    !Number.isSafeInteger(receivedAt) ||
    receivedAt < 0
  ) {
    throw new Error(
      `persisted federation event ${index} has an invalid receive time`,
    );
  }
  const event = parseFederationEvent(
    row["event"],
    `persisted federation event ${index}`,
  );
  if (federationEventId(event) !== eventId) {
    throw new Error(`persisted federation event ${index} has a mismatched id`);
  }
  return { seq, eventId, event, receivedAt };
}

function publicRecord(record: PersistedFederationRecord): FederationRecord {
  return { seq: record.seq, eventId: record.eventId, event: record.event };
}

export class FederationFeed {
  private feedId = randomBytes(16).toString("hex");
  private nextSeq = 1;
  private events: PersistedFederationRecord[] = [];
  private eventIds = new Set<string>();
  private snapshotDigest: string | null = null;
  private cachedResetPage: CachedResetPage | undefined;
  /** Event and digest lines in the log file, or null before compaction. */
  private logLines: number | null = null;

  constructor(
    private readonly file: string,
    private readonly maxEvents = DEFAULT_MAX_EVENTS,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) {
      throw new Error("federation maxEvents must be a positive integer");
    }
    this.prepareStorage();
    this.load();
  }

  storageReady(): boolean {
    try {
      accessSync(dirname(this.file), fsConstants.R_OK | fsConstants.W_OK);
      if (existsSync(this.file))
        accessSync(this.file, fsConstants.R_OK | fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Public diagnostics intentionally omit the feed id, file path and events. */
  status(): FederationFeedStatus {
    const first = this.events[0];
    const last = this.events.at(-1);
    return {
      retainedEvents: this.events.length,
      oldestSequence: first?.seq ?? null,
      latestSequence: last?.seq ?? null,
      lastEventAt: last === undefined ? null : last.receivedAt * 1000,
    };
  }

  has(eventId: string): boolean {
    return this.eventIds.has(eventId);
  }

  requiresReset(cursor: string | null): boolean {
    if (cursor === null || cursor.length > 64) return true;
    const match = FEDERATION_CURSOR_RE.exec(cursor);
    if (match === null || match[1] !== this.feedId) return true;
    const rawAfter = match[2];
    if (rawAfter === undefined) return true;
    const after = Number(rawAfter);
    if (!Number.isSafeInteger(after)) return true;
    const oldest = this.events[0]?.seq ?? this.nextSeq;
    const highWater = this.nextSeq - 1;
    return after < oldest - 1 || after > highWater;
  }

  append(
    raw: FederationEvent,
    receivedAt = Math.floor(Date.now() / 1000),
    snapshot?: readonly FederationEvent[],
  ): FederationRecord {
    const event = parseFederationEvent(raw);
    const eventId = federationEventId(event);
    const existing = this.events.find((entry) => entry.eventId === eventId);
    const nextSnapshotDigest =
      snapshot === undefined
        ? this.snapshotDigest
        : federationSnapshotDigest(snapshot);
    if (existing !== undefined && nextSnapshotDigest === this.snapshotDigest) {
      return publicRecord(existing);
    }
    if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) {
      throw new Error("federation event receive time is invalid");
    }
    const record: PersistedFederationRecord = {
      seq: this.nextSeq,
      eventId,
      event,
      receivedAt,
    };
    const previousNextSeq = this.nextSeq;
    const previousSnapshotDigest = this.snapshotDigest;
    const lines: unknown[] = [];
    if (existing === undefined) {
      this.nextSeq += 1;
      this.events.push(record);
      this.eventIds.add(eventId);
      lines.push({ type: "event", ...record });
    }
    this.snapshotDigest = nextSnapshotDigest;
    if (nextSnapshotDigest !== previousSnapshotDigest) {
      lines.push({ type: "digest", snapshotDigest: nextSnapshotDigest });
    }
    const removed: PersistedFederationRecord[] = [];
    while (this.events.length > this.maxEvents) {
      const trimmed = this.events.shift();
      if (trimmed !== undefined) {
        this.eventIds.delete(trimmed.eventId);
        removed.push(trimmed);
      }
    }
    if (
      this.cachedResetPage !== undefined &&
      (nextSnapshotDigest !== previousSnapshotDigest ||
        this.requiresReset(this.cachedResetPage.page.cursor))
    ) {
      this.cachedResetPage = undefined;
    }
    try {
      this.appendLines(lines);
    } catch (error) {
      this.nextSeq = previousNextSeq;
      this.snapshotDigest = previousSnapshotDigest;
      if (existing === undefined) {
        this.events.pop();
        this.eventIds.delete(eventId);
      }
      for (const entry of removed.reverse()) {
        this.events.unshift(entry);
        this.eventIds.add(entry.eventId);
      }
      throw error;
    }
    return publicRecord(existing ?? record);
  }

  reconcileSnapshot(rawEvents: readonly FederationEvent[]): boolean {
    const digest = federationSnapshotDigest(rawEvents);
    if (digest === this.snapshotDigest) return false;

    const previousFeedId = this.feedId;
    const previousSnapshotDigest = this.snapshotDigest;
    this.feedId = randomBytes(16).toString("hex");
    this.snapshotDigest = digest;
    this.cachedResetPage = undefined;
    try {
      this.compact();
    } catch (error) {
      this.feedId = previousFeedId;
      this.snapshotDigest = previousSnapshotDigest;
      throw error;
    }
    return true;
  }

  page(
    cursor: string | null,
    limit: number,
    snapshot: () => FederationEvent[],
  ): FederationPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new Error("federation page limit must be between 1 and 256");
    }
    const highWater = this.nextSeq - 1;
    if (this.requiresReset(cursor)) {
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new Error("federation clock returned an invalid time");
      }
      if (
        this.cachedResetPage !== undefined &&
        now < this.cachedResetPage.expiresAt &&
        !this.requiresReset(this.cachedResetPage.page.cursor)
      ) {
        return this.cachedResetPage.page;
      }
      const snapshotRecords = snapshot().map((event) => {
        const parsed = parseFederationEvent(event, "federation snapshot event");
        return {
          seq: highWater,
          eventId: federationEventId(parsed),
          event: parsed,
        };
      });
      const page: FederationPage = {
        reset: true,
        cursor: `${this.feedId}:${highWater}`,
        hasMore: false,
        events: [],
        snapshot: snapshotRecords,
      };
      this.cachedResetPage = { expiresAt: now + RESET_CACHE_TTL_MS, page };
      return page;
    }

    const match = FEDERATION_CURSOR_RE.exec(cursor ?? "");
    const rawAfter = match?.[2];
    if (rawAfter === undefined) {
      throw new Error("federation cursor became invalid during pagination");
    }
    const after = Number(rawAfter);
    const available = this.events.filter((entry) => entry.seq > after);
    const selected: PersistedFederationRecord[] = [];
    let selectedBytes = 256;
    for (const entry of available) {
      if (selected.length >= limit) break;
      const recordBytes =
        Buffer.byteLength(JSON.stringify(publicRecord(entry)), "utf8") + 1;
      if (
        selected.length > 0 &&
        selectedBytes + recordBytes > MAX_FEDERATION_INCREMENTAL_BYTES
      ) {
        break;
      }
      selected.push(entry);
      selectedBytes += recordBytes;
    }
    const lastSeq = selected.at(-1)?.seq ?? after;
    return {
      reset: false,
      cursor: `${this.feedId}:${lastSeq}`,
      hasMore: selected.length < available.length,
      events: selected.map(publicRecord),
    };
  }

  private prepareStorage(): void {
    const directory = dirname(this.file);
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      accessSync(directory, fsConstants.R_OK | fsConstants.W_OK);
      if (existsSync(this.file)) {
        accessSync(this.file, fsConstants.R_OK | fsConstants.W_OK);
        chmodSync(this.file, 0o600);
      }
    } catch {
      throw new Error(
        `federation data path is not readable and writable: ${this.file}`,
      );
    }
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`federation data file could not be read: ${this.file}`);
    }
    if (!raw.includes("\n")) {
      // Version 2 stored one JSON envelope without a line terminator. A log
      // always ends its atomically written header with one.
      const envelope = this.parseLine(raw, "envelope");
      if (envelope["version"] !== 2) {
        throw new Error(
          `federation data file has an unsupported version: ${this.file}`,
        );
      }
      this.loadLegacyEnvelope(envelope);
      this.compact();
      return;
    }
    const lines = raw.split("\n");
    // A crash can leave one unterminated final line. It was never
    // acknowledged, so drop it and rewrite a clean log below.
    const tornTail = lines.pop() !== "";
    const header = this.parseLine(lines[0], "header");
    if (header["type"] !== "header" || header["version"] !== 3) {
      throw new Error(
        `federation data file has an unsupported version: ${this.file}`,
      );
    }
    const feedId = header["feedId"];
    const nextSeq = header["nextSeq"];
    if (typeof feedId !== "string" || !FEED_ID_RE.test(feedId)) {
      throw new Error(
        `federation data file has an invalid feed id: ${this.file}`,
      );
    }
    if (
      typeof nextSeq !== "number" ||
      !Number.isSafeInteger(nextSeq) ||
      nextSeq < 1
    ) {
      throw new Error(
        `federation data file has an invalid sequence: ${this.file}`,
      );
    }
    let snapshotDigest = this.parseDigest(header["snapshotDigest"]);
    const events: PersistedFederationRecord[] = [];
    const ids = new Set<string>();
    let lastSeq = 0;
    for (let index = 1; index < lines.length; index += 1) {
      const line = this.parseLine(lines[index], `line ${index + 1}`);
      if (line["type"] === "digest") {
        snapshotDigest = this.parseDigest(line["snapshotDigest"]);
        continue;
      }
      if (line["type"] !== "event") {
        throw new Error(
          `federation data file line ${index + 1} has an unknown type: ${this.file}`,
        );
      }
      const { type: _type, ...rawRecord } = line;
      const record = parseRecord(rawRecord, index);
      if (record.seq <= lastSeq) {
        throw new Error(
          `federation data file sequences are not increasing: ${this.file}`,
        );
      }
      lastSeq = record.seq;
      // An event trimmed from the ring may be appended again later.
      if (ids.has(record.eventId)) {
        events.splice(
          events.findIndex((entry) => entry.eventId === record.eventId),
          1,
        );
      }
      events.push(record);
      ids.add(record.eventId);
      while (events.length > this.maxEvents) {
        const trimmed = events.shift();
        if (trimmed !== undefined) ids.delete(trimmed.eventId);
      }
    }
    this.feedId = feedId;
    this.nextSeq = Math.max(nextSeq, lastSeq + 1);
    this.events = events;
    this.eventIds = ids;
    this.snapshotDigest = snapshotDigest;
    this.logLines = lines.length - 1;
    if (tornTail) this.compact();
  }

  private parseLine(
    line: string | undefined,
    label: string,
  ): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line ?? "");
    } catch {
      throw new Error(
        `federation data file ${label} is not valid JSON: ${this.file}`,
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        `federation data file ${label} must contain an object: ${this.file}`,
      );
    }
    return parsed as Record<string, unknown>;
  }

  private parseDigest(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || !EVENT_ID_RE.test(value)) {
      throw new Error(
        `federation data file has an invalid snapshot digest: ${this.file}`,
      );
    }
    return value;
  }

  private loadLegacyEnvelope(envelope: Record<string, unknown>): void {
    const feedId = envelope["feedId"];
    const nextSeq = envelope["nextSeq"];
    const rawEvents = envelope["events"];
    if (typeof feedId !== "string" || !FEED_ID_RE.test(feedId)) {
      throw new Error(
        `federation data file has an invalid feed id: ${this.file}`,
      );
    }
    if (
      typeof nextSeq !== "number" ||
      !Number.isSafeInteger(nextSeq) ||
      nextSeq < 1
    ) {
      throw new Error(
        `federation data file has an invalid sequence: ${this.file}`,
      );
    }
    if (!Array.isArray(rawEvents) || rawEvents.length > this.maxEvents) {
      throw new Error(
        `federation data file has an invalid event list: ${this.file}`,
      );
    }
    const snapshotDigest = this.parseDigest(envelope["snapshotDigest"]);
    const events = rawEvents.map(parseRecord);
    for (let index = 1; index < events.length; index += 1) {
      if ((events[index - 1]?.seq ?? 0) >= (events[index]?.seq ?? 0)) {
        throw new Error(
          `federation data file sequences are not increasing: ${this.file}`,
        );
      }
    }
    if ((events.at(-1)?.seq ?? 0) >= nextSeq) {
      throw new Error(
        `federation data file next sequence is invalid: ${this.file}`,
      );
    }
    const ids = new Set(events.map((entry) => entry.eventId));
    if (ids.size !== events.length) {
      throw new Error(
        `federation data file contains duplicate events: ${this.file}`,
      );
    }
    this.feedId = feedId;
    this.nextSeq = nextSeq;
    this.events = events;
    this.eventIds = ids;
    this.snapshotDigest = snapshotDigest;
  }

  private appendLines(lines: readonly unknown[]): void {
    if (lines.length === 0) return;
    if (this.logLines === null || !existsSync(this.file)) {
      this.compact();
      return;
    }
    let fileDescriptor: number | undefined;
    try {
      fileDescriptor = openSync(this.file, "a", 0o600);
      writeSync(
        fileDescriptor,
        lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
      );
      fsyncSync(fileDescriptor);
    } catch {
      // A failed append may leave a partial line; rewrite before reuse.
      this.logLines = null;
      throw new Error("federation data could not be persisted safely");
    } finally {
      if (fileDescriptor !== undefined) {
        try {
          closeSync(fileDescriptor);
        } catch {
          // Preserve the original persistence outcome.
        }
      }
    }
    this.logLines += lines.length;
    if (this.logLines > this.maxEvents + Math.ceil(this.maxEvents / 4)) {
      this.compact();
    }
  }

  private compact(): void {
    const directory = dirname(this.file);
    const tmp = join(
      directory,
      `.federation.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    const header: FederationLogHeader = {
      type: "header",
      version: 3,
      feedId: this.feedId,
      nextSeq: this.nextSeq,
      snapshotDigest: this.snapshotDigest,
    };
    const content = [
      header,
      ...this.events.map((record) => ({ type: "event", ...record })),
    ]
      .map((line) => `${JSON.stringify(line)}\n`)
      .join("");
    let fileDescriptor: number | undefined;
    try {
      fileDescriptor = openSync(tmp, "wx", 0o600);
      fchmodSync(fileDescriptor, 0o600);
      writeFileSync(fileDescriptor, content, "utf8");
      fsyncSync(fileDescriptor);
      closeSync(fileDescriptor);
      fileDescriptor = undefined;
      renameSync(tmp, this.file);
      const directoryDescriptor = openSync(directory, "r");
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch {
      if (fileDescriptor !== undefined) {
        try {
          closeSync(fileDescriptor);
        } catch {
          // Preserve the original persistence failure.
        }
      }
      try {
        unlinkSync(tmp);
      } catch {
        // The rename may already have consumed the temporary file.
      }
      this.logLines = null;
      throw new Error("federation data could not be persisted safely");
    }
    this.logLines = this.events.length;
  }
}
