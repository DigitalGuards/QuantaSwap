import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSignedOrderStage,
  saveSignedOrderStage,
  type SignedOrderStage,
} from "./activeSwap";
import type { MakerOrderAuthV1, OrderView } from "./orderbook";
import { OrderbookClient } from "./orderbookClient";
import { capabilityCommitment } from "./orderSigning";

function stubStorage(): void {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

const makerToken = "aa".repeat(32);
const shareToken = "bb".repeat(32);
const auth: MakerOrderAuthV1 = {
  version: "1",
  scheme: "qrl-sign-typed-v1",
  issuedAt: 1_800_000_000,
  expiresAt: 1_800_003_600,
  nonce: `0x${"11".repeat(32)}`,
  makerTokenCommitment: capabilityCommitment("maker", makerToken),
  shareTokenCommitment: capabilityCommitment("share", shareToken),
  signature: "0x01",
  publicKey: "0x02",
  descriptor: "0x010000",
};
const stage: SignedOrderStage = {
  order: {
    direction: "eth->qrl",
    asset: "ETH",
    fromAmount: "1",
    toAmount: "2",
    makerEthAccount: `0x${"22".repeat(20)}`,
    makerQrlAccount: `Q${"33".repeat(20)}`,
    visibility: "private",
  },
  auth,
  makerToken,
  shareToken,
  orderDigest: `0x${"44".repeat(32)}`,
  bookId: "primary",
  createdAt: auth.issuedAt,
};
const order: OrderView = {
  id: "55".repeat(32),
  ...stage.order,
  status: "open",
  takerEthAccount: null,
  takerQrlAccount: null,
  hashlock: null,
  initiatorTimeout: null,
  responderTimeout: null,
  createdAt: auth.issuedAt,
  updatedAt: auth.issuedAt,
  makerAuth: auth,
  orderDigest: stage.orderDigest,
};

beforeEach(stubStorage);

describe("signed order publication recovery", () => {
  it("retries the exact staged envelope after a lost response and reload", async () => {
    saveSignedOrderStage(stage);
    const sent: string[] = [];
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(String(init?.body));
      if (sent.length === 1) {
        throw new TypeError("response lost after origin accepted the request");
      }
      return new Response(JSON.stringify({ order }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = new OrderbookClient(
      { id: "primary", apiBase: "https://book.test/api" },
      { fetch: request },
    );
    const envelope = {
      order: stage.order,
      auth: stage.auth,
      makerToken: stage.makerToken,
      ...(stage.shareToken === undefined ? {} : { shareToken: stage.shareToken }),
    };

    await expect(client.createSigned(envelope)).rejects.toThrow(/response lost/);
    const afterReload = loadSignedOrderStage();
    expect(afterReload).toEqual(stage);
    await expect(
      client.createSigned({
        order: afterReload!.order,
        auth: afterReload!.auth,
        makerToken: afterReload!.makerToken,
        ...(afterReload!.shareToken === undefined
          ? {}
          : { shareToken: afterReload!.shareToken }),
      }),
    ).resolves.toEqual({ order });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
  });

  it("retries a public envelope without inventing a share capability", async () => {
    const { shareToken: _shareToken, ...stageWithoutShare } = stage;
    const publicStage: SignedOrderStage = {
      ...stageWithoutShare,
      order: { ...stage.order, visibility: "public" },
      auth: {
        ...stage.auth,
        shareTokenCommitment: `0x${"00".repeat(32)}`,
      },
    };
    saveSignedOrderStage(publicStage);
    const sent: string[] = [];
    const client = new OrderbookClient(
      { id: "primary", apiBase: "https://book.test/api" },
      {
        fetch: async (_input, init) => {
          sent.push(String(init?.body));
          if (sent.length === 1) throw new TypeError("response lost");
          return new Response(JSON.stringify({ order: { ...order, visibility: "public" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    );
    const envelope = {
      order: publicStage.order,
      auth: publicStage.auth,
      makerToken: publicStage.makerToken,
    };

    await expect(client.createSigned(envelope)).rejects.toThrow(/response lost/);
    expect(loadSignedOrderStage()).toEqual(publicStage);
    await expect(client.createSigned(envelope)).resolves.toHaveProperty("order");
    expect(JSON.parse(sent[0] ?? "{}")).not.toHaveProperty("shareToken");
    expect(sent[1]).toBe(sent[0]);
  });
});
