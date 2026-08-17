// Real HTTP acceptance for two independent mirrors. By default this boots two
// built server processes with separate state, exercises bidirectional signed
// federation, simulates a partition and restart, and tears everything down.
// CI may point it at the loopback-only Compose lab through the two BASE envs.

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { SCHEME_TAG_TYPED, computeTypedDataDigest } from "@qrlwallet/connect";
import {
  CryptoBytes,
  CryptoPublicKeyBytes,
  CryptoSecretKeyBytes,
  cryptoSignKeypair,
  cryptoSignSignature,
} from "@theqrl/mldsa87";
import { shake256 } from "@noble/hashes/sha3.js";
import {
  ORDER_V1_DEPLOYMENT,
  buildCancelV1Payload,
  buildFillIntentV1Payload,
  buildFillV1Payload,
  buildOrderV1Payload,
  cancelDigest,
  computeMakerTokenCommitment,
  computeReleaseCommitment,
  computeShareTokenCommitment,
  deriveOrderV1Id,
  fillDigest,
  intentDigest,
  orderDigest,
} from "./dist/order-signing.js";

const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const SCHEME = "qrl-sign-typed-v1";
const DESCRIPTOR_BYTES = new Uint8Array([1, 0, 0]);
const DESCRIPTOR = hex(DESCRIPTOR_BYTES);
const ETH_MAKER = `0x${"11".repeat(20)}`;
const ETH_TAKER = `0x${"22".repeat(20)}`;
const ONE = "1000000000000000000";
const SERVER_ENTRY = new URL("./dist/server.js", import.meta.url).pathname;
const externalA = process.env.FEDERATION_SMOKE_BASE_A;
const externalB = process.env.FEDERATION_SMOKE_BASE_B;
const managed = externalA === undefined && externalB === undefined;
const READ_TOKEN_A = "aa".repeat(32);
const READ_TOKEN_B = "bb".repeat(32);

