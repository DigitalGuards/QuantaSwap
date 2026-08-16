import { describe, expect, it, vi } from "vitest";
import type { MakerOrderAuthV1, OrderView } from "./orderbook";
import {
  FederatedOrderBook,
  aggregateMirrorOrders,
  summarizeMirrorAvailability,
  type MirrorSnapshot,
} from "./mirrorBook";
import type { EventSourcePort } from "./orderbookClient";

const DIGEST_A = `0x${"aa".repeat(32)}`;
const DIGEST_B = `0x${"bb".repeat(32)}`;

const auth = (signature = "valid"): MakerOrderAuthV1 => ({
  version: "1",
  scheme: "qrl-sign-typed-v1",
  issuedAt: 10,
  expiresAt: 20,
  nonce: `0x${"11".repeat(32)}`,
  makerTokenCommitment: `0x${"22".repeat(32)}`,
  shareTokenCommitment: `0x${"00".repeat(32)}`,
  signature,
  publicKey: "key",
  descriptor: "descriptor",
});

const row = (overrides: Partial<OrderView> = {}): OrderView => ({
  id: "order-a",
  direction: "eth->qrl",
  asset: "ETH",
  fromAmount: "1",
  toAmount: "2",
  makerEthAccount: `0x${"22".repeat(20)}`,
  makerQrlAccount: `Q${"33".repeat(20)}`,
  status: "open",
  takerEthAccount: null,
  takerQrlAccount: null,
  hashlock: null,
  initiatorTimeout: null,
  responderTimeout: null,
  visibility: "public",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const verify = (order: OrderView): boolean => order.makerAuth?.signature === "valid";
const digest = (order: OrderView): string =>
  order.fromAmount === "1" ? DIGEST_A : DIGEST_B;

const listResponse = (orders: readonly OrderView[]): Response =>
  new Response(JSON.stringify({ orders }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

function streamHarness(): {
  eventSource: (url: string) => EventSourcePort;
  open: (url: string) => void;
  error: (url: string) => void;
  book: (url: string, orders: readonly OrderView[]) => void;
  invalid: (url: string) => void;
} {
  const listeners = new Map<
    string,
    Map<string, (event: MessageEvent<string>) => void>
  >();
  const states = new Map<string, number>();
  const emit = (url: string, type: string, data = "") => {
    listeners.get(url)?.get(type)?.({ data } as MessageEvent<string>);
  };
  return {
    eventSource: (url) => {
      states.set(url, 0);
      return {
        get readyState() {
          return states.get(url) ?? 2;
        },
        addEventListener: (type, listener) => {
          const byType = listeners.get(url) ?? new Map();
          byType.set(type, listener);
          listeners.set(url, byType);
        },
        close: () => {
          states.set(url, 2);
        },
      };
    },
    open: (url) => {
      states.set(url, 1);
      emit(url, "open");
    },
    error: (url) => {
      states.set(url, 0);
      emit(url, "error");
    },
    book: (url, orders) => {
      emit(url, "book", JSON.stringify({ orders }));
    },
    invalid: (url) => {
      emit(url, "book", "{");
    },
  };
}

describe("mirror snapshot aggregation", () => {
  it("combines authenticated copies and keeps unsigned liquidity primary-only", () => {
    const portable = row({ makerAuth: auth(), orderDigest: DIGEST_A });
    const unsigned = row({ id: "primary-unsigned", createdAt: 2 });
    const snapshots: MirrorSnapshot[] = [
      {
        bookId: "primary",
        orders: [portable, unsigned],
      },
      {
        bookId: "community",
        orders: [{ ...portable, updatedAt: 3 }],
      },
    ];

    const result = aggregateMirrorOrders(snapshots, {
      now: 15,
      verifyOrder: verify,
      digestOrder: digest,
    });

    expect(result.quarantinedIds).toEqual([]);
    expect(result.invalidBookIds).toEqual([]);
    expect(result.orders.map((order) => order.id)).toEqual([
      "order-a",
      "primary-unsigned",
    ]);
    expect(result.orders[0]).toMatchObject({
      orderDigest: DIGEST_A,
      bookId: "primary",
      sources: ["primary", "community"],
    });
    expect(result.orders[1]).toMatchObject({
      bookId: "primary",
      sources: ["primary"],
    });
  });

  it("quarantines every authentic variant when one id has two signed digests", () => {
    const snapshots: MirrorSnapshot[] = [
      {
        bookId: "primary",
        orders: [row({ id: "conflict", makerAuth: auth(), orderDigest: DIGEST_A })],
      },
      {
        bookId: "community",
        orders: [
          row({
            id: "conflict",
            fromAmount: "3",
            makerAuth: auth(),
            orderDigest: DIGEST_B,
          }),
        ],
      },
    ];

    const result = aggregateMirrorOrders(snapshots, {
      verifyOrder: verify,
      digestOrder: digest,
    });
    expect(result.orders).toEqual([]);
    expect(result.quarantinedIds).toEqual(["conflict"]);
  });

  it("replaces an advertised digest with the digest recomputed from the proof", () => {
    const result = aggregateMirrorOrders(
      [
        {
          bookId: "community",
          orders: [row({ makerAuth: auth(), orderDigest: DIGEST_B })],
        },
      ],
      { verifyOrder: verify, digestOrder: digest },
    );
    expect(result).toMatchObject({
      orders: [{ id: "order-a", orderDigest: DIGEST_A, bookId: "community" }],
      quarantinedIds: [],
    });
  });

  it("invalidates malformed mirror rows without suppressing a healthy primary", () => {
    const healthy = row({ id: "healthy-primary" });
    const result = aggregateMirrorOrders(
      [
        { bookId: "primary", orders: [healthy] },
        {
          bookId: "community",
          orders: [null, { direction: "sideways" }] as unknown as OrderView[],
        },
      ],
      { verifyOrder: verify, digestOrder: digest },
    );

    expect(result.orders).toEqual([
      expect.objectContaining({ id: "healthy-primary", bookId: "primary" }),
    ]);
    expect(result.quarantinedIds).toEqual([]);
    expect(result.invalidBookIds).toEqual(["community"]);
  });
});

describe("federated snapshot and SSE transport", () => {
  it("polls and subscribes every origin while exposing primary unsigned rows only", async () => {
    const primaryOrder = row({ id: "primary-one" });
    const updatedOrder = row({ id: "primary-two", createdAt: 2 });
    const listeners = new Map<string, (event: MessageEvent<string>) => void>();
    const closed: string[] = [];
    const requests: string[] = [];
    const book = new FederatedOrderBook(
      [
        { id: "primary", apiBase: "/api" },
        { id: "community", apiBase: "https://mirror.test/api" },
      ],
      (mirror) => ({
        fetch: async (input) => {
          requests.push(String(input));
          const orders = mirror.id === "primary" ? [primaryOrder] : [row({ id: "ignored" })];
          return new Response(JSON.stringify({ orders }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
        eventSource: (url): EventSourcePort => ({
          readyState: 1,
          addEventListener: (_type, listener) => {
            listeners.set(url, listener);
          },
          close: () => {
            closed.push(url);
          },
        }),
      }),
    );

    await expect(book.refresh()).resolves.toMatchObject({
      orders: [{ id: "primary-one", bookId: "primary", sources: ["primary"] }],
    });
    expect(requests).toEqual(["/api/orders", "https://mirror.test/api/orders"]);

    const onBook = vi.fn();
    const stream = book.subscribe(onBook);
    expect([...listeners.keys()]).toEqual(["/api/orders/stream"]);
    listeners.get("/api/orders/stream")?.({
      data: JSON.stringify({ orders: [updatedOrder] }),
    } as MessageEvent<string>);
    expect(onBook).toHaveBeenLastCalledWith(
      expect.objectContaining({
        orders: [expect.objectContaining({ id: "primary-two", bookId: "primary" })],
      }),
    );
    expect(stream.isLive()).toBe(true);
    stream.close();
    expect(closed).toHaveLength(1);
  });

  it("does not let a slow poll overwrite a newer SSE snapshot", async () => {
    const portable = row({ id: "ad".repeat(32), makerAuth: auth() });
    const streams = streamHarness();
    let resolvePoll: ((response: Response) => void) | undefined;
    const book = new FederatedOrderBook(
      [{ id: "primary", apiBase: "/api" }],
      () => ({
        fetch: async () =>
          new Promise<Response>((resolve) => {
            resolvePoll = resolve;
          }),
        eventSource: streams.eventSource,
      }),
      null,
      { verifyOrder: verify, digestOrder: digest },
      null,
    );

    const refresh = book.refresh();
    const subscription = book.subscribe(vi.fn());
    streams.open("/api/orders/stream");
    streams.book("/api/orders/stream", []);
    resolvePoll?.(listResponse([portable]));

    await refresh;
    expect(book.current()).toMatchObject({
      orders: [],
      mirrors: [
        expect.objectContaining({
          bookId: "primary",
          availability: "available",
          stream: "open",
        }),
      ],
    });
    expect(() => book.routeSignedOrder(portable)).toThrow(/No available mirror/);
    subscription.close();
  });

  it("starts a fresh poll after a subscription closes during an in-flight refresh", async () => {
    const portable = row({ id: "strict-mode-order" });
    const streams = streamHarness();
    const pending: Array<(response: Response) => void> = [];
    const book = new FederatedOrderBook(
      [{ id: "primary", apiBase: "/api" }],
      () => ({
        fetch: async () =>
          new Promise<Response>((resolve) => {
            pending.push(resolve);
          }),
        eventSource: streams.eventSource,
      }),
    );

    const firstSubscription = book.subscribe(vi.fn());
    const firstRefresh = book.refresh();
    expect(pending).toHaveLength(1);
    firstSubscription.close();

    const secondSubscription = book.subscribe(vi.fn());
    const secondRefresh = book.refresh();
    expect(pending).toHaveLength(2);

    pending[0]?.(listResponse([row({ id: "stale-order" })]));
    await firstRefresh;
    expect(book.current().orders).toEqual([]);

    pending[1]?.(listResponse([portable]));
    await secondRefresh;
    expect(book.current()).toMatchObject({
      orders: [expect.objectContaining({ id: portable.id })],
      mirrors: [expect.objectContaining({ availability: "available" })],
    });
    secondSubscription.close();
  });

  it("marks only an HTTP mirror with an invalid proof unavailable", async () => {
    const portable = row({ id: "ae".repeat(32), makerAuth: auth() });
    const book = new FederatedOrderBook(
      [
        { id: "primary", apiBase: "/api" },
        { id: "community", apiBase: "https://mirror.test/api" },
      ],
      (mirror) => ({
        fetch: async () =>
          listResponse([
            mirror.id === "primary"
              ? portable
              : { ...portable, makerAuth: auth("invalid") },
          ]),
      }),
      null,
      { verifyOrder: verify, digestOrder: digest },
      null,
    );

    await expect(book.refresh()).resolves.toMatchObject({
      orders: [expect.objectContaining({ bookId: "primary", sources: ["primary"] })],
      mirrors: [
        expect.objectContaining({ bookId: "primary", availability: "available" }),
        expect.objectContaining({ bookId: "community", availability: "unavailable" }),
      ],
    });
  });

  it("caches an identical verified proof across mirrors and recovery polls", async () => {
    const portable = row({ id: "be".repeat(32), makerAuth: auth() });
    const verifyCached = vi.fn(verify);
    const book = new FederatedOrderBook(
      [
        { id: "primary", apiBase: "/api" },
        { id: "community", apiBase: "https://mirror.test/api" },
      ],
      () => ({ fetch: async () => listResponse([{ ...portable }]) }),
      null,
      { now: 15, verifyOrder: verifyCached, digestOrder: digest },
      null,
    );

    await book.refresh();
    await book.refresh();
    expect(verifyCached).toHaveBeenCalledTimes(1);
    expect(book.current().orders).toEqual([
      expect.objectContaining({ sources: ["primary", "community"] }),
    ]);
  });

  it("does not reuse a verified proof for a different advertised order id", async () => {
    const portable = row({ id: "valid-id", makerAuth: auth() });
    const verifyBoundId = vi.fn((order: OrderView) => order.id === portable.id);
    const book = new FederatedOrderBook(
      [
        { id: "primary", apiBase: "/api" },
        { id: "community", apiBase: "https://mirror.test/api" },
      ],
      (mirror) => ({
        fetch: async () =>
          listResponse([
            mirror.id === "primary" ? portable : { ...portable, id: "tampered-id" },
          ]),
      }),
      null,
      { now: 15, verifyOrder: verifyBoundId, digestOrder: digest },
      null,
    );

    await expect(book.refresh()).resolves.toMatchObject({
      orders: [expect.objectContaining({ id: "valid-id", sources: ["primary"] })],
      mirrors: [
        expect.objectContaining({ bookId: "primary", availability: "available" }),
        expect.objectContaining({ bookId: "community", availability: "unavailable" }),
      ],
    });
    expect(verifyBoundId).toHaveBeenCalledTimes(2);
  });

  it("backs off invalid mirrors and coalesces an overlapping recovery poll", async () => {
    const invalid = row({ id: "bf".repeat(32), makerAuth: auth("invalid") });
    const streams = streamHarness();
    let now = 1_000;
    let communityCalls = 0;
    let finishRetry: ((response: Response) => void) | undefined;
    const book = new FederatedOrderBook(
      [
        { id: "primary", apiBase: "/api" },
        { id: "community", apiBase: "https://mirror.test/api" },
      ],
      (mirror) => ({
        fetch: async () => {
          if (mirror.id === "primary") return listResponse([]);
          communityCalls += 1;
          if (communityCalls === 1) return listResponse([invalid]);
          return new Promise<Response>((resolve) => {
            finishRetry = resolve;
          });
        },
        eventSource: streams.eventSource,
      }),
      null,
      { now: 15, verifyOrder: verify, digestOrder: digest },
      null,
      () => now,
    );

    await book.refresh();
    const subscription = book.subscribe(vi.fn());
    streams.open("/api/orders/stream");
    streams.book("/api/orders/stream", []);
    expect(communityCalls).toBe(1);

    await book.refreshDisconnected();
    now += 9_999;
    await book.refreshDisconnected();
    expect(communityCalls).toBe(1);

    now += 1;
    const firstRetry = book.refreshDisconnected();
    const overlappingRetry = book.refreshDisconnected();
    expect(communityCalls).toBe(2);
    finishRetry?.(listResponse([invalid]));
    await Promise.all([firstRetry, overlappingRetry]);
    expect(communityCalls).toBe(2);
    expect(book.current().mirrors[1]).toMatchObject({
      availability: "unavailable",
      lastSuccessAt: null,
    });
    subscription.close();
  });

  it("drops an invalid primary SSE proof while retaining an HTTP mirror", async () => {
    const portable = row({ id: "af".repeat(32), makerAuth: auth() });
    const streams = streamHarness();
    const book = new FederatedOrderBook(
      [
        { id: "primary", apiBase: "/api" },
        { id: "community", apiBase: "https://mirror.test/api" },
      ],
      () => ({
        fetch: async () => listResponse([portable]),
        eventSource: streams.eventSource,
      }),
      null,
      { verifyOrder: verify, digestOrder: digest },
      null,
    );
    await book.refresh();
    const subscription = book.subscribe(vi.fn());
    streams.open("/api/orders/stream");
    streams.book("/api/orders/stream", [
      { ...portable, makerAuth: auth("invalid") },
    ]);

    expect(book.current()).toMatchObject({
      orders: [
        expect.objectContaining({ bookId: "community", sources: ["community"] }),
      ],
      mirrors: [
        expect.objectContaining({ bookId: "primary", availability: "unavailable" }),
        expect.objectContaining({ bookId: "community", availability: "available" }),
      ],
    });
    subscription.close();
  });

  it("removes a failed SSE mirror immediately and reroutes its signed row", async () => {
    const portable = row({ id: "ab".repeat(32), makerAuth: auth() });
    const streams = streamHarness();
    const book = new FederatedOrderBook(
      [
        { id: "primary", apiBase: "/api" },
        { id: "community", apiBase: "https://mirror.test/api" },
      ],
      () => ({
        fetch: async () => listResponse([portable]),
        eventSource: streams.eventSource,
      }),
      null,
      { verifyOrder: verify, digestOrder: digest },
      null,
    );
    const initial = await book.refresh();
    const selected = initial.orders[0];
    expect(selected).toMatchObject({
      bookId: "primary",
      sources: ["primary", "community"],
    });

    const onBook = vi.fn();
    const subscription = book.subscribe(onBook);
    streams.open("/api/orders/stream");
    streams.error("/api/orders/stream");

    const latest = onBook.mock.lastCall?.[0];
    expect(latest).toMatchObject({
      orders: [
        expect.objectContaining({
          id: portable.id,
          bookId: "community",
          sources: ["community"],
        }),
      ],
      mirrors: [
        {
          bookId: "primary",
          availability: "unavailable",
          stream: "closed",
          lastSuccessAt: expect.any(Number),
        },
        {
          bookId: "community",
          availability: "available",
          stream: "closed",
          lastSuccessAt: expect.any(Number),
        },
      ],
    });
    expect(subscription.isLive()).toBe(false);
    expect(book.routeSignedOrder(selected!)).toMatchObject({
      bookId: "community",
      sources: ["community"],
    });
    subscription.close();
  });

  it("polls independent mirrors while the primary stream remains open", async () => {
    const portable = row({ id: "bc".repeat(32), makerAuth: auth() });
    const streams = streamHarness();
    const requests = new Map<string, number>();
    let now = 1_000;
    const book = new FederatedOrderBook(
      [
        { id: "primary", apiBase: "/api" },
        { id: "community", apiBase: "https://mirror.test/api" },
      ],
      (mirror) => ({
        fetch: async () => {
          requests.set(mirror.id, (requests.get(mirror.id) ?? 0) + 1);
          return listResponse([portable]);
        },
        eventSource: streams.eventSource,
      }),
      null,
      { verifyOrder: verify, digestOrder: digest },
      null,
      () => now,
    );
    await book.refresh();
    const subscription = book.subscribe(vi.fn());
    streams.open("/api/orders/stream");

    const recovered = await book.refreshDisconnected();
    expect(requests.get("primary")).toBe(1);
    expect(requests.get("community")).toBe(2);
    expect(recovered.mirrors).toEqual([
      expect.objectContaining({
        bookId: "primary",
        availability: "available",
        stream: "open",
      }),
      expect.objectContaining({
        bookId: "community",
        availability: "available",
        stream: "closed",
      }),
    ]);

    await book.refreshDisconnected();
    expect(requests.get("primary")).toBe(1);
    expect(requests.get("community")).toBe(3);
    expect(book.current().mirrors[1]).toMatchObject({
      availability: "available",
      stream: "closed",
    });

    streams.invalid("/api/orders/stream");
    expect(book.current().mirrors[0]).toMatchObject({
      availability: "unavailable",
      stream: "closed",
    });
    now += 10_000;
    await book.refreshDisconnected();
    expect(requests.get("primary")).toBe(2);
    expect(requests.get("community")).toBe(4);
    subscription.close();
  });

  it("distinguishes zero liquidity, partial discovery and total outage", async () => {
    const availableBook = new FederatedOrderBook(
      [{ id: "primary", apiBase: "/api" }],
      () => ({ fetch: async () => listResponse([]) }),
      null,
      {},
      null,
    );
    const available = await availableBook.refresh();
    expect(available.orders).toEqual([]);
    expect(summarizeMirrorAvailability(available.mirrors)).toMatchObject({
      state: "all",
      available: 1,
      total: 1,
    });

    const partialBook = new FederatedOrderBook(
      [
        { id: "primary", apiBase: "/api" },
        { id: "community", apiBase: "https://mirror.test/api" },
      ],
      (mirror) => ({
        fetch: async () => {
          if (mirror.id === "community") throw new Error("offline");
          return listResponse([]);
        },
      }),
      null,
      {},
      null,
    );
    const partial = await partialBook.refresh();
    expect(summarizeMirrorAvailability(partial.mirrors)).toMatchObject({
      state: "partial",
      available: 1,
      total: 2,
    });

    const unavailableBook = new FederatedOrderBook(
      [{ id: "primary", apiBase: "/api" }],
      () => ({ fetch: async () => Promise.reject(new Error("offline")) }),
      null,
      {},
      null,
    );
    const unavailable = await unavailableBook.refresh();
    expect(unavailable.orders).toEqual([]);
    expect(summarizeMirrorAvailability(unavailable.mirrors)).toMatchObject({
      state: "unavailable",
      available: 0,
      total: 1,
    });
  });

  it("retains a signed id quarantine across reload when the conflicting mirror disappears", async () => {
    const conflictId = "ab".repeat(32);
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
    };
    let conflictAvailable = true;
    const mirrors = [
      { id: "primary", apiBase: "/api" },
      { id: "community", apiBase: "https://mirror.test/api" },
    ] as const;
    const optionsForMirror = (mirror: { id: string; apiBase: string }) => ({
      fetch: async () => {
        if (mirror.id === "community" && !conflictAvailable) {
          throw new Error("mirror unavailable");
        }
        const orders =
          mirror.id === "primary"
            ? [row({ id: conflictId, makerAuth: auth() })]
            : [row({ id: conflictId, fromAmount: "3", makerAuth: auth() })];
        return new Response(JSON.stringify({ orders }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    const aggregationOptions = { verifyOrder: verify, digestOrder: digest };

    const first = new FederatedOrderBook(
      mirrors,
      optionsForMirror,
      storage,
      aggregationOptions,
    );
    await expect(first.refresh()).resolves.toMatchObject({
      orders: [],
      quarantinedIds: [conflictId],
    });
    expect([...stored.values()].join(" ")).toContain(conflictId);

    conflictAvailable = false;
    const afterReload = new FederatedOrderBook(
      mirrors,
      optionsForMirror,
      storage,
      aggregationOptions,
    );
    await expect(afterReload.refresh()).resolves.toMatchObject({
      orders: [],
      quarantinedIds: [conflictId],
    });
  });

  it("merges sticky quarantines discovered by two browser instances", async () => {
    const idA = "ca".repeat(32);
    const idB = "db".repeat(32);
    const stored = new Map<string, string>();
    const listeners: Array<(event: { key: string | null }) => void> = [];
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
        listeners.forEach((listener) => listener({ key }));
      },
    };
    const events = {
      addEventListener: (
        _type: "storage",
        listener: (event: { key: string | null }) => void,
      ) => {
        listeners.push(listener);
      },
    };
    const mirrors = [
      { id: "primary", apiBase: "/api" },
      { id: "community", apiBase: "https://mirror.test/api" },
    ] as const;
    const conflictingBook = (id: string) =>
      new FederatedOrderBook(
        mirrors,
        (mirror) => ({
          fetch: async () => {
            const orders = [
              row({
                id,
                ...(mirror.id === "community" ? { fromAmount: "3" } : {}),
                makerAuth: auth(),
              }),
            ];
            return new Response(JSON.stringify({ orders }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        }),
        storage,
        { verifyOrder: verify, digestOrder: digest },
        events,
      );
    const first = conflictingBook(idA);
    const second = conflictingBook(idB);

    await expect(first.refresh()).resolves.toMatchObject({
      orders: [],
      quarantinedIds: [idA],
    });
    expect(second.current().quarantinedIds).toEqual([idA]);
    await expect(second.refresh()).resolves.toMatchObject({
      orders: [],
      quarantinedIds: [idA, idB].sort(),
    });
    expect(first.current().quarantinedIds).toEqual([idA, idB].sort());
    expect([...stored.values()].join(" ")).toContain(idA);
    expect([...stored.values()].join(" ")).toContain(idB);
  });

  it("bounds and expires persisted sticky quarantines", () => {
    const now = 1_800_000_000_000;
    const storageKey = "quantaswap.orderbook.quarantines.v1";
    const expiredId = "ff".repeat(32);
    const entries = Array.from({ length: 1_030 }, (_, index) => ({
      id: index.toString(16).padStart(64, "0"),
      observedAt: now - index,
    }));
    entries.push({ id: expiredId, observedAt: now - 50 * 60 * 60 * 1_000 });
    const stored = new Map<string, string>([
      [storageKey, JSON.stringify({ version: 2, entries })],
    ]);
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
    };
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const book = new FederatedOrderBook(
        [{ id: "primary", apiBase: "/api" }],
        undefined,
        storage,
        {},
        null,
      );
      const result = book.current();
      expect(result.quarantinedIds).toHaveLength(1_024);
      expect(result.quarantinedIds).not.toContain(expiredId);
      const persisted = JSON.parse(stored.get(storageKey) ?? "null") as {
        version: number;
        entries: unknown[];
      };
      expect(persisted.version).toBe(2);
      expect(persisted.entries).toHaveLength(1_024);
    } finally {
      clock.mockRestore();
    }
  });
});
