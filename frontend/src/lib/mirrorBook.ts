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

export type MirrorAvailability = "checking" | "available" | "unavailable";
export type MirrorStreamState = "connecting" | "open" | "closed";

export interface MirrorStatus {
  bookId: string;
  availability: MirrorAvailability;
  stream: MirrorStreamState;
  lastSuccessAt: number | null;
}

export interface AggregatedMirrorOrders {
  orders: OrderView[];
  quarantinedIds: string[];
}

interface MirrorAggregationScan extends AggregatedMirrorOrders {
  invalidBookIds: string[];
}

export interface MirrorBookResult extends AggregatedMirrorOrders {
  mirrors: MirrorStatus[];
}

export type MirrorDiscoveryState = "checking" | "all" | "partial" | "unavailable";

export interface MirrorAvailabilitySummary {
  state: MirrorDiscoveryState;
  available: number;
  checking: number;
  total: number;
}

export function summarizeMirrorAvailability(
  mirrors: readonly MirrorStatus[],
): MirrorAvailabilitySummary {
  const total = mirrors.length;
  const available = mirrors.filter(
    (mirror) => mirror.availability === "available",
  ).length;
  const checking = mirrors.filter(
    (mirror) => mirror.availability === "checking",
  ).length;
  const state: MirrorDiscoveryState =
    total > 0 && available === total
      ? "all"
      : available > 0
        ? "partial"
        : checking > 0
          ? "checking"
          : "unavailable";
  return { state, available, checking, total };
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
const MAX_VERIFIED_PROOFS = 1024;
const MIRROR_RETRY_BASE_MS = 10_000;
const MIRROR_RETRY_MAX_MS = 5 * 60 * 1000;

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

interface VerifiedProofCacheEntry {
  digest: string;
  expiresAt: number;
  verifiedAt: number;
}

interface MirrorRetryState {
  failures: number;
  nextAttemptAt: number;
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

function signedProofCacheKey(order: OrderView): string {
  if (order.makerAuth === undefined) throw new Error("order has no portable proof");
  return JSON.stringify([order.id, signedOrderBody(order), order.makerAuth]);
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
): MirrorAggregationScan {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const verifyOrder = options.verifyOrder ?? verifyOrderV1Auth;
  const digestOrder = options.digestOrder ?? portableOrderDigest;
  const invalidBookIds = new Set<string>();
  const verifiedDigests = new Map<OrderView, string>();
  const validSnapshots = snapshots.filter((snapshot) => {
    for (const order of snapshot.orders) {
      if (
        typeof order !== "object" ||
        order === null ||
        Array.isArray(order) ||
        order.status !== "open" ||
        order.visibility === "private"
      ) {
        invalidBookIds.add(snapshot.bookId);
        return false;
      }
      if (order.makerAuth === undefined) {
        if (snapshot.bookId !== PRIMARY_ORDERBOOK_ID) {
          invalidBookIds.add(snapshot.bookId);
          return false;
        }
        continue;
      }
      if (!verifyOrder(order, now)) {
        invalidBookIds.add(snapshot.bookId);
        return false;
      }
      try {
        verifiedDigests.set(order, digestOrder(order));
      } catch {
        invalidBookIds.add(snapshot.bookId);
        return false;
      }
    }
    return true;
  });
  const signed = new Map<string, Map<string, SignedCandidate[]>>();
  const signedIds = new Set<string>();

  for (const snapshot of validSnapshots) {
    for (const order of snapshot.orders) {
      if (order.makerAuth === undefined) continue;
      const digest = verifiedDigests.get(order);
      if (digest === undefined) continue;
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

  const primary = validSnapshots.find(
    (snapshot) => snapshot.bookId === PRIMARY_ORDERBOOK_ID,
  );
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
    invalidBookIds: [...invalidBookIds].sort(),
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
  private readonly mirrorStatuses: Map<string, MirrorStatus>;
  private readonly mirrorGenerations = new Map<string, number>();
  private readonly mirrorRetries = new Map<string, MirrorRetryState>();
  private readonly verifiedProofs = new Map<string, VerifiedProofCacheEntry>();
  private readonly inFlightRefreshes = new Map<string, Promise<void>>();
  private readonly subscribers = new Set<(result: MirrorBookResult) => void>();
  private readonly retainedQuarantines: QuarantineMap;
  private readonly quarantineStorage: QuarantineStorage | null;
  private readonly aggregationOptions: MirrorAggregationOptions;

  constructor(
    mirrors: readonly OrderbookMirror[],
    optionsForMirror?: (mirror: OrderbookMirror) => OrderbookClientOptions,
    quarantineStorage: QuarantineStorage | null = browserStorage(),
    aggregationOptions: MirrorAggregationOptions = {},
    quarantineEvents: QuarantineEventSource | null = browserQuarantineEvents(),
    private readonly now: () => number = Date.now,
  ) {
    this.clients = mirrors.map(
      (mirror) => new OrderbookClient(mirror, optionsForMirror?.(mirror)),
    );
    this.clientsById = new Map(this.clients.map((client) => [client.bookId, client]));
    this.mirrorStatuses = new Map(
      this.clients.map((client) => [
        client.bookId,
        {
          bookId: client.bookId,
          availability: "checking",
          stream: "closed",
          lastSuccessAt: null,
        },
      ]),
    );
    this.clients.forEach((client) => this.mirrorGenerations.set(client.bookId, 0));
    this.clients.forEach((client) =>
      this.mirrorRetries.set(client.bookId, { failures: 0, nextAttemptAt: 0 }),
    );
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

  private status(bookId: string): MirrorStatus {
    const status = this.mirrorStatuses.get(bookId);
    if (status === undefined) throw new Error(`unknown order book origin: ${bookId}`);
    return status;
  }

  private updateStatus(
    bookId: string,
    update: Partial<Omit<MirrorStatus, "bookId">>,
  ): void {
    this.mirrorStatuses.set(bookId, { ...this.status(bookId), ...update });
  }

  private retry(bookId: string): MirrorRetryState {
    const retry = this.mirrorRetries.get(bookId);
    if (retry === undefined) throw new Error(`unknown order book origin: ${bookId}`);
    return retry;
  }

  private markAvailable(bookId: string, successfulAt: number): void {
    this.mirrorRetries.set(bookId, { failures: 0, nextAttemptAt: 0 });
    this.updateStatus(bookId, {
      availability: "available",
      lastSuccessAt: successfulAt,
    });
  }

  private markUnavailable(bookId: string): void {
    this.snapshots.delete(bookId);
    this.updateStatus(bookId, { availability: "unavailable" });
    const failures = Math.min(this.retry(bookId).failures + 1, 31);
    const delay = Math.min(
      MIRROR_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1),
      MIRROR_RETRY_MAX_MS,
    );
    this.mirrorRetries.set(bookId, {
      failures,
      nextAttemptAt: this.now() + delay,
    });
  }

  private generation(bookId: string): number {
    const generation = this.mirrorGenerations.get(bookId);
    if (generation === undefined) throw new Error(`unknown order book origin: ${bookId}`);
    return generation;
  }

  private nextGeneration(bookId: string): number {
    const generation = this.generation(bookId) + 1;
    this.mirrorGenerations.set(bookId, generation);
    return generation;
  }

  private emit(): MirrorBookResult {
    const result = this.current();
    this.subscribers.forEach((subscriber) => {
      try {
        subscriber(result);
      } catch {
        // A rendering failure in one subscriber must not stop mirror recovery.
      }
    });
    return result;
  }

  private aggregate(snapshots: readonly MirrorSnapshot[]): MirrorAggregationScan {
    const verifyOrder = this.aggregationOptions.verifyOrder ?? verifyOrderV1Auth;
    const digestOrder = this.aggregationOptions.digestOrder ?? portableOrderDigest;
    const now = this.aggregationOptions.now ?? Math.floor(this.now() / 1000);
    for (const [key, entry] of this.verifiedProofs) {
      if (entry.expiresAt <= now || entry.verifiedAt > now) {
        this.verifiedProofs.delete(key);
      }
    }
    const cacheKeyByOrder = new Map<OrderView, string>();
    return aggregateMirrorOrders(snapshots, {
      now,
      verifyOrder: (order, observedNow) => {
        let key: string;
        try {
          key = signedProofCacheKey(order);
        } catch {
          return false;
        }
        cacheKeyByOrder.set(order, key);
        const cached = this.verifiedProofs.get(key);
        if (
          cached !== undefined &&
          cached.verifiedAt <= observedNow &&
          cached.expiresAt > observedNow
        ) {
          return true;
        }
        if (!verifyOrder(order, observedNow)) return false;
        let digest: string;
        try {
          digest = digestOrder(order);
        } catch {
          return false;
        }
        if (this.verifiedProofs.size >= MAX_VERIFIED_PROOFS) {
          const oldest = this.verifiedProofs.keys().next().value as string | undefined;
          if (oldest !== undefined) this.verifiedProofs.delete(oldest);
        }
        this.verifiedProofs.set(key, {
          digest,
          expiresAt: order.makerAuth?.expiresAt ?? observedNow,
          verifiedAt: observedNow,
        });
        return true;
      },
      digestOrder: (order) => {
        const key = cacheKeyByOrder.get(order) ?? signedProofCacheKey(order);
        const cached = this.verifiedProofs.get(key);
        return cached?.digest ?? digestOrder(order);
      },
    });
  }

  private acceptsSnapshot(bookId: string, orders: readonly OrderView[]): boolean {
    return !this.aggregate([{ bookId, orders }]).invalidBookIds.includes(bookId);
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
    const observedAt = this.now();
    this.mergeRetainedQuarantines(loadQuarantines(this.quarantineStorage, observedAt));
    const snapshots = this.clients.flatMap((client) => {
      if (this.status(client.bookId).availability !== "available") return [];
      const orders = this.snapshots.get(client.bookId);
      return orders === undefined ? [] : [{ bookId: client.bookId, orders }];
    });
    let result = this.aggregate(snapshots);
    if (result.invalidBookIds.length > 0) {
      const invalid = new Set(result.invalidBookIds);
      invalid.forEach((bookId) => this.markUnavailable(bookId));
      result = this.aggregate(
        snapshots.filter((snapshot) => !invalid.has(snapshot.bookId)),
      );
    }
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
      mirrors: this.clients.map((client) => ({ ...this.status(client.bookId) })),
    };
  }

  private async refreshClients(
    clients: readonly OrderbookClient[],
  ): Promise<MirrorBookResult> {
    const requests = clients.map((client) => {
      const existing = this.inFlightRefreshes.get(client.bookId);
      if (existing !== undefined) return existing;
      const generation = this.nextGeneration(client.bookId);
      let request: Promise<void>;
      request = client
        .list()
        .then((orders) => {
          if (this.generation(client.bookId) !== generation) return;
          if (!this.acceptsSnapshot(client.bookId, orders)) {
            this.markUnavailable(client.bookId);
            return;
          }
          this.snapshots.set(client.bookId, orders);
          this.markAvailable(client.bookId, this.now());
        })
        .catch(() => {
          if (this.generation(client.bookId) === generation) {
            this.markUnavailable(client.bookId);
          }
        })
        .finally(() => {
          if (this.inFlightRefreshes.get(client.bookId) === request) {
            this.inFlightRefreshes.delete(client.bookId);
          }
        });
      this.inFlightRefreshes.set(client.bookId, request);
      return request;
    });
    this.emit();
    await Promise.all(requests);
    return this.emit();
  }

  async refresh(): Promise<MirrorBookResult> {
    return this.refreshClients(this.clients);
  }

  async refreshDisconnected(): Promise<MirrorBookResult> {
    const now = this.now();
    const disconnected = this.clients.filter(
      (client) => {
        const status = this.status(client.bookId);
        if (
          status.availability === "unavailable" &&
          this.retry(client.bookId).nextAttemptAt > now
        ) {
          return false;
        }
        return status.stream !== "open" || status.availability !== "available";
      },
    );
    return disconnected.length === 0
      ? this.current()
      : this.refreshClients(disconnected);
  }

  routeSignedOrder(order: OrderView): OrderView {
    if (order.makerAuth === undefined) {
      throw new Error("only portable signed orders can be routed across mirrors");
    }
    if (order.visibility === "private") {
      return {
        ...order,
        bookId: order.bookId ?? PRIMARY_ORDERBOOK_ID,
        sources: [order.bookId ?? PRIMARY_ORDERBOOK_ID],
      };
    }

    const digest = order.orderDigest ?? portableOrderDigest(order);
    const current = this.current().orders.find(
      (candidate) =>
        candidate.id === order.id &&
        candidate.makerAuth !== undefined &&
        candidate.orderDigest === digest,
    );
    if (current === undefined) {
      throw new Error("No available mirror currently serves this signed order.");
    }
    const availableSources = (current.sources ?? []).filter(
      (bookId) => this.status(bookId).availability === "available",
    );
    const fallback = availableSources[0];
    if (fallback === undefined) {
      throw new Error("No available mirror currently serves this signed order.");
    }
    const preferred =
      order.bookId !== undefined && availableSources.includes(order.bookId)
        ? order.bookId
        : current.bookId !== undefined && availableSources.includes(current.bookId)
          ? current.bookId
          : fallback;
    return { ...current, bookId: preferred, sources: availableSources };
  }

  subscribe(onBook: (result: MirrorBookResult) => void): OrderbookEventStream {
    let active = true;
    this.subscribers.add(onBook);
    // Native EventSource buffers a complete event before application code can
    // enforce a byte limit. Keep SSE on the trusted same-origin primary and
    // use the bounded HTTP snapshot parser for independent mirrors.
    const streamClients = this.clients.filter(
      (client) => client.bookId === PRIMARY_ORDERBOOK_ID,
    );
    const streams = streamClients.flatMap((client) => {
      this.updateStatus(client.bookId, {
        stream: "connecting",
        ...(this.status(client.bookId).availability === "unavailable"
          ? { availability: "checking" as const }
          : {}),
      });
      try {
        return [
          client.openBookStream(
            (orders) => {
              if (!active) return;
              this.nextGeneration(client.bookId);
              if (!this.acceptsSnapshot(client.bookId, orders)) {
                this.markUnavailable(client.bookId);
                this.updateStatus(client.bookId, { stream: "closed" });
                this.emit();
                return;
              }
              this.snapshots.set(client.bookId, orders);
              this.markAvailable(client.bookId, this.now());
              this.updateStatus(client.bookId, { stream: "open" });
              this.emit();
            },
            {
              onOpen: () => {
                if (!active) return;
                this.updateStatus(client.bookId, { stream: "open" });
                this.emit();
              },
              onClose: () => {
                if (!active) return;
                this.nextGeneration(client.bookId);
                this.markUnavailable(client.bookId);
                this.updateStatus(client.bookId, { stream: "closed" });
                this.emit();
              },
              onInvalid: () => {
                if (!active) return;
                this.emit();
              },
            },
          ),
        ];
      } catch {
        this.nextGeneration(client.bookId);
        this.markUnavailable(client.bookId);
        this.updateStatus(client.bookId, { stream: "closed" });
        return [];
      }
    });
    this.emit();
    return {
      isLive: () => streams.some((stream) => stream.isLive()),
      close: () => {
        if (!active) return;
        active = false;
        this.subscribers.delete(onBook);
        streams.forEach((stream) => stream.close());
        this.clients.forEach((client) => {
          this.nextGeneration(client.bookId);
          this.inFlightRefreshes.delete(client.bookId);
          this.markUnavailable(client.bookId);
          this.updateStatus(client.bookId, { stream: "closed" });
        });
        if (this.subscribers.size > 0) this.emit();
      },
    };
  }
}

export const federatedOrderBook = new FederatedOrderBook(ORDERBOOK_MIRRORS);
