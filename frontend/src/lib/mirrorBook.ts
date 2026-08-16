// Reconcile full snapshots from independent order book origins. Portable
// OrderV1 proofs define identity; mirror-local fields only select a transport
// source and never enter the signed payload.

import {
  ORDERBOOK_MIRRORS,
  PRIMARY_ORDERBOOK_ID,
  type OrderbookMirror,
} from "../config";
import type { CreateOrderBody, OrderView } from "./orderbook";
import {
  OrderbookClient,
  type OrderbookClientOptions,
  type OrderbookEventStream,
} from "./orderbookClient";
import { orderDigest, verifyOrderV1Auth } from "./orderSigning";

export interface MirrorSnapshot {
  bookId: string;
  orders: readonly OrderView[];
}

export interface MirrorBookResult {
  orders: OrderView[];
  quarantinedIds: string[];
}

export interface MirrorAggregationOptions {
  now?: number;
  verifyOrder?: (order: OrderView, now: number) => boolean;
  digestOrder?: (order: OrderView) => string;
}

export interface QuarantineStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface QuarantineStorageEvent {
  key: string | null;
}

export interface QuarantineEventSource {
  addEventListener(
    type: "storage",
    listener: (event: QuarantineStorageEvent) => void,
  ): void;
}

const QUARANTINE_STORAGE_KEY = "quantaswap.orderbook.quarantines.v1";
const PORTABLE_ORDER_ID_RE = /^[0-9a-f]{64}$/;
const MAX_RETAINED_QUARANTINES = 1024;
const QUARANTINE_RETENTION_MS = 49 * 60 * 60 * 1000;
const MAX_STORAGE_CLOCK_SKEW_MS = 5 * 60 * 1000;

type QuarantineMap = Map<string, number>;

function browserStorage(): QuarantineStorage | null {
  try {
    return typeof globalThis.localStorage === "undefined"
      ? null
      : globalThis.localStorage;
  } catch {
    return null;
  }
}

function browserQuarantineEvents(): QuarantineEventSource | null {
  try {
    if (typeof globalThis.addEventListener !== "function") return null;
    return {
      addEventListener: (_type, listener) => {
        globalThis.addEventListener("storage", (event) =>
          listener({ key: (event as StorageEvent).key }),
        );
      },
    };
  } catch {
    return null;
  }
}

function pruneQuarantines(
  entries: ReadonlyMap<string, number>,
  now = Date.now(),
): QuarantineMap {
  return new Map(
    [...entries]
      .filter(
        ([id, observedAt]) =>
          PORTABLE_ORDER_ID_RE.test(id) &&
          Number.isSafeInteger(observedAt) &&
          observedAt >= 0 &&
          observedAt > now - QUARANTINE_RETENTION_MS &&
          observedAt <= now + MAX_STORAGE_CLOCK_SKEW_MS,
      )
      .sort(
        ([leftId, leftAt], [rightId, rightAt]) =>
          rightAt - leftAt || leftId.localeCompare(rightId),
      )
      .slice(0, MAX_RETAINED_QUARANTINES),
  );
}

function loadQuarantines(
  storage: QuarantineStorage | null,
  now = Date.now(),
): QuarantineMap {
  if (storage === null) return new Map();
  try {
    const parsed = JSON.parse(storage.getItem(QUARANTINE_STORAGE_KEY) ?? "null") as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return new Map();
    }
    const record = parsed as Record<string, unknown>;
    if (record["version"] === 1 && Array.isArray(record["quarantinedIds"])) {
      return pruneQuarantines(
        new Map(
          record["quarantinedIds"]
            .slice(0, MAX_RETAINED_QUARANTINES * 4)
            .flatMap((id) =>
              typeof id === "string" && PORTABLE_ORDER_ID_RE.test(id)
                ? [[id, now] as const]
                : [],
            ),
        ),
        now,
      );
    }
    if (record["version"] !== 2 || !Array.isArray(record["entries"])) {
      return new Map();
    }
    const entries = new Map<string, number>();
    record["entries"].slice(0, MAX_RETAINED_QUARANTINES * 4).forEach((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return;
      const candidate = entry as Record<string, unknown>;
      const id = candidate["id"];
      const observedAt = candidate["observedAt"];
      if (typeof id !== "string" || typeof observedAt !== "number") return;
      entries.set(id, Math.max(entries.get(id) ?? 0, observedAt));
    });
    return pruneQuarantines(entries, now);
  } catch {
    return new Map();
  }
}

function saveQuarantines(
  storage: QuarantineStorage | null,
  entries: ReadonlyMap<string, number>,
  now = Date.now(),
): QuarantineMap {
  const merged = loadQuarantines(storage, now);
  entries.forEach((observedAt, id) =>
    merged.set(id, Math.max(merged.get(id) ?? 0, observedAt)),
  );
  const retained = pruneQuarantines(merged, now);
  if (storage === null) return retained;
  try {
    storage.setItem(
      QUARANTINE_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        entries: [...retained].map(([id, observedAt]) => ({ id, observedAt })),
      }),
    );
  } catch {
    // Storage can be disabled or full. The in-memory quarantine remains active.
  }
  return retained;
}

