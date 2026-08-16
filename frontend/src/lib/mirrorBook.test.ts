import { describe, expect, it, vi } from "vitest";
import type { MakerOrderAuthV1, OrderView } from "./orderbook";
import {
  FederatedOrderBook,
  aggregateMirrorOrders,
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

describe("mirror snapshot aggregation", () => {
  it("combines authenticated copies and keeps unsigned liquidity primary-only", () => {
    const portable = row({ makerAuth: auth(), orderDigest: DIGEST_A });
    const unsigned = row({ id: "primary-unsigned", createdAt: 2 });
    const snapshots: MirrorSnapshot[] = [
      {
        bookId: "primary",
        orders: [
          portable,
          unsigned,
          row({ id: "private", visibility: "private", makerAuth: auth() }),
        ],
      },
      {
        bookId: "community",
        orders: [
          { ...portable, updatedAt: 3 },
          row({ id: "mirror-unsigned" }),
          row({ id: "bad-proof", makerAuth: auth("invalid") }),
        ],
      },
    ];

    const result = aggregateMirrorOrders(snapshots, {
      now: 15,
      verifyOrder: verify,
      digestOrder: digest,
    });

    expect(result.quarantinedIds).toEqual([]);
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

  it("ignores malformed mirror rows without suppressing a healthy primary", () => {
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
    expect([...listeners.keys()]).toEqual([
      "/api/orders/stream",
      "https://mirror.test/api/orders/stream",
    ]);
    listeners.get("/api/orders/stream")?.({
      data: JSON.stringify({ orders: [updatedOrder] }),
    } as MessageEvent<string>);
    expect(onBook).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "primary-two", bookId: "primary" }),
    ]);
    expect(stream.isLive()).toBe(true);
    stream.close();
    expect(closed).toHaveLength(2);
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
    await expect(first.refresh()).resolves.toEqual({
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
    await expect(afterReload.refresh()).resolves.toEqual({
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

    await expect(first.refresh()).resolves.toEqual({
      orders: [],
      quarantinedIds: [idA],
    });
    expect(second.current().quarantinedIds).toEqual([idA]);
    await expect(second.refresh()).resolves.toEqual({
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
