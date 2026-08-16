import { describe, expect, it, vi } from "vitest";
import type { CreateOrderBody, MakerOrderAuthV1, OrderView } from "./orderbook";
import {
  OrderbookClient,
  OrderGoneError,
  type EventSourcePort,
} from "./orderbookClient";
import type {
  ProtocolAuthV1,
  SignedCancelV1,
  SignedFillIntentV1,
  SignedFillV1,
} from "./orderSigning";
import { capabilityCommitment } from "./orderSigning";

const order: OrderView = {
  id: "order-1",
  direction: "eth->qrl",
  asset: "ETH",
  fromAmount: "1",
  toAmount: "2",
  makerEthAccount: `0x${"11".repeat(20)}`,
  makerQrlAccount: `Q${"22".repeat(20)}`,
  status: "open",
  takerEthAccount: null,
  takerQrlAccount: null,
  hashlock: null,
  initiatorTimeout: null,
  responderTimeout: null,
  visibility: "public",
  createdAt: 1,
  updatedAt: 1,
};

const auth: ProtocolAuthV1 = {
  version: "1",
  scheme: "qrl-sign-typed-v1",
  issuedAt: 10,
  expiresAt: 20,
  nonce: `0x${"33".repeat(32)}`,
  signature: "0x01",
  publicKey: "0x02",
  descriptor: "0x010000",
};

const makerAuth: MakerOrderAuthV1 = {
  ...auth,
  makerTokenCommitment: capabilityCommitment("maker", "cc".repeat(32)),
  shareTokenCommitment: capabilityCommitment("share", "dd".repeat(32)),
};

const intent: SignedFillIntentV1 = {
  intent: {
    orderDigest: `0x${"44".repeat(32)}`,
    takerEthAccount: `0x${"55".repeat(20)}`,
    takerQrlAccount: `Q${"66".repeat(20)}`,
    releaseCommitment: `0x${"77".repeat(32)}`,
  },
  auth,
};

const fill: SignedFillV1 = {
  fill: {
    orderDigest: intent.intent.orderDigest,
    intentDigest: `0x${"88".repeat(32)}`,
    takerEthAccount: intent.intent.takerEthAccount,
    takerQrlAccount: intent.intent.takerQrlAccount,
    releaseCommitment: intent.intent.releaseCommitment,
    hashlock: `0x${"99".repeat(32)}`,
    initiatorTimeout: 1_000,
    responderTimeout: 500,
  },
  auth,
};

