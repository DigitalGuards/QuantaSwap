import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  OrderBookClient,
  OrderBookUnavailableError,
  type OrderView,
} from "./orderbook.js";
import type { SelectedFillIntentV1 } from "./policy.js";
import {
  capabilityCommitment,
  computeCancelDigest,
  computeFillDigest,
  computeOrderDigest,
  deriveOrderV1Id,
  EMPTY_CAPABILITY_COMMITMENT,
  MAKER_CAPABILITY_DOMAIN,
  type SignedCancelV1,
  type SignedFillV1,
  type SignedOrderV1,
} from "./protocol-signing.js";

const NOW = 1_800_000_000;
const ORDER_DIGEST = `0x${"1".repeat(64)}`;
const INTENT_DIGEST = `0x${"2".repeat(64)}`;
const HASHLOCK = `0x${"3".repeat(64)}`;
const NONCE = `0x${"4".repeat(64)}`;
const ETH = `0x${"5".repeat(40)}`;
const QRL = `Q${"6".repeat(40)}`;
const MAKER_TOKEN = "a".repeat(64);

const auth = {
  version: "1" as const,
  scheme: "qrl-eip712-v4" as const,
  issuedAt: NOW,
  expiresAt: NOW + 120,
  nonce: NONCE,
  signature: "0x01",
  publicKey: "0x02",
  descriptor: "0x010000",
};
const orderAuth = {
  ...auth,
  makerTokenCommitment: capabilityCommitment(MAKER_CAPABILITY_DOMAIN, MAKER_TOKEN),
  shareTokenCommitment: EMPTY_CAPABILITY_COMMITMENT,
};

const selected: SelectedFillIntentV1 = {
  intentDigest: INTENT_DIGEST,
  intent: {
    orderDigest: ORDER_DIGEST,
    takerEthAccount: ETH,
    takerQrlAccount: QRL,
    releaseCommitment: `0x${"7".repeat(64)}`,
  },
  auth,
  receivedAt: NOW + 1,
};

const signedOrder: SignedOrderV1 = {
  order: {
    direction: "eth->qrl",
    asset: "ETH",
    fromAmount: "1000000000000000",
    toAmount: "2000000000000000",
    makerEthAccount: ETH,
    makerQrlAccount: QRL,
    visibility: "public",
  },
  auth: orderAuth,
};

const orderView: OrderView = {
  id: deriveOrderV1Id(QRL, NONCE),
  ...signedOrder.order,
  status: "open",
  takerEthAccount: null,
  takerQrlAccount: null,
  hashlock: null,
  initiatorTimeout: null,
  responderTimeout: null,
  createdAt: NOW,
  updatedAt: NOW,
  makerAuth: orderAuth,
  orderDigest: computeOrderDigest(signedOrder.order, orderAuth),
  released: false,
  makerSeen: true,
};

async function withFetch(
  handler: (input: string, init: RequestInit) => Response | Promise<Response>,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) =>
    handler(String(input), init ?? {})) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

