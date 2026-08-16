import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { shake256 } from "@noble/hashes/sha3.js";
import {
  SCHEME_TAG_TYPED,
  computeTypedDataDigest,
  type TypedDataPayload,
} from "@qrlwallet/connect";
import {
  CryptoBytes,
  CryptoPublicKeyBytes,
  CryptoSecretKeyBytes,
  cryptoSignKeypair,
  cryptoSignSignature,
} from "@theqrl/mldsa87";
import {
  ORDER_V1_DEPLOYMENT,
  buildCancelV1Payload,
  buildFillIntentV1Payload,
  buildFillV1Payload,
  buildOrderV1Payload,
  computeMakerTokenCommitment,
  computeReleaseCommitment,
  computeShareTokenCommitment,
  verifyFillIntentV1,
  verifyOrderV1,
  type CancelV1Body,
  type CancelV1Terms,
  type FillIntentV1Body,
  type FillIntentV1Terms,
  type FillV1Body,
  type FillV1Terms,
  type ProtocolAuthV1,
  type SignedOrderTerms,
  type VerifiedOrderV1,
} from "./order-signing.js";
import { ApiError, OrderStore } from "./store.js";
import { federationEventId, type FederationEvent } from "./federation.js";
import { FederationPeerSync } from "./peer-sync.js";

const descriptor = new Uint8Array([1, 0, 0]);
const makerToken = "ab".repeat(32);
const shareToken = "cd".repeat(32);
const zeroShareCommitment = `0x${"00".repeat(32)}`;

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function hex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function keypair(seedByte: number): {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  address: string;
} {
  const publicKey = new Uint8Array(CryptoPublicKeyBytes);
  const secretKey = new Uint8Array(CryptoSecretKeyBytes);
  cryptoSignKeypair(new Uint8Array(32).fill(seedByte), publicKey, secretKey);
  const address = `Q${Buffer.from(
    shake256(concatBytes(descriptor, publicKey), { dkLen: 20 }),
  ).toString("hex")}`;
  return { publicKey, secretKey, address };
}

const maker = keypair(31);
const taker = keypair(32);

function signedAuth(
  base: Omit<ProtocolAuthV1, "signature" | "publicKey" | "descriptor">,
  payload: TypedDataPayload,
  signer: typeof maker,
): ProtocolAuthV1 {
  const signature = new Uint8Array(CryptoBytes);
  cryptoSignSignature(
    signature,
    computeTypedDataDigest(payload),
    signer.secretKey,
    false,
    SCHEME_TAG_TYPED,
  );
  return {
    ...base,
    signature: hex(signature),
    publicKey: hex(signer.publicKey),
    descriptor: hex(descriptor),
  };
}

