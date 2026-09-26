// End-of-scenario invariant checks: the served book, the federation feed and
// a restarted process all have to agree, and no order may hold two fills.

import { deriveOrderV2Id } from "../order-signing.js";
import { BookClient } from "./client.js";
import { AUDIT_IP } from "./addresses.js";

export interface BookRow {
  id: string;
  status: string;
  direction: string;
  fromAmount: string;
  toAmount: string;
  orderDigest: string;
  filled: boolean;
  conflicts: number;
}

export interface FeedTotals {
  /** Events read from the append-only log, paged like a mirror peer. */
  logEvents: number;
  logOrderEvents: number;
  logIntentEvents: number;
  logFillEvents: number;
  logCancelEvents: number;
  logReleaseEvents: number;
  logPages: number;
  /** True when the log was paged from its oldest retained sequence. */
  logReadFromStart: boolean;
  /** Rows in the reset snapshot, which is the store's current state rendered
   *  as events, so it is a store view and not a log view. */
  snapshotRows: number;
  snapshotFillEvents: number;
  feedId: string | undefined;
  oldestSequence: number | undefined;
  latestSequence: number | undefined;
}

export interface ConsistencyReport {
  bookRows: number;
  feed: FeedTotals;
  /** Admitted proposals against fill-intent events on the append-only log. */
  admittedIntents: number;
  intentLogEventsMatchAdmitted: boolean;
  /** Open public rows whose order-v2 proof is missing from the log. */
  ordersMissingFromLog: string[];
  /** Open public rows missing from the reset snapshot: store against snapshot. */
  ordersMissingFromSnapshot: string[];
  ordersWithMultipleStoredFills: string[];
  /** Highest live proposal count any order held, against the documented 8. */
  maxLiveIntentsOnOneOrder: number;
  restart: {
    performed: boolean;
    reloadedRows: number;
    rowsIdentical: boolean;
    intentCountsIdentical: boolean;
    differences: string[];
  };
}

export async function readBook(client: BookClient): Promise<BookRow[]> {
  const reply = await client.send(
    "GET /orders",
    "GET",
    "/api/orders",
    AUDIT_IP,
  );
  const raw = reply.body?.["orders"];
  if (!Array.isArray(raw)) return [];
  const rows: BookRow[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const conflicts = record["conflictDigests"];
    rows.push({
      id: String(record["id"]),
      status: String(record["status"]),
      direction: String(record["direction"]),
      fromAmount: String(record["fromAmount"]),
      toAmount: String(record["toAmount"]),
      orderDigest: String(record["orderDigest"]),
      filled: record["fill"] !== undefined,
      conflicts: Array.isArray(conflicts) ? conflicts.length : 0,
    });
  }
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

export interface FeedEvent {
  kind: string;
  payload: Record<string, unknown>;
}

export interface FeedRead {
  totals: FeedTotals;
  /** Events from the append-only log, in sequence order. */
  logEvents: FeedEvent[];
  /** Events from the reset snapshot, which describes current store state. */
  snapshotEvents: FeedEvent[];
}

const CURSOR_RE = /^([0-9a-f]{32}):([0-9]+)$/;

function collectEvents(body: Record<string, unknown>, key: string): FeedEvent[] {
  const list = body[key];
  if (!Array.isArray(list)) return [];
  const events: FeedEvent[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const event = (entry as Record<string, unknown>)["event"];
    if (typeof event !== "object" || event === null) continue;
    const record = event as Record<string, unknown>;
    const payload = record["payload"];
    events.push({
      kind: String(record["kind"]),
      payload:
        typeof payload === "object" && payload !== null
          ? (payload as Record<string, unknown>)
          : {},
    });
  }
  return events;
}

/** Reads the feed the way a mirror peer catches up. The first request carries
 *  no cursor and answers with a reset snapshot plus the feed identity. The
 *  harness then rewinds to the oldest retained sequence and pages the
 *  append-only log forward, so log events are counted separately from the
 *  snapshot rows that describe current store state. */
export async function readFeed(client: BookClient): Promise<FeedRead> {
  const reset = await client.send(
    "GET /federation/v2/events",
    "GET",
    "/api/federation/v2/events?limit=256",
    AUDIT_IP,
  );
  const resetBody = reset.body ?? {};
  const snapshotEvents = collectEvents(resetBody, "snapshot");
  const resetCursor = resetBody["cursor"];
  const cursorMatch =
    typeof resetCursor === "string" ? CURSOR_RE.exec(resetCursor) : null;
  const feedId = cursorMatch?.[1];

  const status = await client.send(
    "GET /status",
    "GET",
    "/api/status",
    AUDIT_IP,
  );
  const feedStatus = status.body?.["feed"];
  const feedRecord =
    typeof feedStatus === "object" && feedStatus !== null
      ? (feedStatus as Record<string, unknown>)
      : {};
  const oldest = feedRecord["oldestSequence"];
  const latest = feedRecord["latestSequence"];
  const oldestSequence = typeof oldest === "number" ? oldest : undefined;
  const latestSequence = typeof latest === "number" ? latest : undefined;

  const logEvents: FeedEvent[] = [];
  let logPages = 0;
  let logReadFromStart = false;
  if (feedId !== undefined && oldestSequence !== undefined) {
    // A cursor of feedId:(oldest - 1) asks for everything the log still
    // retains. The book answers a reset instead when that point has already
    // been compacted away, which the flag below records.
    let cursor = `${feedId}:${String(Math.max(0, oldestSequence - 1))}`;
    logReadFromStart = true;
    for (let page = 0; page < 256; page += 1) {
      const reply = await client.send(
        "GET /federation/v2/events",
        "GET",
        `/api/federation/v2/events?limit=256&cursor=${encodeURIComponent(cursor)}`,
        AUDIT_IP,
      );
      if (reply.status !== 200) break;
      const body = reply.body ?? {};
      if (body["reset"] === true) {
        logReadFromStart = false;
        break;
      }
      logPages += 1;
      logEvents.push(...collectEvents(body, "events"));
      const nextCursor = body["cursor"];
      if (body["hasMore"] !== true || typeof nextCursor !== "string") break;
      if (nextCursor === cursor) break;
      cursor = nextCursor;
    }
  }

  const count = (events: readonly FeedEvent[], kind: string): number =>
    events.filter((event) => event.kind === kind).length;
  return {
    totals: {
      logEvents: logEvents.length,
      logOrderEvents: count(logEvents, "order-v2"),
      logIntentEvents: count(logEvents, "fill-intent-v2"),
      logFillEvents: count(logEvents, "fill-v2"),
      logCancelEvents: count(logEvents, "cancel-v2"),
      logReleaseEvents: count(logEvents, "release-v2"),
      logPages,
      logReadFromStart,
      snapshotRows: snapshotEvents.length,
      snapshotFillEvents: count(snapshotEvents, "fill-v2"),
      feedId,
      oldestSequence,
      latestSequence,
    },
    logEvents,
    snapshotEvents,
  };
}

export function feedOrderIds(events: readonly FeedEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.kind !== "order-v2") continue;
    const order = event.payload["order"];
    const auth = event.payload["auth"];
    if (typeof order !== "object" || order === null) continue;
    if (typeof auth !== "object" || auth === null) continue;
    const account = (order as Record<string, unknown>)["makerQrlAccount"];
    const nonce = (auth as Record<string, unknown>)["nonce"];
    if (typeof account !== "string" || typeof nonce !== "string") continue;
    try {
      ids.add(deriveOrderV2Id(account, nonce));
    } catch {
      // A malformed identity would already have failed verification; ignore.
    }
  }
  return ids;
}