function hex(bytes) {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function concatBytes(...parts) {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function bytes32() {
  return `0x${randomBytes(32).toString("hex")}`;
}

function capability() {
  return randomBytes(32).toString("hex");
}

function createSigner(seedByte) {
  const publicKey = new Uint8Array(CryptoPublicKeyBytes);
  const secretKey = new Uint8Array(CryptoSecretKeyBytes);
  cryptoSignKeypair(new Uint8Array(32).fill(seedByte), publicKey, secretKey);
  const address = `Q${Buffer.from(
    shake256(concatBytes(DESCRIPTOR_BYTES, publicKey), { dkLen: 20 }),
  ).toString("hex")}`;
  return {
    address,
    publicKey: hex(publicKey),
    secretKey,
    close: () => secretKey.fill(0),
  };
}

function signPayload(signer, payload) {
  const signature = new Uint8Array(CryptoBytes);
  cryptoSignSignature(
    signature,
    computeTypedDataDigest(payload),
    signer.secretKey,
    false,
    SCHEME_TAG_TYPED,
  );
  return hex(signature);
}

function signedOrder(signer, options = {}) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 3600;
  const makerToken = capability();
  const shareToken = options.visibility === "private" ? capability() : undefined;
  const nonce = bytes32();
  const order = {
    direction: options.direction ?? "eth->qrl",
    asset: "ETH",
    fromAmount: ONE,
    toAmount: ONE,
    makerEthAccount: options.makerEthAccount ?? ETH_MAKER,
    makerQrlAccount: signer.address,
    visibility: options.visibility ?? "public",
  };
  const unsignedAuth = {
    version: "1",
    scheme: SCHEME,
    issuedAt,
    expiresAt,
    nonce,
    publicKey: signer.publicKey,
    descriptor: DESCRIPTOR,
    makerTokenCommitment: computeMakerTokenCommitment(makerToken),
    shareTokenCommitment:
      shareToken === undefined ? ZERO_BYTES32 : computeShareTokenCommitment(shareToken),
  };
  const terms = {
    direction: order.direction,
    asset: order.asset,
    fromAmount: order.fromAmount,
    toAmount: order.toAmount,
    makerEthAccount: `eip155:${ORDER_V1_DEPLOYMENT.ethChainId}:${order.makerEthAccount}`,
    makerQrlAccount: order.makerQrlAccount,
    visibility: order.visibility,
    allowedTakerEth: "",
    allowedTakerQrl: "",
    prelocked: false,
    hashlock: ZERO_BYTES32,
    initiatorTimeout: "0",
    issuedAt: String(issuedAt),
    expiresAt: String(expiresAt),
    nonce,
    makerTokenCommitment: unsignedAuth.makerTokenCommitment,
    shareTokenCommitment: unsignedAuth.shareTokenCommitment,
    ...ORDER_V1_DEPLOYMENT,
  };
  const auth = {
    ...unsignedAuth,
    signature: signPayload(signer, buildOrderV1Payload(terms, SCHEME)),
  };
  return {
    order,
    auth,
    terms,
    makerToken,
    ...(shareToken === undefined ? {} : { shareToken }),
    orderId: deriveOrderV1Id(signer.address, nonce),
    orderDigest: orderDigest(terms),
  };
}

function signedIntent(signer, orderProof) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = Math.min(issuedAt + 120, orderProof.auth.expiresAt);
  const requestNonce = bytes32();
  const releaseSecret = bytes32();
  const intent = {
    orderDigest: orderProof.orderDigest,
    takerEthAccount: ETH_TAKER,
    takerQrlAccount: signer.address,
    releaseCommitment: computeReleaseCommitment(
      orderProof.orderDigest,
      requestNonce,
      releaseSecret,
    ),
  };
  const unsignedAuth = {
    version: "1",
    scheme: SCHEME,
    issuedAt,
    expiresAt,
    nonce: requestNonce,
    publicKey: signer.publicKey,
    descriptor: DESCRIPTOR,
  };
  const terms = {
    orderDigest: intent.orderDigest,
    requestNonce,
    takerEthAccount: `eip155:${ORDER_V1_DEPLOYMENT.ethChainId}:${intent.takerEthAccount}`,
    takerQrlAccount: intent.takerQrlAccount,
    releaseCommitment: intent.releaseCommitment,
    issuedAt: String(issuedAt),
    expiresAt: String(expiresAt),
    ...ORDER_V1_DEPLOYMENT,
  };
  const auth = {
    ...unsignedAuth,
    signature: signPayload(signer, buildFillIntentV1Payload(terms, SCHEME)),
  };
  return {
    intent,
    auth,
    terms,
    releaseSecret,
    intentDigest: intentDigest(terms),
  };
}

function signedFill(signer, orderProof, intentProof) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const respondBy = issuedAt + 120;
  const fillNonce = bytes32();
  const secret = randomBytes(32);
  const fill = {
    orderDigest: orderProof.orderDigest,
    intentDigest: intentProof.intentDigest,
    takerEthAccount: intentProof.intent.takerEthAccount,
    takerQrlAccount: intentProof.intent.takerQrlAccount,
    releaseCommitment: intentProof.intent.releaseCommitment,
    hashlock: `0x${createHash("sha256").update(secret).digest("hex")}`,
    initiatorTimeout: issuedAt + 7200,
    responderTimeout: issuedAt + 3600,
  };
  secret.fill(0);
  const unsignedAuth = {
    version: "1",
    scheme: SCHEME,
    issuedAt,
    expiresAt: respondBy,
    nonce: fillNonce,
    publicKey: signer.publicKey,
    descriptor: DESCRIPTOR,
  };
  const terms = {
    orderDigest: fill.orderDigest,
    orderNonce: orderProof.auth.nonce,
    intentDigest: fill.intentDigest,
    fillNonce,
    takerEthAccount: `eip155:${ORDER_V1_DEPLOYMENT.ethChainId}:${fill.takerEthAccount}`,
    takerQrlAccount: fill.takerQrlAccount,
    releaseCommitment: fill.releaseCommitment,
    hashlock: fill.hashlock,
    initiatorTimeout: String(fill.initiatorTimeout),
    responderTimeout: String(fill.responderTimeout),
    issuedAt: String(issuedAt),
    respondBy: String(respondBy),
    ...ORDER_V1_DEPLOYMENT,
  };
  const auth = {
    ...unsignedAuth,
    signature: signPayload(signer, buildFillV1Payload(terms, SCHEME)),
  };
  return { fill, auth, terms, fillDigest: fillDigest(terms) };
}