const cancel: SignedCancelV1 = {
  cancel: { orderDigest: intent.intent.orderDigest, reasonCode: 1 },
  auth,
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("endpoint-bound order book client", () => {
  it("sends client-committed capabilities in the signed create envelope", async () => {
    const request = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => response({ order }));
    const client = new OrderbookClient(
      { id: "community", apiBase: "https://mirror.test/api" },
      { fetch: request },
    );
    const body: CreateOrderBody = {
      direction: "eth->qrl",
      asset: "ETH",
      fromAmount: "1",
      toAmount: "2",
      makerEthAccount: order.makerEthAccount,
      makerQrlAccount: order.makerQrlAccount,
      visibility: "private",
    };
    const envelope = {
      order: body,
      auth: makerAuth,
      makerToken: "cc".repeat(32),
      shareToken: "dd".repeat(32),
    };

    await expect(client.createSigned(envelope)).resolves.toEqual({ order });
    expect(request.mock.calls[0]?.[0]).toBe("https://mirror.test/api/orders/signed");
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual(envelope);
  });

  it("rejects a wrong raw capability before contacting the origin", async () => {
    const request = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => response({ order }));
    const client = new OrderbookClient(
      { id: "community", apiBase: "https://mirror.test/api" },
      { fetch: request },
    );
    await expect(
      client.createSigned({
        order: {
          direction: "eth->qrl",
          asset: "ETH",
          fromAmount: "1",
          toAmount: "2",
          makerEthAccount: order.makerEthAccount,
          makerQrlAccount: order.makerQrlAccount,
          visibility: "private",
        },
        auth: makerAuth,
        makerToken: "ee".repeat(32),
        shareToken: "dd".repeat(32),
      }),
    ).rejects.toThrow(/do not match/);
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps private reads on the selected origin without a preflight content type", async () => {
    const request = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => response({ order }));
    const client = new OrderbookClient(
      { id: "community", apiBase: "https://mirror.test/api" },
      { fetch: request },
    );

    await expect(client.get("id/with slash", "share-secret")).resolves.toEqual(order);
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0] ?? [];
    expect(url).toBe("https://mirror.test/api/orders/id%2Fwith%20slash");
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toEqual({ "X-Share-Token": "share-secret" });
  });

  it("routes signed intent, fill, cancel and release operations to one origin", async () => {
    const request = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async (input) => {
      const url = String(input);
      if (url.endsWith("/intents")) {
        return response({
          intent: { ...intent, intentDigest: fill.fill.intentDigest, receivedAt: 11 },
        });
      }
      return response({ order });
    });
    const client = new OrderbookClient(
      { id: "community", apiBase: "https://mirror.test/api" },
      { fetch: request },
    );

    await client.submitIntent("order-1", intent, "private-share");
    await client.fill("order-1", fill, intent, "maker-token");
    await client.cancelSigned("order-1", cancel, "maker-token");
    await client.releasePortable("order-1", {
      releaseSecret: `0x${"aa".repeat(32)}`,
      fillDigest: fill.fill.intentDigest,
    });

    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      "https://mirror.test/api/orders/order-1/intents",
      "https://mirror.test/api/orders/order-1/fill",
      "https://mirror.test/api/orders/order-1/cancel/signed",
      "https://mirror.test/api/orders/order-1/release",
    ]);
    const intentInit = request.mock.calls[0]?.[1];
    expect(intentInit?.headers).toEqual({
      "Content-Type": "application/json",
      "X-Share-Token": "private-share",
    });
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toEqual({
      ...fill,
      intent: intent.intent,
      intentAuth: intent.auth,
      token: "maker-token",
    });
    expect(JSON.parse(String(request.mock.calls[3]?.[1]?.body))).toEqual({
      releaseSecret: `0x${"aa".repeat(32)}`,
      fillDigest: fill.fill.intentDigest,
    });
  });

  it("keeps private maker intent reads on their origin and token header", async () => {
    const request = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => response({ intents: [] }));
    const client = new OrderbookClient(
      { id: "community", apiBase: "https://mirror.test/api" },
      { fetch: request },
    );

    await expect(client.intents("order-1", "maker-token")).resolves.toEqual([]);
    expect(request.mock.calls[0]?.[0]).toBe(
      "https://mirror.test/api/orders/order-1/intents",
    );
    expect(request.mock.calls[0]?.[1]?.headers).toEqual({
      "X-Maker-Token": "maker-token",
    });
  });

  it("maps a 404 to OrderGoneError", async () => {
    const client = new OrderbookClient(
      { id: "community", apiBase: "https://mirror.test/api" },
      { fetch: async () => response({ error: "gone" }, 404) },
    );
    await expect(client.get("missing")).rejects.toEqual(new OrderGoneError("gone"));
  });

  it("bounds list snapshots and drops malformed rows independently", async () => {
    const client = new OrderbookClient(
      { id: "community", apiBase: "https://mirror.test/api" },
      {
        fetch: async () =>
          response({
            orders: [
              null,
              { ...order, id: "bad-direction", direction: "sideways" },
              order,
              { ...order, id: "bad-asset", asset: "DOGE" },
            ],
          }),
      },
    );
    await expect(client.list()).resolves.toEqual([order]);

    const oversized = new OrderbookClient(
      { id: "community", apiBase: "https://mirror.test/api" },
      {
        fetch: async () =>
          new Response("{}", {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Content-Length": String(4 * 1024 * 1024 + 1),
            },
          }),
      },
    );
    await expect(oversized.list()).rejects.toThrow(/size limit/);

    const tooMany = new OrderbookClient(
      { id: "community", apiBase: "https://mirror.test/api" },
      { fetch: async () => response({ orders: Array.from({ length: 201 }, () => order) }) },
    );
    await expect(tooMany.list()).rejects.toThrow(/too many orders/);
  });

  it("rejects a successful response with a non-JSON media type", async () => {
    const client = new OrderbookClient(
      { id: "community", apiBase: "https://mirror.test/api" },
      {
        fetch: async () =>
          new Response("<html>not an order book</html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          }),
      },
    );
    await expect(client.list()).rejects.toThrow(/must use application\/json/);
  });

  it("parses full-book SSE frames and exposes connection state", () => {
    let listener: ((event: MessageEvent<string>) => void) | undefined;
    let closed = false;
    const port: EventSourcePort = {
      readyState: 1,
      addEventListener: (_type, next) => {
        listener = next;
      },
      close: () => {
        closed = true;
      },
    };
    const client = new OrderbookClient(
      { id: "community", apiBase: "https://mirror.test/api" },
      { eventSource: () => port },
    );
    const onBook = vi.fn();
    const stream = client.openBookStream(onBook);

    listener?.({ data: JSON.stringify({ orders: [order] }) } as MessageEvent<string>);
    listener?.({ data: JSON.stringify({ orders: [null, { direction: "sideways" }] }) } as MessageEvent<string>);
    listener?.({ data: "{" } as MessageEvent<string>);
    expect(onBook).toHaveBeenCalledTimes(2);
    expect(onBook).toHaveBeenNthCalledWith(1, [order]);
    expect(onBook).toHaveBeenNthCalledWith(2, []);
    expect(stream.isLive()).toBe(true);
    stream.close();
    expect(closed).toBe(true);
  });
});