describe("portable order book client", () => {
  it("parses exact FillIntentV1 rows", async () => {
    await withFetch(
      () =>
        new Response(JSON.stringify({ intents: [selected] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      async () => {
        const rows = await new OrderBookClient("https://book.test/api").intents(orderView.id);
        assert.deepEqual(rows, [selected]);
      },
    );
  });

  it("rejects a malformed intent row instead of passing it to the signer", async () => {
    await withFetch(
      () =>
        new Response(JSON.stringify({ intents: [{ ...selected, injected: true }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      async () => {
        await assert.rejects(
          new OrderBookClient("https://book.test/api").intents(orderView.id),
          /unsupported or missing fields/,
        );
      },
    );
  });

  it("publishes the exact signed create, fill, and cancellation envelopes", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    await withFetch(
      (url, init) => {
        assert.equal(init.redirect, "error");
        calls.push({
          url,
          body: typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
        });
        const request = typeof init.body === "string"
          ? JSON.parse(init.body) as Record<string, unknown>
          : {};
        let responseOrder: OrderView = orderView;
        if (url.endsWith("/fill")) {
          const proof = request as unknown as SignedFillV1 & {
            intent: SelectedFillIntentV1["intent"];
            intentAuth: SelectedFillIntentV1["auth"];
          };
          responseOrder = {
            ...orderView,
            status: "locking",
            takerEthAccount: proof.fill.takerEthAccount,
            takerQrlAccount: proof.fill.takerQrlAccount,
            hashlock: proof.fill.hashlock,
            initiatorTimeout: proof.fill.initiatorTimeout,
            responderTimeout: proof.fill.responderTimeout,
            fill: proof.fill,
            fillAuth: proof.auth,
            fillDigest: computeFillDigest(proof.fill, orderAuth, proof.auth),
            selectedIntent: selected,
          };
        } else if (url.endsWith("/cancel/signed")) {
          const proof = request as unknown as SignedCancelV1;
          responseOrder = {
            ...orderView,
            status: "cancelled",
            cancelProof: proof.cancel,
            cancelAuth: proof.auth,
            cancelDigest: computeCancelDigest(proof.cancel, orderAuth, proof.auth),
          };
        }
        const payload = url.endsWith("/orders/signed")
          ? { order: responseOrder, makerToken: MAKER_TOKEN }
          : { order: responseOrder };
        return new Response(JSON.stringify(payload), {
          status: url.endsWith("/orders/signed") ? 201 : 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      async () => {
        const client = new OrderBookClient("https://book.test/api");
        const fillProof: SignedFillV1 = {
          fill: {
            orderDigest: ORDER_DIGEST,
            intentDigest: INTENT_DIGEST,
            takerEthAccount: ETH,
            takerQrlAccount: QRL,
            releaseCommitment: selected.intent.releaseCommitment,
            hashlock: HASHLOCK,
            initiatorTimeout: NOW + 7200,
            responderTimeout: NOW + 3600,
          },
          auth,
        };
        const cancelProof: SignedCancelV1 = {
          cancel: { orderDigest: ORDER_DIGEST, reasonCode: 1 },
          auth,
        };

        await client.createSigned(signedOrder, MAKER_TOKEN);
        await client.createSigned(signedOrder, MAKER_TOKEN);
        await client.fill(orderView.id, fillProof, selected, signedOrder);
        await client.cancelSigned(orderView.id, cancelProof, signedOrder);

        assert.deepEqual(calls, [
          {
            url: "https://book.test/api/orders/signed",
            body: { ...signedOrder, makerToken: MAKER_TOKEN },
          },
          {
            url: "https://book.test/api/orders/signed",
            body: { ...signedOrder, makerToken: MAKER_TOKEN },
          },
          {
            url: `https://book.test/api/orders/${orderView.id}/fill`,
            body: {
              ...fillProof,
              intent: selected.intent,
              intentAuth: selected.auth,
            },
          },
          {
            url: `https://book.test/api/orders/${orderView.id}/cancel/signed`,
            body: cancelProof,
          },
        ]);
      },
    );
  });

  it("rejects redirects, non-JSON responses, and advertised oversized bodies", async () => {
    for (const response of [
      new Response("redirect", { status: 200, headers: { "Content-Type": "text/plain" } }),
      new Response("{}", {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(2 * 1024 * 1024 + 1),
        },
      }),
    ]) {
      await withFetch(
        (_url, init) => {
          assert.equal(init.redirect, "error");
          return response.clone();
        },
        async () => {
          await assert.rejects(
            new OrderBookClient("https://book.test/api").getSigned(orderView.id, signedOrder),
            /application\/json|size limit/,
          );
        },
      );
    }
  });

  it("classifies transport and server outages separately from proof failures", async () => {
    for (const handler of [
      () => {
        throw new TypeError("network down");
      },
      () =>
        new Response("temporary outage", {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        }),
    ]) {
      await withFetch(handler, async () => {
        await assert.rejects(
          new OrderBookClient("https://book.test/api").getSigned(orderView.id, signedOrder),
          OrderBookUnavailableError,
        );
      });
    }
  });

  it("authenticates a released response and rejects conflicting terminal data", async () => {
    const fillProof: SignedFillV1 = {
      fill: {
        orderDigest: orderView.orderDigest!,
        intentDigest: INTENT_DIGEST,
        takerEthAccount: ETH,
        takerQrlAccount: QRL,
        releaseCommitment: selected.intent.releaseCommitment,
        hashlock: HASHLOCK,
        initiatorTimeout: NOW + 7200,
        responderTimeout: NOW + 3600,
      },
      auth,
    };
    const validFillView: OrderView = {
      ...orderView,
      status: "locking",
      takerEthAccount: ETH,
      takerQrlAccount: QRL,
      hashlock: HASHLOCK,
      initiatorTimeout: NOW + 7200,
      responderTimeout: NOW + 3600,
      fill: fillProof.fill,
      fillAuth: fillProof.auth,
      fillDigest: computeFillDigest(fillProof.fill, orderAuth, fillProof.auth),
      selectedIntent: selected,
    };
    await withFetch(
      () =>
        new Response(
          JSON.stringify({
            order: {
              ...validFillView,
              released: true,
              selectedIntent: { ...selected, receivedAt: selected.receivedAt + 999 },
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      async () => {
        const released = await new OrderBookClient("https://book.test/api").getSigned(
          orderView.id,
          signedOrder,
          { fill: fillProof, intent: selected },
        );
        assert.equal(released.released, true);
        assert.equal(released.selectedIntent?.receivedAt, selected.receivedAt + 999);
      },
    );
    for (const malicious of [
      { ...validFillView, equivocated: true, conflictDigests: [`0x${"9".repeat(64)}`] },
      { ...validFillView, toAmount: "2000000000000001" },
      { ...validFillView, fillDigest: `0x${"8".repeat(64)}` },
      {
        ...validFillView,
        selectedIntent: {
          ...selected,
          auth: { ...selected.auth, nonce: `0x${"9".repeat(64)}` },
        },
      },
      { ...validFillView, selectedIntent: { ...selected, receivedAt: "invalid" } },
    ]) {
      await withFetch(
        () => new Response(JSON.stringify({ order: malicious }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        async () => {
          await assert.rejects(
            new OrderBookClient("https://book.test/api").getSigned(
              orderView.id,
              signedOrder,
              { fill: fillProof, intent: selected },
            ),
            /conflict|authenticate|FillV1|malformed/,
          );
        },
      );
    }
  });
});