function signedCancel(signer, orderProof) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const cancelNonce = bytes32();
  const cancel = { orderDigest: orderProof.orderDigest, reasonCode: 1 };
  const unsignedAuth = {
    version: "1",
    scheme: SCHEME,
    issuedAt,
    expiresAt: orderProof.auth.expiresAt,
    nonce: cancelNonce,
    publicKey: signer.publicKey,
    descriptor: DESCRIPTOR,
  };
  const terms = {
    orderDigest: cancel.orderDigest,
    orderNonce: orderProof.auth.nonce,
    cancelNonce,
    issuedAt: String(issuedAt),
    reasonCode: cancel.reasonCode,
    ...ORDER_V1_DEPLOYMENT,
  };
  const auth = {
    ...unsignedAuth,
    signature: signPayload(signer, buildCancelV1Payload(terms, SCHEME)),
  };
  return { cancel, auth, terms, cancelDigest: cancelDigest(terms) };
}

function normalizeExternalBase(value, name) {
  assert.equal(typeof value, "string", `${name} is required with the other external base`);
  const url = new URL(value);
  assert.equal(url.protocol, "http:", `${name} must use loopback HTTP`);
  assert.ok(
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]",
    `${name} must stay on loopback`,
  );
  assert.equal(url.username, "", `${name} cannot contain credentials`);
  assert.equal(url.password, "", `${name} cannot contain credentials`);
  assert.equal(url.search, "", `${name} cannot contain a query`);
  assert.equal(url.hash, "", `${name} cannot contain a fragment`);
  return url.toString().replace(/\/$/, "");
}

async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => socket.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function spawnMirror(name, port, peerBase, directory) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      NODE_ENV: "test",
      ORDERBOOK_HOST: "127.0.0.1",
      PORT: String(port),
      ORDERBOOK_DATA: join(directory, "orders.json"),
      ORDERBOOK_FEDERATION_DATA: join(directory, "federation.json"),
      ORDERBOOK_FEDERATION_PEERS: peerBase,
      ORDERBOOK_FEDERATION_PEER_IDS: name === "mirror-a" ? "mirror-b" : "mirror-a",
      ORDERBOOK_FEDERATION_PEER_TOKENS: name === "mirror-a" ? READ_TOKEN_B : READ_TOKEN_A,
      ORDERBOOK_FEDERATION_ONION_ONLY: "false",
      ORDERBOOK_FEDERATION_ONION_PROXY: "",
      ORDERBOOK_FEDERATION_ALLOW_INSECURE_PEER_TOKENS: "true",
      ORDERBOOK_FEDERATION_READ_TOKEN: name === "mirror-a" ? READ_TOKEN_A : READ_TOKEN_B,
      ORDERBOOK_FEDERATION_SYNC_MS: "1000",
      ORDERBOOK_FEDERATION_REQUEST_TIMEOUT_MS: "1000",
      ORDERBOOK_TRUST_PROXY: "none",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  const capture = (chunk) => {
    logs = `${logs}${chunk.toString("utf8")}`.slice(-64 * 1024);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  return { name, child, logs: () => logs };
}

async function stopMirror(mirror) {
  if (mirror === null || mirror.child.exitCode !== null) return;
  const exited = once(mirror.child, "exit");
  mirror.child.kill("SIGTERM");
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, 5000, "timeout");
  });
  const outcome = await Promise.race([exited, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome === "timeout") {
    if (mirror.child.exitCode === null) mirror.child.kill("SIGKILL");
    await exited;
  }
}