function nonce(byte: number): string {
  return `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
}

function makeOrder(
  now: number,
  options: {
    nonceByte?: number;
    fromAmount?: string;
    visibility?: "public" | "private";
    issuedAt?: number;
    expiresAt?: number;
    makerCapability?: string;
  } = {},
): VerifiedOrderV1 {
  const orderNonce = nonce(options.nonceByte ?? 41);
  const fromAmount = options.fromAmount ?? "1000000000000000";
  const visibility = options.visibility ?? "public";
  const body: Record<string, unknown> = {
    direction: "eth->qrl",
    asset: "ETH",
    fromAmount,
    toAmount: "1000000000000000",
    makerEthAccount: "0x1111111111111111111111111111111111111111",
    makerQrlAccount: maker.address,
    visibility,
  };
  const baseAuth = {
    version: "1" as const,
    scheme: "qrl-sign-typed-v1" as const,
    issuedAt: options.issuedAt ?? now - 10,
    expiresAt: options.expiresAt ?? now + 3600,
    nonce: orderNonce,
    makerTokenCommitment: computeMakerTokenCommitment(
      options.makerCapability ?? makerToken,
    ),
    shareTokenCommitment:
      visibility === "private"
        ? computeShareTokenCommitment(shareToken)
        : zeroShareCommitment,
  };
  const terms: SignedOrderTerms = {
    direction: "eth->qrl",
    asset: "ETH",
    fromAmount,
    toAmount: "1000000000000000",
    makerEthAccount: "eip155:11155111:0x1111111111111111111111111111111111111111",
    makerQrlAccount: maker.address,
    visibility,
    allowedTakerEth: "",
    allowedTakerQrl: "",
    prelocked: false,
    hashlock: `0x${"00".repeat(32)}`,
    initiatorTimeout: "0",
    issuedAt: String(baseAuth.issuedAt),
    expiresAt: String(baseAuth.expiresAt),
    nonce: orderNonce,
    makerTokenCommitment: baseAuth.makerTokenCommitment,
    shareTokenCommitment: baseAuth.shareTokenCommitment,
    ...ORDER_V1_DEPLOYMENT,
  };
  const auth = signedAuth(baseAuth, buildOrderV1Payload(terms, baseAuth.scheme), maker);
  return verifyOrderV1(body, auth, { now });
}

function createCapabilities(order: VerifiedOrderV1): {
  makerToken: string;
  shareToken?: string;
} {
  return order.terms.visibility === "private"
    ? { makerToken, shareToken }
    : { makerToken };
}

interface FillArtifacts {
  releaseSecret: string;
  intentBody: FillIntentV1Body;
  intentAuth: ProtocolAuthV1;
  fillBody: FillV1Body;
  fillAuth: ProtocolAuthV1;
}

function makeFill(
  now: number,
  order: VerifiedOrderV1,
  fillNonceByte = 44,
  hashByte = 66,
  timing: {
    intentIssuedAt?: number;
    intentExpiresAt?: number;
    fillIssuedAt?: number;
    fillExpiresAt?: number;
    requestNonceByte?: number;
  } = {},
): FillArtifacts {
  const requestNonce = nonce(timing.requestNonceByte ?? 43);
  const releaseSecret = nonce(55);
  const releaseCommitment = computeReleaseCommitment(
    order.orderDigest,
    requestNonce,
    releaseSecret,
  );
  const intentBody: FillIntentV1Body = {
    orderDigest: order.orderDigest,
    takerEthAccount: "0x2222222222222222222222222222222222222222",
    takerQrlAccount: taker.address,
    releaseCommitment,
  };
  const intentBase = {
    version: "1" as const,
    scheme: "qrl-sign-typed-v1" as const,
    issuedAt: timing.intentIssuedAt ?? now - 5,
    expiresAt: timing.intentExpiresAt ?? now + 115,
    nonce: requestNonce,
  };
  const intentTerms: FillIntentV1Terms = {
    orderDigest: order.orderDigest,
    requestNonce,
    takerEthAccount: `eip155:11155111:${intentBody.takerEthAccount}`,
    takerQrlAccount: taker.address,
    releaseCommitment,
    issuedAt: String(intentBase.issuedAt),
    expiresAt: String(intentBase.expiresAt),
    ...ORDER_V1_DEPLOYMENT,
  };
  const intentAuth = signedAuth(
    intentBase,
    buildFillIntentV1Payload(intentTerms, intentBase.scheme),
    taker,
  );
  const intentVerificationTime = Math.max(
    intentBase.issuedAt,
    Math.min(now, intentBase.expiresAt - 1),
  );
  const intent = verifyFillIntentV1(intentBody, intentAuth, order, {
    now: intentVerificationTime,
  });
  const fillIssuedAt = timing.fillIssuedAt ?? now;
  const fillBody: FillV1Body = {
    orderDigest: order.orderDigest,
    intentDigest: intent.intentDigest,
    takerEthAccount: intentBody.takerEthAccount,
    takerQrlAccount: intentBody.takerQrlAccount,
    releaseCommitment,
    hashlock: nonce(hashByte),
    initiatorTimeout: fillIssuedAt + 7200,
    responderTimeout: fillIssuedAt + 3600,
  };
  const fillBase = {
    version: "1" as const,
    scheme: "qrl-sign-typed-v1" as const,
    issuedAt: fillIssuedAt,
    expiresAt: timing.fillExpiresAt ?? fillIssuedAt + 60,
    nonce: nonce(fillNonceByte),
  };
  const fillTerms: FillV1Terms = {
    orderDigest: order.orderDigest,
    orderNonce: order.auth.nonce,
    intentDigest: intent.intentDigest,
    fillNonce: fillBase.nonce,
    takerEthAccount: `eip155:11155111:${intentBody.takerEthAccount}`,
    takerQrlAccount: taker.address,
    releaseCommitment,
    hashlock: fillBody.hashlock,
    initiatorTimeout: String(fillBody.initiatorTimeout),
    responderTimeout: String(fillBody.responderTimeout),
    issuedAt: String(fillBase.issuedAt),
    respondBy: String(fillBase.expiresAt),
    ...ORDER_V1_DEPLOYMENT,
  };
  const fillAuth = signedAuth(
    fillBase,
    buildFillV1Payload(fillTerms, fillBase.scheme),
    maker,
  );
  return { releaseSecret, intentBody, intentAuth, fillBody, fillAuth };
}

function makeCancel(
  now: number,
  order: VerifiedOrderV1,
  cancelNonceByte = 45,
): { cancel: CancelV1Body; auth: ProtocolAuthV1 } {
  const cancel: CancelV1Body = { orderDigest: order.orderDigest, reasonCode: 1 };
  const base = {
    version: "1" as const,
    scheme: "qrl-sign-typed-v1" as const,
    issuedAt: now,
    expiresAt: order.auth.expiresAt,
    nonce: nonce(cancelNonceByte),
  };
  const terms: CancelV1Terms = {
    orderDigest: order.orderDigest,
    orderNonce: order.auth.nonce,
    cancelNonce: base.nonce,
    issuedAt: String(base.issuedAt),
    reasonCode: cancel.reasonCode,
    ...ORDER_V1_DEPLOYMENT,
  };
  return {
    cancel,
    auth: signedAuth(base, buildCancelV1Payload(terms, base.scheme), maker),
  };
}

const temporaryDirectories: string[] = [];

function storeFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "quantaswap-protocol-store-"));
  temporaryDirectories.push(directory);
  return join(directory, "orders.json");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("single-use signed order store", () => {
  it("reconstructs a swept expired parent from a reset with eight intents and a live fill", async () => {
    const now = Math.floor(Date.now() / 1000);
    const historicalNow = now - 500;
    const order = makeOrder(historicalNow, {
      nonceByte: 70,
      issuedAt: now - 700,
      expiresAt: now - 300,
    });
    const artifacts = Array.from({ length: 8 }, (_value, index) =>
      makeFill(now, order, 71, 72, {
        requestNonceByte: 20 + index,
        intentIssuedAt: now - 450,
        intentExpiresAt: now - 330,
        fillIssuedAt: now - 391,
        fillExpiresAt: now - 301,
      }),
    );
    const selected = artifacts[0]!;
    const source = new OrderStore(storeFile());
    source.subscribeFederation(() => {
      source.federationSnapshot();
    });
    source.applyFederationEvent({
      kind: "order-v1",
      payload: { order: order.order, auth: order.auth },
    }, "origin");
    for (const artifact of artifacts) {
      source.applyFederationEvent({
        kind: "fill-intent-v1",
        payload: {
          orderId: order.orderId,
          intent: artifact.intentBody,
          auth: artifact.intentAuth,
        },
      }, "origin");
    }
    source.applyFederationEvent({
      kind: "fill-v1",
      payload: {
        orderId: order.orderId,
        fill: selected.fillBody,
        auth: selected.fillAuth,
        intent: selected.intentBody,
        intentAuth: selected.intentAuth,
      },
    }, "origin");
    assert.equal(source.get(order.orderId).status, "locking");

    const snapshot = source.federationSnapshot();
    assert.equal(snapshot.filter((event) => event.kind === "fill-intent-v1").length, 8);
    assert.equal(snapshot[0]?.kind, "order-v1");

    const receiverFile = storeFile();
    const receiver = new OrderStore(receiverFile);
    receiver.subscribeFederation(() => {
      receiver.federationSnapshot();
    });
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let clock = originalNow();
    let cycle = 0;
    Date.now = () => clock;
    globalThis.fetch = async () => {
      const selectedSnapshot = cycle === 0 ? [snapshot[0]!] : snapshot;
      const feedId = cycle === 0 ? "ab".repeat(16) : "cd".repeat(16);
      return new Response(
        JSON.stringify({
          reset: true,
          cursor: `${feedId}:0`,
          hasMore: false,
          events: [],
          snapshot: selectedSnapshot.map((event) => ({
            seq: 0,
            eventId: federationEventId(event),
            event,
          })),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    };
    try {
      const sync = new FederationPeerSync({
        peers: ["https://mirror.example/api"],
        timeoutMs: 10_000,
        apply: (event) => {
          try {
            receiver.applyFederationEvent(event, "peer-a");
            return "applied";
          } catch (error) {
            if (
              error instanceof ApiError &&
              (error.code === "federation_dependency" || error.code === "transient_capacity")
            ) {
              return "deferred";
            }
            return "rejected";
          }
        },
      });
      await sync.syncAll();
      assert.equal(receiver.get(order.orderId).status, "cancelled");
      clock += 301_000;
      receiver.federationSnapshot();
      assert.throws(
        () => receiver.get(order.orderId),
        (error) => error instanceof ApiError && error.status === 404,
      );

      cycle = 1;
      await sync.syncAll();
      assert.equal(receiver.get(order.orderId).status, "locking");
      assert.equal(new OrderStore(receiverFile).get(order.orderId).status, "locking");
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
    }
  });

  it("refuses persisted state beyond the portable public-order capacity", () => {
    const now = Math.floor(Date.now() / 1000);
    const rows: unknown[] = [];
    for (let offset = 0; offset < 65; offset += 1) {
      const sourceFile = storeFile();
      const source = new OrderStore(sourceFile);
      const order = makeOrder(now, { nonceByte: 80 + offset });
      source.createVerified(order, createCapabilities(order), "203.0.113.65");
      rows.push(...(JSON.parse(readFileSync(sourceFile, "utf8")) as unknown[]));
    }
    assert.equal(rows.length, 65);
    const legacyFile = storeFile();
    writeFileSync(legacyFile, JSON.stringify(rows));
    assert.throws(
      () => new OrderStore(legacyFile),
      /more than 64 portable public orders/,
    );
    assert.equal((JSON.parse(readFileSync(legacyFile, "utf8")) as unknown[]).length, 65);
  });

  it("caps one federation source while preserving capacity for another peer and local maker", () => {
    const now = Math.floor(Date.now() / 1000);
    const file = storeFile();
    const store = new OrderStore(file);
    for (let offset = 0; offset < 16; offset += 1) {
      store.importVerifiedOrder(
        makeOrder(now, { nonceByte: 150 + offset }),
        "peer-a",
      );
    }
    const restarted = new OrderStore(file);
    assert.throws(
      () =>
        restarted.importVerifiedOrder(
          makeOrder(now, { nonceByte: 166 }),
          "peer-a",
        ),
      (error) =>
        error instanceof ApiError &&
        error.status === 429 &&
        error.code === "transient_capacity",
    );
    assert.equal(
      restarted.importVerifiedOrder(
        makeOrder(now, { nonceByte: 167 }),
        "peer-b",
      ).id.length,
      64,
    );
    const localCapability = "ef".repeat(32);
    const local = makeOrder(now, {
      nonceByte: 168,
      makerCapability: localCapability,
    });
    assert.equal(
      restarted.createVerified(
        local,
        { makerToken: localCapability },
        "203.0.113.168",
      ).order.id,
      local.orderId,
    );
  });

  it("recovers an exact public create after response loss without rotating capabilities", () => {
    const now = Math.floor(Date.now() / 1000);
    const order = makeOrder(now, { nonceByte: 39 });
    const capabilities = createCapabilities(order);
    const file = storeFile();
    const store = new OrderStore(file);
    const created = store.createVerified(order, capabilities, "203.0.113.39");
    assert.equal(readFileSync(file, "utf8").includes(makerToken), false);
    const retried = store.createVerified(order, capabilities, "203.0.113.39");
    assert.equal(retried.order.id, created.order.id);
    assert.equal(retried.makerToken, makerToken);

    assert.throws(
      () =>
        store.createVerified(order, { makerToken: "00".repeat(32) }, "203.0.113.40"),
      (error) => error instanceof ApiError && error.status === 401,
    );
    assert.throws(
      () =>
        store.createVerified(
          order,
          { makerToken: order.auth.makerTokenCommitment.slice(2) },
          "203.0.113.40",
        ),
      (error) => error instanceof ApiError && error.status === 401,
    );

    const imported = new OrderStore(storeFile());
    imported.importVerifiedOrder(order);
    const recovered = imported.createVerified(order, capabilities, "203.0.113.39");
    assert.equal(recovered.order.id, order.orderId);
    assert.equal(recovered.makerToken, makerToken);
  });

  it("recovers a private create only with both committed capabilities", () => {
    const now = Math.floor(Date.now() / 1000);
    const order = makeOrder(now, {
      nonceByte: 40,
      visibility: "private",
    });
    const capabilities = createCapabilities(order);
    const file = storeFile();
    const store = new OrderStore(file);
    const created = store.createVerified(order, capabilities, "203.0.113.40");
    const persisted = readFileSync(file, "utf8");
    assert.equal(persisted.includes(makerToken), false);
    assert.equal(persisted.includes(shareToken), false);
    const retried = store.createVerified(order, capabilities, "203.0.113.40");
    assert.equal(retried.shareToken, shareToken);
    assert.equal(store.get(created.order.id, shareToken).id, created.order.id);
    assert.throws(
      () =>
        store.createVerified(
          order,
          { makerToken, shareToken: "00".repeat(32) },
          "203.0.113.40",
        ),
      (error) => error instanceof ApiError && error.status === 401,
    );
  });

  it("persists a terminal fill and commitment-authorized release", () => {
    const now = Math.floor(Date.now() / 1000);
    const file = storeFile();
    const store = new OrderStore(file);
    const order = makeOrder(now);
    const created = store.createVerified(
      order,
      createCapabilities(order),
      "203.0.113.10",
    );
    const artifacts = makeFill(now, order);

    store.submitFillIntent(
      order.orderId,
      artifacts.intentBody,
      artifacts.intentAuth,
      "198.51.100.20",
    );
    const filled = store.fillOrder(
      order.orderId,
      artifacts.fillBody,
      artifacts.fillAuth,
      artifacts.intentBody,
      artifacts.intentAuth,
    );
    assert.equal(filled.status, "locking");
    assert.equal(filled.fill?.hashlock, artifacts.fillBody.hashlock);
    assert.throws(
      () => store.accept(order.orderId, {}, "198.51.100.21"),
      (error) => error instanceof ApiError && error.status === 409,
    );

    const released = store.release(order.orderId, {
      fillDigest: filled.fillDigest,
      releaseSecret: artifacts.releaseSecret,
    });
    assert.equal(released.released, true);
    assert.equal("releaseSecret" in released, false);
    assert.equal(store.federationSnapshot().some((event) => event.kind === "release-v1"), true);

    const hydrated = new OrderStore(file).get(order.orderId);
    assert.equal(hydrated.status, "locking");
    assert.equal(hydrated.released, true);
    assert.equal(created.order.orderDigest, hydrated.orderDigest);
  });

  it("retains an early intent release through a late valid FillV1", () => {
    const now = Math.floor(Date.now() / 1000);
    const file = storeFile();
    const order = makeOrder(now, {
      nonceByte: 47,
      issuedAt: now - 700,
      expiresAt: now + 3600,
    });
    const artifacts = makeFill(now, order, 48, 49, {
      intentIssuedAt: now - 620,
      intentExpiresAt: now - 500,
      fillIssuedAt: now - 501,
      fillExpiresAt: now + 300,
    });
    const source = new OrderStore(file);
    source.createVerified(
      order,
      createCapabilities(order),
      "203.0.113.47",
    );
    source.importFillIntent(order.orderId, artifacts.intentBody, artifacts.intentAuth);
    const verifiedIntent = verifyFillIntentV1(
      artifacts.intentBody,
      artifacts.intentAuth,
      order,
      { allowExpired: true },
    );
    source.release(order.orderId, {
      intentDigest: verifiedIntent.intentDigest,
      releaseSecret: artifacts.releaseSecret,
    });

    const restarted = new OrderStore(file);
    const filled = restarted.fillOrder(
      order.orderId,
      artifacts.fillBody,
      artifacts.fillAuth,
      artifacts.intentBody,
      artifacts.intentAuth,
    );
    assert.equal(filled.status, "locking");
    assert.equal(filled.released, true);

    const mirror = new OrderStore(storeFile());
    for (const event of restarted.federationSnapshot()) {
      mirror.applyFederationEvent(event);
    }
    const mirrored = mirror.get(order.orderId);
    assert.equal(mirrored.status, "locking");
    assert.equal(mirrored.released, true);
  });

  it("quarantines contradictory terminal proofs and retains both across restart", () => {
    const now = Math.floor(Date.now() / 1000);
    const file = storeFile();
    const store = new OrderStore(file);
    const order = makeOrder(now, { nonceByte: 51 });
    const artifacts = makeFill(now, order);
    const cancellation = makeCancel(now, order);
    store.createVerified(order, createCapabilities(order));
    store.submitFillIntent(order.orderId, artifacts.intentBody, artifacts.intentAuth, "taker");
    store.cancelSigned(order.orderId, cancellation.cancel, cancellation.auth);
    store.fillOrder(
      order.orderId,
      artifacts.fillBody,
      artifacts.fillAuth,
      artifacts.intentBody,
      artifacts.intentAuth,
    );

    const quarantined = store.get(order.orderId);
    assert.equal(quarantined.equivocated, true);
    assert.equal(quarantined.status, "cancelled");
    assert.equal(quarantined.conflictDigests?.length, 1);
    assert.equal(store.listOpen().some((candidate) => candidate.id === order.orderId), false);
    const kinds = store.federationSnapshot().map((event) => event.kind);
    assert.equal(kinds.includes("cancel-v1"), true);
    assert.equal(kinds.includes("fill-v1"), true);

    const hydrated = new OrderStore(file).get(order.orderId);
    assert.equal(hydrated.equivocated, true);
    assert.deepEqual(hydrated.conflictDigests, quarantined.conflictDigests);
  });

  it("detects two signed term sets that reuse one order nonce", () => {
    const now = Math.floor(Date.now() / 1000);
    const store = new OrderStore(storeFile());
    const first = makeOrder(now, { nonceByte: 61 });
    const second = makeOrder(now, {
      nonceByte: 61,
      fromAmount: "2000000000000000",
    });
    store.importVerifiedOrder(first);
    const result = store.importVerifiedOrder(second);
    assert.equal(result.equivocated, true);
    assert.equal(result.conflictDigests?.includes(second.orderDigest), true);
    assert.equal(store.listOpen().some((candidate) => candidate.id === first.orderId), false);
  });

  it("retains terminal evidence for the referenced OrderV1 variant in either arrival order", () => {
    const now = Math.floor(Date.now() / 1000);
    const first = makeOrder(now, { nonceByte: 62 });
    const second = makeOrder(now, {
      nonceByte: 62,
      fromAmount: "2000000000000000",
    });
    const artifacts = makeFill(now, second, 63, 64);

    const firstThenSecond = new OrderStore(storeFile());
    firstThenSecond.importVerifiedOrder(first);
    assert.throws(
      () =>
        firstThenSecond.importFill(
          second.orderId,
          artifacts.fillBody,
          artifacts.fillAuth,
          artifacts.intentBody,
          artifacts.intentAuth,
        ),
      /referenced signed order variant is unavailable/,
    );
    firstThenSecond.importVerifiedOrder(second);
    const left = firstThenSecond.importFill(
      second.orderId,
      artifacts.fillBody,
      artifacts.fillAuth,
      artifacts.intentBody,
      artifacts.intentAuth,
    );

    const secondThenFirst = new OrderStore(storeFile());
    secondThenFirst.importVerifiedOrder(second);
    secondThenFirst.importVerifiedOrder(first);
    const right = secondThenFirst.importFill(
      second.orderId,
      artifacts.fillBody,
      artifacts.fillAuth,
      artifacts.intentBody,
      artifacts.intentAuth,
    );

    assert.equal(left.equivocated, true);
    assert.equal(right.equivocated, true);
    assert.equal(left.fillDigest, right.fillDigest);
    assert.equal(
      firstThenSecond.federationSnapshot().filter((event) => event.kind === "order-v1").length,
      2,
    );
    assert.equal(
      secondThenFirst.federationSnapshot().some((event) => event.kind === "fill-v1"),
      true,
    );
  });

  it("keeps private signed orders out of federation", () => {
    const now = Math.floor(Date.now() / 1000);
    const store = new OrderStore(storeFile());
    const privateOrder = makeOrder(now, { nonceByte: 71, visibility: "private" });
    store.createVerified(privateOrder, createCapabilities(privateOrder));
    assert.deepEqual(store.federationSnapshot(), []);
    assert.throws(
      () => store.importVerifiedOrder(privateOrder),
      (error) => error instanceof ApiError && error.status === 400,
    );
  });

  it("replays public protocol events into an independent mirror", () => {
    const now = Math.floor(Date.now() / 1000);
    const source = new OrderStore(storeFile());
    const mirror = new OrderStore(storeFile());
    const events: FederationEvent[] = [];
    source.subscribeFederation((event) => events.push(event));
    const order = makeOrder(now, { nonceByte: 81 });
    const artifacts = makeFill(now, order);
    source.createVerified(order, createCapabilities(order));
    source.submitFillIntent(order.orderId, artifacts.intentBody, artifacts.intentAuth, "taker");
    const filled = source.fillOrder(
      order.orderId,
      artifacts.fillBody,
      artifacts.fillAuth,
      artifacts.intentBody,
      artifacts.intentAuth,
    );
    source.release(order.orderId, {
      intentDigest: artifacts.fillBody.intentDigest,
      releaseSecret: artifacts.releaseSecret,
    });

    assert.deepEqual(
      events.map((event) => event.kind),
      ["order-v1", "fill-intent-v1", "fill-v1", "release-v1"],
    );
    for (const event of events) mirror.applyFederationEvent(event);
    for (const event of events) mirror.applyFederationEvent(event);
    const mirrored = mirror.get(order.orderId);
    assert.equal(mirrored.status, "locking");
    assert.equal(mirrored.released, true);
    assert.equal(mirrored.fillDigest, filled.fillDigest);
  });

  it("refuses pre-capability signed rows instead of treating them as another OrderV1", () => {
    const now = Math.floor(Date.now() / 1000);
    const file = storeFile();
    const initial = new OrderStore(file);
    const order = makeOrder(now, { nonceByte: 91 });
    initial.createVerified(order, createCapabilities(order));
    const rows = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
    const rawAuth = rows[0]?.["makerAuth"] as Record<string, unknown> | undefined;
    delete rawAuth?.["makerTokenCommitment"];
    delete rawAuth?.["shareTokenCommitment"];
    writeFileSync(file, JSON.stringify(rows));

    assert.throws(
      () => new OrderStore(file),
      /auth\.makerTokenCommitment is required/,
    );
  });
});
