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
} from "node:fs";
import { dirname, join } from "node:path";

export type FederationEventKind =
  | "order-v1"
  | "fill-intent-v1"
  | "fill-v1"
  | "cancel-v1"
  | "release-v1";

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

interface FederationEnvelope {
  version: 1;
  feedId: string;
  nextSeq: number;
  events: PersistedFederationRecord[];
}

export interface FederationPage {
  reset: boolean;
  cursor: string;
  hasMore: boolean;
  events: FederationRecord[];
  snapshot?: FederationRecord[];
}

const FEED_ID_RE = /^[0-9a-f]{32}$/;
const EVENT_ID_RE = /^[0-9a-f]{64}$/;
const MAX_EVENT_BYTES = 64 * 1024;
const DEFAULT_MAX_EVENTS = 4096;

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("federation events may contain only safe integer numbers");
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
        if (entry === undefined) throw new Error("federation events cannot contain undefined");
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
  return createHash("sha256").update(canonicalFederationJson(event)).digest("hex");
}

function isEventKind(value: unknown): value is FederationEventKind {
  return (
    value === "order-v1" ||
    value === "fill-intent-v1" ||
    value === "fill-v1" ||
    value === "cancel-v1" ||
    value === "release-v1"
  );
}

export function parseFederationEvent(raw: unknown, label = "federation event"): FederationEvent {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${label} must be an object`);
  }
  const row = raw as Record<string, unknown>;
  if (!isEventKind(row["kind"])) throw new Error(`${label} has an invalid kind`);
  const payload = row["payload"];
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`${label} has an invalid payload`);
  }
  const event: FederationEvent = { kind: row["kind"], payload: payload as Record<string, unknown> };
  if (Buffer.byteLength(canonicalFederationJson(event), "utf8") > MAX_EVENT_BYTES) {
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
    throw new Error(`persisted federation event ${index} has an invalid sequence`);
  }
  if (typeof eventId !== "string" || !EVENT_ID_RE.test(eventId)) {
    throw new Error(`persisted federation event ${index} has an invalid id`);
  }
  if (typeof receivedAt !== "number" || !Number.isSafeInteger(receivedAt) || receivedAt < 0) {
    throw new Error(`persisted federation event ${index} has an invalid receive time`);
  }
  const event = parseFederationEvent(row["event"], `persisted federation event ${index}`);
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

  constructor(
    private readonly file: string,
    private readonly maxEvents = DEFAULT_MAX_EVENTS,
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
      if (existsSync(this.file)) accessSync(this.file, fsConstants.R_OK | fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  has(eventId: string): boolean {
    return this.eventIds.has(eventId);
  }

  append(raw: FederationEvent, receivedAt = Math.floor(Date.now() / 1000)): FederationRecord {
    const event = parseFederationEvent(raw);
    const eventId = federationEventId(event);
    const existing = this.events.find((entry) => entry.eventId === eventId);
    if (existing !== undefined) return publicRecord(existing);
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
    this.nextSeq += 1;
    this.events.push(record);
    this.eventIds.add(eventId);
    let removed: PersistedFederationRecord | undefined;
    while (this.events.length > this.maxEvents) {
      removed = this.events.shift();
      if (removed !== undefined) this.eventIds.delete(removed.eventId);
    }
    try {
      this.persist();
    } catch (error) {
      this.nextSeq = previousNextSeq;
      this.events.pop();
      this.eventIds.delete(eventId);
      if (removed !== undefined) {
        this.events.unshift(removed);
        this.eventIds.add(removed.eventId);
      }
      throw error;
    }
    return publicRecord(record);
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
    const match = cursor === null ? null : /^([0-9a-f]{32}):([0-9]+)$/.exec(cursor);
    const after = match === null ? null : Number(match[2]);
    const oldest = this.events[0]?.seq ?? this.nextSeq;
    const needsReset =
      match === null ||
      match[1] !== this.feedId ||
      after === null ||
      !Number.isSafeInteger(after) ||
      after < oldest - 1 ||
      after > highWater;

    if (needsReset) {
      const snapshotRecords = snapshot().map((event) => {
        const parsed = parseFederationEvent(event, "federation snapshot event");
        return { seq: highWater, eventId: federationEventId(parsed), event: parsed };
      });
      return {
        reset: true,
        cursor: `${this.feedId}:${highWater}`,
        hasMore: false,
        events: [],
        snapshot: snapshotRecords,
      };
    }

    const available = this.events.filter((entry) => entry.seq > after);
    const selected = available.slice(0, limit);
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
      throw new Error(`federation data path is not readable and writable: ${this.file}`);
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`federation data file is not valid JSON: ${this.file}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`federation data file must contain an object: ${this.file}`);
    }
    const envelope = parsed as Record<string, unknown>;
    if (envelope["version"] !== 1) {
      throw new Error(`federation data file has an unsupported version: ${this.file}`);
    }
    const feedId = envelope["feedId"];
    const nextSeq = envelope["nextSeq"];
    const rawEvents = envelope["events"];
    if (typeof feedId !== "string" || !FEED_ID_RE.test(feedId)) {
      throw new Error(`federation data file has an invalid feed id: ${this.file}`);
    }
    if (typeof nextSeq !== "number" || !Number.isSafeInteger(nextSeq) || nextSeq < 1) {
      throw new Error(`federation data file has an invalid sequence: ${this.file}`);
    }
    if (!Array.isArray(rawEvents) || rawEvents.length > this.maxEvents) {
      throw new Error(`federation data file has an invalid event list: ${this.file}`);
    }
    const events = rawEvents.map(parseRecord);
    for (let index = 1; index < events.length; index += 1) {
      if ((events[index - 1]?.seq ?? 0) >= (events[index]?.seq ?? 0)) {
        throw new Error(`federation data file sequences are not increasing: ${this.file}`);
      }
    }
    if ((events.at(-1)?.seq ?? 0) >= nextSeq) {
      throw new Error(`federation data file next sequence is invalid: ${this.file}`);
    }
    const ids = new Set(events.map((entry) => entry.eventId));
    if (ids.size !== events.length) {
      throw new Error(`federation data file contains duplicate events: ${this.file}`);
    }
    this.feedId = feedId;
    this.nextSeq = nextSeq;
    this.events = events;
    this.eventIds = ids;
  }

  private persist(): void {
    const directory = dirname(this.file);
    const tmp = join(directory, `.federation.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    const envelope: FederationEnvelope = {
      version: 1,
      feedId: this.feedId,
      nextSeq: this.nextSeq,
      events: this.events,
    };
    let fileDescriptor: number | undefined;
    try {
      fileDescriptor = openSync(tmp, "wx", 0o600);
      fchmodSync(fileDescriptor, 0o600);
      writeFileSync(fileDescriptor, JSON.stringify(envelope), "utf8");
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
      throw new Error("federation data could not be persisted safely");
    }
  }
}