async function api(base, method, path, body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    redirect: "error",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    signal: AbortSignal.timeout(3000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  return { status: response.status, body: payload };
}

async function eventually(name, probe, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== false && value !== null && value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${name} did not converge${lastError ? `: ${lastError.message}` : ""}`);
}

async function waitForHealth(base) {
  await eventually("mirror health", async () => (await api(base, "GET", "/health")).status === 200);
}

async function waitForPeerState(base, expected) {
  return eventually(`federation peer state ${expected}`, async () => {
    const status = await api(base, "GET", "/status");
    return status.status === 200 && status.body.federation?.peers?.[0]?.state === expected
      ? status.body
      : false;
  });
}

async function waitForOrder(base, id, status) {
  return eventually(`order ${id} status ${status}`, async () => {
    const result = await api(base, "GET", `/orders/${id}`);
    return result.status === 200 && result.body.order?.status === status
      ? result.body.order
      : false;
  });
}

async function postSignedOrder(base, proof) {
  return api(base, "POST", "/orders/signed", {
    order: proof.order,
    auth: proof.auth,
    makerToken: proof.makerToken,
    ...(proof.shareToken === undefined ? {} : { shareToken: proof.shareToken }),
  });
}

let rootDirectory;
let mirrorA = null;
let mirrorB = null;
const maker = createSigner(21);
const taker = createSigner(22);

try {
  if ((externalA === undefined) !== (externalB === undefined)) {
    throw new Error("both FEDERATION_SMOKE_BASE_A and FEDERATION_SMOKE_BASE_B are required");
  }

  let baseA;
  let baseB;
  let directoryA;
  let directoryB;
  let portA;
  let portB;
  if (managed) {
    rootDirectory = mkdtempSync(join(tmpdir(), "quantaswap-federation-http-"));
    directoryA = join(rootDirectory, "mirror-a");
    directoryB = join(rootDirectory, "mirror-b");
    portA = await freePort();
    do portB = await freePort(); while (portB === portA);
    baseA = `http://127.0.0.1:${portA}/api`;
    baseB = `http://127.0.0.1:${portB}/api`;
    mirrorA = spawnMirror("mirror-a", portA, baseB, directoryA);
    mirrorB = spawnMirror("mirror-b", portB, baseA, directoryB);
  } else {
    baseA = normalizeExternalBase(externalA, "FEDERATION_SMOKE_BASE_A");
    baseB = normalizeExternalBase(externalB, "FEDERATION_SMOKE_BASE_B");
  }

  await Promise.all([waitForHealth(baseA), waitForHealth(baseB)]);
  const [statusA, statusB] = await Promise.all([
    waitForPeerState(baseA, "healthy"),
    waitForPeerState(baseB, "healthy"),
  ]);
  for (const [status, peerBase] of [[statusA, baseB], [statusB, baseA]]) {
    const publicStatus = JSON.stringify(status);
    assert.equal(publicStatus.includes(peerBase), false);
    assert.equal(publicStatus.includes("feedId"), false);
    assert.equal(publicStatus.includes("cursor"), false);
    assert.equal(publicStatus.includes(READ_TOKEN_A), false);
    assert.equal(publicStatus.includes(READ_TOKEN_B), false);
  }
  console.log("federation HTTP acceptance:");
  console.log("  ok: two reciprocal mirrors synchronized over HTTP");

  const publicResetStatuses = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await api(
      baseA,
      "GET",
      `/federation/v1/events?cursor=foreign-${attempt}&limit=1`,
    );
    publicResetStatuses.push(response.status);
  }
  assert.deepEqual(publicResetStatuses, [200, 200, 200, 200, 429]);
  const authenticatedReset = await api(
    baseA,
    "GET",
    "/federation/v1/events?cursor=authenticated-lane&limit=1",
    undefined,
    { Authorization: `Bearer ${READ_TOKEN_A}` },
  );
  assert.equal(authenticatedReset.status, 200);
  assert.equal(authenticatedReset.body.reset, true);
  const authenticatedCursor = authenticatedReset.body.cursor;
  assert.equal(typeof authenticatedCursor, "string");
  console.log("  ok: authenticated peer capacity remains available after public exhaustion");

  const orderA = signedOrder(maker);
  const createdA = await postSignedOrder(baseA, orderA);
  assert.equal(createdA.status, 201);
  assert.equal(createdA.body.order?.id, orderA.orderId);
  await waitForOrder(baseB, orderA.orderId, "open");
  console.log("  ok: public OrderV1 propagated from mirror A to mirror B");

  const intent = signedIntent(taker, orderA);
  const submittedIntent = await api(baseB, "POST", `/orders/${orderA.orderId}/intents`, {
    intent: intent.intent,
    auth: intent.auth,
  });
  assert.equal(submittedIntent.status, 201);
  await eventually("FillIntentV1 propagation", async () => {
    const result = await api(baseA, "GET", `/orders/${orderA.orderId}/intents`, undefined, {
      "X-Maker-Token": orderA.makerToken,
    });
    return result.status === 200 &&
      result.body.intents?.some((candidate) => candidate.intentDigest === intent.intentDigest);
  });
  console.log("  ok: taker FillIntentV1 propagated back to the maker origin");

  const fill = signedFill(maker, orderA, intent);
  const filled = await api(
    baseA,
    "POST",
    `/orders/${orderA.orderId}/fill`,
    {
      fill: fill.fill,
      auth: fill.auth,
      intent: intent.intent,
      intentAuth: intent.auth,
    },
    { "X-Maker-Token": orderA.makerToken },
  );
  assert.equal(filled.status, 200);
  assert.equal(filled.body.order?.fillDigest, fill.fillDigest);
  const mirroredFill = await waitForOrder(baseB, orderA.orderId, "locking");
  assert.equal(mirroredFill.fillDigest, fill.fillDigest);
  console.log("  ok: authenticated FillV1 converged on both mirrors");

  const orderB = signedOrder(maker, {
    direction: "qrl->eth",
    makerEthAccount: `0x${"33".repeat(20)}`,
  });
  assert.equal((await postSignedOrder(baseB, orderB)).status, 201);
  await waitForOrder(baseA, orderB.orderId, "open");
  const cancellation = signedCancel(maker, orderB);
  const cancelled = await api(
    baseB,
    "POST",
    `/orders/${orderB.orderId}/cancel/signed`,
    { cancel: cancellation.cancel, auth: cancellation.auth },
    { "X-Maker-Token": orderB.makerToken },
  );
  assert.equal(cancelled.status, 200);
  const mirroredCancel = await waitForOrder(baseA, orderB.orderId, "cancelled");
  assert.equal(mirroredCancel.cancelDigest, cancellation.cancelDigest);
  console.log("  ok: reverse-direction OrderV1 and CancelV1 propagation passed");

  const privateOrder = signedOrder(maker, { visibility: "private" });
  assert.equal((await postSignedOrder(baseA, privateOrder)).status, 201);
  const unsigned = await api(baseA, "POST", "/orders", {
    direction: "eth->qrl",
    asset: "ETH",
    fromAmount: ONE,
    toAmount: ONE,
    makerEthAccount: ETH_MAKER,
    makerQrlAccount: maker.address,
  });
  assert.equal(unsigned.status, 201);
  const beforePoll = (await api(baseB, "GET", "/status")).body.federation.peers[0].lastAttemptAt;
  await eventually("one exclusion sync cycle", async () => {
    const after = (await api(baseB, "GET", "/status")).body.federation.peers[0].lastAttemptAt;
    return typeof after === "number" && after > beforePoll;
  });
  assert.equal((await api(baseB, "GET", `/orders/${privateOrder.orderId}`)).status, 404);
  assert.equal((await api(baseB, "GET", `/orders/${unsigned.body.order.id}`)).status, 404);
  const feed = await api(
    baseA,
    "GET",
    `/federation/v1/events?cursor=${encodeURIComponent(authenticatedCursor)}&limit=256`,
    undefined,
    { Authorization: `Bearer ${READ_TOKEN_A}` },
  );
  assert.equal(feed.status, 200);
  const publicFeed = JSON.stringify(feed.body);
  assert.equal(publicFeed.includes(privateOrder.orderId), false);
  assert.equal(publicFeed.includes(unsigned.body.order.id), false);
  const rawCapabilities = [
    orderA.makerToken,
    orderB.makerToken,
    privateOrder.makerToken,
    privateOrder.shareToken,
    READ_TOKEN_A,
    READ_TOKEN_B,
  ];
  for (const rawCapability of rawCapabilities) {
    assert.equal(publicFeed.includes(rawCapability), false);
  }
  console.log("  ok: private, unsigned, and raw capability data stayed origin-local");

  const privateCancel = signedCancel(maker, privateOrder);
  assert.equal(
    (
      await api(
        baseA,
        "POST",
        `/orders/${privateOrder.orderId}/cancel/signed`,
        { cancel: privateCancel.cancel, auth: privateCancel.auth },
        { "X-Maker-Token": privateOrder.makerToken },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await api(baseA, "POST", `/orders/${unsigned.body.order.id}/cancel`, {
        token: unsigned.body.makerToken,
      })
    ).status,
    200,
  );

  if (managed) {
    const persistedFiles = [
      join(directoryA, "orders.json"),
      join(directoryA, "federation.json"),
      join(directoryB, "orders.json"),
      join(directoryB, "federation.json"),
    ].map((file) => readFileSync(file, "utf8"));
    for (const persisted of persistedFiles) {
      for (const rawCapability of rawCapabilities) {
        assert.equal(persisted.includes(rawCapability), false);
      }
    }

    await stopMirror(mirrorB);
    mirrorB = null;
    const catchup = signedOrder(maker, {
      makerEthAccount: `0x${"44".repeat(20)}`,
    });
    assert.equal((await postSignedOrder(baseA, catchup)).status, 201);
    for (const file of [
      join(directoryA, "orders.json"),
      join(directoryA, "federation.json"),
    ]) {
      assert.equal(readFileSync(file, "utf8").includes(catchup.makerToken), false);
    }
    await waitForPeerState(baseA, "degraded");
    mirrorB = spawnMirror("mirror-b", portB, baseA, directoryB);
    await waitForHealth(baseB);
    await waitForOrder(baseB, catchup.orderId, "open");
    await waitForPeerState(baseB, "healthy");
    for (const file of [
      join(directoryB, "orders.json"),
      join(directoryB, "federation.json"),
    ]) {
      assert.equal(readFileSync(file, "utf8").includes(catchup.makerToken), false);
    }
    console.log("  ok: a partitioned mirror recovered through a restart reset snapshot");

    await stopMirror(mirrorA);
    mirrorA = null;
    const degraded = await waitForPeerState(baseB, "degraded");
    assert.equal(degraded.status, "ok");
    assert.equal((await api(baseB, "GET", "/health")).status, 200);
    console.log("  ok: peer outage is visible without failing local readiness");
  }
} catch (error) {
  console.error("federation HTTP acceptance failed:", error);
  if (mirrorA !== null && mirrorA.logs() !== "") console.error("mirror A logs:\n", mirrorA.logs());
  if (mirrorB !== null && mirrorB.logs() !== "") console.error("mirror B logs:\n", mirrorB.logs());
  process.exitCode = 1;
} finally {
  await Promise.all([stopMirror(mirrorA), stopMirror(mirrorB)]);
  maker.close();
  taker.close();
  if (rootDirectory !== undefined) rmSync(rootDirectory, { recursive: true, force: true });
}