interface SignedCandidate {
  order: OrderView;
  bookId: string;
}

function signedOrderBody(order: OrderView): CreateOrderBody {
  if (order.asset === undefined) throw new Error("signed order has no asset");
  const body: CreateOrderBody = {
    direction: order.direction,
    asset: order.asset,
    fromAmount: order.fromAmount,
    toAmount: order.toAmount,
    makerEthAccount: order.makerEthAccount,
    makerQrlAccount: order.makerQrlAccount,
    visibility: order.visibility ?? "public",
    ...(order.allowedTakerEth === undefined
      ? {}
      : { allowedTakerEth: order.allowedTakerEth }),
    ...(order.allowedTakerQrl === undefined
      ? {}
      : { allowedTakerQrl: order.allowedTakerQrl }),
  };
  if (order.prelocked === true) {
    if (order.hashlock === null || order.initiatorTimeout === null) {
      throw new Error("signed prelock is incomplete");
    }
    body.prelock = {
      hashlock: order.hashlock,
      initiatorTimeout: order.initiatorTimeout,
    };
  }
  return body;
}

export function portableOrderDigest(order: OrderView): string {
  if (order.makerAuth === undefined) throw new Error("order has no portable proof");
  return orderDigest(signedOrderBody(order), order.makerAuth);
}

function localOrder(
  order: OrderView,
  digest: string | undefined,
  sources: readonly string[],
): OrderView {
  const bookId = sources[0] ?? PRIMARY_ORDERBOOK_ID;
  const {
    bookId: _untrustedBookId,
    sources: _untrustedSources,
    orderDigest: _advertisedDigest,
    ...wireOrder
  } = order;
  return {
    ...wireOrder,
    ...(digest === undefined ? {} : { orderDigest: digest }),
    bookId,
    sources: [...sources],
  };
}

/**
 * Authenticate and combine public snapshots. Unsigned compatibility rows are
 * accepted only from primary. Private rows are always excluded. If a maker
 * signs two OrderV1 bodies with one nonce/id, every variant is hidden.
 */
export function aggregateMirrorOrders(
  snapshots: readonly MirrorSnapshot[],
  options: MirrorAggregationOptions = {},
): MirrorBookResult {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const verifyOrder = options.verifyOrder ?? verifyOrderV1Auth;
  const digestOrder = options.digestOrder ?? portableOrderDigest;
  const signed = new Map<string, Map<string, SignedCandidate[]>>();
  const signedIds = new Set<string>();

  for (const snapshot of snapshots) {
    for (const order of snapshot.orders) {
      if (typeof order !== "object" || order === null || Array.isArray(order)) continue;
      if (order.visibility === "private" || order.makerAuth === undefined) continue;
      if (!verifyOrder(order, now)) continue;
      let digest: string;
      try {
        digest = digestOrder(order);
      } catch {
        continue;
      }
      signedIds.add(order.id);
      const variants = signed.get(order.id) ?? new Map<string, SignedCandidate[]>();
      const candidates = variants.get(digest) ?? [];
      candidates.push({ order, bookId: snapshot.bookId });
      variants.set(digest, candidates);
      signed.set(order.id, variants);
    }
  }

  const quarantinedIds = new Set<string>();
  const combined: OrderView[] = [];
  for (const [id, variants] of signed) {
    if (variants.size !== 1) {
      quarantinedIds.add(id);
      continue;
    }
    const entry = variants.entries().next().value as
      | [string, SignedCandidate[]]
      | undefined;
    if (entry === undefined) continue;
    const [digest, candidates] = entry;
    const representative = candidates[0];
    if (representative === undefined) continue;
    const sources = [...new Set(candidates.map((candidate) => candidate.bookId))];
    combined.push(localOrder(representative.order, digest, sources));
  }

  const primary = snapshots.find((snapshot) => snapshot.bookId === PRIMARY_ORDERBOOK_ID);
  if (primary !== undefined) {
    for (const order of primary.orders) {
      if (typeof order !== "object" || order === null || Array.isArray(order)) continue;
      if (
        order.makerAuth !== undefined ||
        order.visibility === "private" ||
        signedIds.has(order.id) ||
        quarantinedIds.has(order.id)
      ) {
        continue;
      }
      combined.push(localOrder(order, undefined, [PRIMARY_ORDERBOOK_ID]));
    }
  }

  combined.sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
      left.id.localeCompare(right.id) ||
      (left.orderDigest ?? "").localeCompare(right.orderDigest ?? ""),
  );
  return {
    orders: combined,
    quarantinedIds: [...quarantinedIds].sort(),
  };
}

