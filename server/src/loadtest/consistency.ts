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
  events: number;
  orderEvents: number;
  intentEvents: number;
  fillEvents: number;
  cancelEvents: number;
  releaseEvents: number;
  pages: number;
}

export interface ConsistencyReport {
  bookRows: number;
  feed: FeedTotals;
  /** Accepted intent responses against fill-intent events on the feed. */
  acceptedIntents: number;
  intentEventsMatchAccepted: boolean;
  /** Open public rows whose order-v2 proof is missing from the feed. */
  ordersMissingFromFeed: string[];
  ordersWithMultipleFills: string[];
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

interface FeedEvent {
  kind: string;
  payload: Record<string, unknown>;
}

/** Pages the documented federation feed, so the check exercises the same view
 *  a mirror peer would pull. The private log file stays untouched. */
export async function readFeed(
  client: BookClient,
): Promise<{ totals: FeedTotals; events: FeedEvent[] }> {
  const events: FeedEvent[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (let page = 0; page < 64; page += 1) {
    const path =
      cursor === undefined
        ? "/api/federation/v2/events?limit=256"
        : `/api/federation/v2/events?limit=256&cursor=${encodeURIComponent(cursor)}`;
    const reply = await client.send(
      "GET /federation/v2/events",
      "GET",
      path,
      AUDIT_IP,
    );
    if (reply.status !== 200) break;
    pages += 1;
    const body = reply.body ?? {};
    for (const key of ["snapshot", "events"] as const) {
      const list = body[key];
      if (!Array.isArray(list)) continue;
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
    }
    const nextCursor = body["cursor"];
    if (body["hasMore"] !== true || typeof nextCursor !== "string") break;
    cursor = nextCursor;
  }
  const count = (kind: string): number =>
    events.filter((event) => event.kind === kind).length;
  return {
    totals: {
      events: events.length,
      orderEvents: count("order-v2"),
      intentEvents: count("fill-intent-v2"),
      fillEvents: count("fill-v2"),
      cancelEvents: count("cancel-v2"),
      releaseEvents: count("release-v2"),
      pages,
    },
    events,
  };
}

export function feedOrderIds(events: readonly { kind: string; payload: Record<string, unknown> }[]): Set<string> {
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

export function fillsPerOrder(
  events: readonly { kind: string; payload: Record<string, unknown> }[],
): Map<string, Set<string>> {
  const byOrder = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.kind !== "fill-v2") continue;
    const orderId = event.payload["orderId"];
    const fill = event.payload["fill"];
    if (typeof orderId !== "string") continue;
    const digest = JSON.stringify(fill);
    const set = byOrder.get(orderId) ?? new Set<string>();
    set.add(digest);
    byOrder.set(orderId, set);
  }
  return byOrder;
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