/** Order ids that carry at least one fill-v2 event, from either view. An
 *  equivocated order legitimately shows two fill-v2 events, one for the
 *  selected fill and one for the retained conflict, so the event count alone
 *  never decides whether the store kept two fills. */
export function ordersWithFillEvents(
  events: readonly FeedEvent[],
): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.kind !== "fill-v2") continue;
    const orderId = event.payload["orderId"];
    if (typeof orderId === "string") ids.add(orderId);
  }
  return ids;
}

export async function intentCounts(
  client: BookClient,
  orders: readonly { orderId: string; makerToken: string }[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const order of orders) {
    const reply = await client.send(
      "GET /orders/:id/intents",
      "GET",
      `/api/orders/${order.orderId}/intents`,
      AUDIT_IP,
      undefined,
      { "X-Maker-Token": order.makerToken },
    );
    const list = reply.body?.["intents"];
    counts[order.orderId] = Array.isArray(list) ? list.length : -1;
  }
  return counts;
}

export function compareRows(
  before: readonly BookRow[],
  after: readonly BookRow[],
): string[] {
  const differences: string[] = [];
  if (before.length !== after.length) {
    differences.push(
      `row count ${String(before.length)} before restart and ${String(after.length)} after`,
    );
  }
  const afterById = new Map(after.map((row) => [row.id, row]));
  for (const row of before) {
    const match = afterById.get(row.id);
    if (match === undefined) {
      differences.push(`order ${row.id.slice(0, 12)} missing after restart`);
      continue;
    }
    for (const key of [
      "status",
      "direction",
      "fromAmount",
      "toAmount",
      "orderDigest",
    ] as const) {
      if (row[key] !== match[key]) {
        differences.push(
          `order ${row.id.slice(0, 12)} ${key} changed across restart`,
        );
      }
    }
    if (row.filled !== match.filled || row.conflicts !== match.conflicts) {
      differences.push(
        `order ${row.id.slice(0, 12)} terminal state changed across restart`,
      );
    }
  }
  return differences;
}