export function authenticateDirectOrder(order: OrderView, bookId: string): OrderView {
  if (order.makerAuth === undefined) {
    if (bookId !== PRIMARY_ORDERBOOK_ID && order.visibility !== "private") {
      throw new Error("unsigned public orders are available from the primary book only");
    }
    return localOrder(order, undefined, [bookId]);
  }
  if (!verifyOrderV1Auth(order)) throw new Error("order has an invalid portable maker proof");
  const digest = portableOrderDigest(order);
  return localOrder(order, digest, [bookId]);
}

export class FederatedOrderBook {
  private readonly clients: readonly OrderbookClient[];
  private readonly clientsById: ReadonlyMap<string, OrderbookClient>;
  private readonly snapshots = new Map<string, readonly OrderView[]>();
  private readonly retainedQuarantines: QuarantineMap;
  private readonly quarantineStorage: QuarantineStorage | null;
  private readonly aggregationOptions: MirrorAggregationOptions;

  constructor(
    mirrors: readonly OrderbookMirror[],
    optionsForMirror?: (mirror: OrderbookMirror) => OrderbookClientOptions,
    quarantineStorage: QuarantineStorage | null = browserStorage(),
    aggregationOptions: MirrorAggregationOptions = {},
    quarantineEvents: QuarantineEventSource | null = browserQuarantineEvents(),
  ) {
    this.clients = mirrors.map(
      (mirror) => new OrderbookClient(mirror, optionsForMirror?.(mirror)),
    );
    this.clientsById = new Map(this.clients.map((client) => [client.bookId, client]));
    this.quarantineStorage = quarantineStorage;
    this.retainedQuarantines = saveQuarantines(
      quarantineStorage,
      loadQuarantines(quarantineStorage),
    );
    this.aggregationOptions = aggregationOptions;
    quarantineEvents?.addEventListener("storage", (event) => {
      if (event.key !== null && event.key !== QUARANTINE_STORAGE_KEY) return;
      this.mergeRetainedQuarantines(loadQuarantines(this.quarantineStorage));
    });
    if (!this.clientsById.has(PRIMARY_ORDERBOOK_ID)) {
      throw new Error("the federated order book requires a primary origin");
    }
  }

  private mergeRetainedQuarantines(incoming: ReadonlyMap<string, number>): void {
    const merged = new Map(this.retainedQuarantines);
    incoming.forEach((observedAt, id) =>
      merged.set(id, Math.max(merged.get(id) ?? 0, observedAt)),
    );
    const retained = pruneQuarantines(merged);
    this.retainedQuarantines.clear();
    retained.forEach((observedAt, id) =>
      this.retainedQuarantines.set(id, observedAt),
    );
  }

  client(bookId = PRIMARY_ORDERBOOK_ID): OrderbookClient {
    const client = this.clientsById.get(bookId);
    if (client === undefined) throw new Error(`unknown order book origin: ${bookId}`);
    return client;
  }

  current(): MirrorBookResult {
    const observedAt = Date.now();
    this.mergeRetainedQuarantines(loadQuarantines(this.quarantineStorage, observedAt));
    const result = aggregateMirrorOrders(
      this.clients.flatMap((client) => {
        const orders = this.snapshots.get(client.bookId);
        return orders === undefined ? [] : [{ bookId: client.bookId, orders }];
      }),
      this.aggregationOptions,
    );
    let changed = false;
    result.quarantinedIds.forEach((id) => {
      if (!this.retainedQuarantines.has(id)) {
        this.retainedQuarantines.set(id, observedAt);
        changed = true;
      }
    });
    if (changed) {
      this.mergeRetainedQuarantines(
        saveQuarantines(
          this.quarantineStorage,
          this.retainedQuarantines,
          observedAt,
        ),
      );
    }
    return {
      orders: result.orders.filter((order) => !this.retainedQuarantines.has(order.id)),
      quarantinedIds: [...this.retainedQuarantines.keys()].sort(),
    };
  }

  async refresh(): Promise<MirrorBookResult> {
    const results = await Promise.allSettled(this.clients.map((client) => client.list()));
    let available = 0;
    results.forEach((result, index) => {
      const client = this.clients[index];
      if (client === undefined) return;
      if (result.status === "fulfilled" && Array.isArray(result.value)) {
        this.snapshots.set(client.bookId, result.value);
        available += 1;
      } else {
        this.snapshots.delete(client.bookId);
      }
    });
    if (available === 0) throw new Error("all configured order book origins are unavailable");
    return this.current();
  }

  subscribe(onBook: (orders: OrderView[]) => void): OrderbookEventStream {
    const streams = this.clients.flatMap((client) => {
      try {
        return [
          client.openBookStream((orders) => {
            this.snapshots.set(client.bookId, orders);
            onBook(this.current().orders);
          }),
        ];
      } catch {
        return [];
      }
    });
    return {
      isLive: () => streams.some((stream) => stream.isLive()),
      close: () => streams.forEach((stream) => stream.close()),
    };
  }
}

export const federatedOrderBook = new FederatedOrderBook(ORDERBOOK_MIRRORS);
