// Admission over HTTP, against a real order book process.
//
// Saturation here is held by state the test owns: a socket that has sent its
// headers and a Content-Length and no body occupies a body-read slot until the
// read deadline, which the test sets. Nothing below depends on two requests
// overlapping by luck, which is not a property of the code and does not survive
// a loaded or single-core runner.
//
// The mutation bound's arithmetic, including the maker reservation and the
// signed-create sub-reserve, is exercised directly in admission.test.ts. The
// refusal it produces uses the same helper and carries the same headers as the
// body-read refusal asserted here.

import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { connect, createServer, type Socket } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const serverEntry = fileURLToPath(new URL("./server.js", import.meta.url));

const tempDirectories: string[] = [];
const children: ChildProcess[] = [];
const sockets: Socket[] = [];

after(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("could not reserve a loopback port"));
        return;
      }
      const { port } = address;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

interface StartedBook {
  child: ChildProcess;
  port: number;
  directory: string;
  dataFile: string;
  federationDataFile: string;
}

async function startBook(
  overrides: Record<string, string> = {},
): Promise<StartedBook> {
  const directory = mkdtempSync(join(tmpdir(), "quantaswap-inflight-"));
  tempDirectories.push(directory);
  const port = await freePort();
  const dataFile = join(directory, "orders.json");
  const federationDataFile = join(directory, "orders.json.federation");
  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      PORT: String(port),
      ORDERBOOK_HOST: "127.0.0.1",
      ORDERBOOK_DATA: dataFile,
      ORDERBOOK_FEDERATION_DATA: federationDataFile,
      ORDERBOOK_FEDERATION_PEERS: "",
      ORDERBOOK_FEDERATION_PEER_IDS: "",
      ORDERBOOK_FEDERATION_PEER_TOKENS: "",
      ORDERBOOK_FEDERATION_ONION_ONLY: "false",
      ORDERBOOK_FEDERATION_ONION_PROXY: "",
      ORDERBOOK_FEDERATION_READ_TOKEN: "",
      // The same trusted-proxy path the service uses in production, so each
      // synthetic client below is a distinct source to every per-source
      // budget. Without it every request here would be 127.0.0.1.
      ORDERBOOK_TRUST_PROXY: "loopback",
      ORDERBOOK_CORS_ORIGINS: "",
      PRESENCE_TTL_S: "90",
      ...overrides,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(child);
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/api/health`);
      await res.text();
      if (res.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error("the order book never became healthy");
    }
    await delay(100);
  }
  return { child, port, directory, dataFile, federationDataFile };
}

const makerOrder = (index: number): string =>
  JSON.stringify({
    direction: "eth->qrl",
    fromAmount: (10n ** 18n).toString(),
    toAmount: (10n ** 18n).toString(),
    makerEthAccount: `0x${index.toString(16).padStart(40, "0")}`,
    makerQrlAccount: `Q${index.toString(16).padStart(128, "0")}`,
  });

interface Reply {
  status: number;
  retryAfter: string | null;
  stage: string | null;
  body: Record<string, unknown>;
}

async function postOrder(
  port: number,
  index: number,
  forwardedFor?: string,
): Promise<Reply> {
  const res = await fetch(`http://127.0.0.1:${String(port)}/api/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(forwardedFor === undefined
        ? {}
        : { "X-Forwarded-For": forwardedFor }),
    },
    body: makerOrder(index),
  });
  return {
    status: res.status,
    retryAfter: res.headers.get("retry-after"),
    stage: res.headers.get("x-refusal-stage"),
    body: (await res.json()) as Record<string, unknown>,
  };
}

/** A request with full headers and a promised body that never arrives. */
async function halfOpenPost(
  port: number,
  bytes = 400,
  forwardedFor?: string,
): Promise<Socket> {
  const socket = connect(port, "127.0.0.1");
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => {
      resolve();
    });
    socket.once("error", reject);
  });
  socket.write(
    "POST /api/orders HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
      (forwardedFor === undefined
        ? ""
        : `X-Forwarded-For: ${forwardedFor}\r\n`) +
      `Content-Type: application/json\r\nContent-Length: ${String(bytes)}\r\n\r\n`,
  );
  return socket;
}

/**
 * Waits until the taker share of the body-read bound is known to be full. It
 * asks the book, so the wait ends on the condition itself and never on a guess
 * at how long filling it takes. The probe sends an empty JSON body: a `503`
 * means the lane had no slot for it, and a `4xx` from the store means the body
 * was read, so the lane still has room. Either way the store is left
 * untouched, and every attempt uses a fresh source so no per-source budget is
 * spent on waiting.
 */
async function awaitTakerBodyLaneFull(port: number): Promise<void> {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": `203.0.113.${String(attempt)}`,
      },
      body: "{}",
    });
    await res.json();
    if (res.status === 503) {
      assert.equal(res.headers.get("x-refusal-stage"), "pre-verification");
      return;
    }
    assert.ok(
      res.status >= 400 && res.status < 500,
      `a probe body must be refused by the store, got ${String(res.status)}`,
    );
    await delay(20);
  }
  throw new Error("the taker body-read lane never filled");
}

function readSocket(socket: Socket): Promise<string> {
  return new Promise<string>((resolve) => {
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.includes("\r\n\r\n")) resolve(text);
    });
    socket.once("close", () => {
      resolve(text);
    });
    socket.once("error", () => {
      resolve(text);
    });
  });
}

describe("write admission over HTTP", () => {
  it(
    "refuses a write burst at the door and keeps reads answering",
    { timeout: 120_000 },
    async () => {
      const book = await startBook({
        // Four body-read slots for the taker lane, four held for the maker
        // lane, and a deadline long enough that the held sockets stay held for
        // the whole case.
        ORDERBOOK_MAX_INFLIGHT_BODY_READS: "8",
        ORDERBOOK_RESERVED_MAKER_BODY_READS: "4",
        ORDERBOOK_BODY_READ_TIMEOUT_MS: "30000",
      });
      // Two sources at the per-source limit of two fill the taker lane's whole
      // share, so from here every taker write is refused with no timing
      // involved.
      const held: Socket[] = [];
      for (const source of ["198.51.100.11", "198.51.100.12"]) {
        held.push(await halfOpenPost(book.port, 400, source));
        held.push(await halfOpenPost(book.port, 400, source));
      }
      await awaitTakerBodyLaneFull(book.port);
      const burst = await Promise.all(
        Array.from({ length: 12 }, (_value, index) =>
          postOrder(book.port, index + 1, `198.51.100.${String(index + 21)}`),
        ),
      );
      assert.equal(
        burst.filter((reply) => reply.status === 503).length,
        burst.length,
      );
      for (const reply of burst) {
        assert.equal(reply.retryAfter, "1");
        assert.equal(reply.stage, "pre-verification");
        assert.deepEqual(reply.body, {
          error:
            "order book has too many request bodies in flight, retry shortly",
        });
      }

      // Reads and the probes are not gated, so the book stays answerable
      // while it refuses writes.
      const health = await fetch(
        `http://127.0.0.1:${String(book.port)}/api/health`,
      );
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: "ok" });
      const listing = (await fetch(
        `http://127.0.0.1:${String(book.port)}/api/orders`,
      ).then((res) => res.json())) as { orders: unknown[] };
      // A refused request leaves nothing behind.
      assert.equal(listing.orders.length, 0);
      assert.throws(() => readFileSync(book.dataFile, "utf8"));

      // The slots come back when the requests holding them end, so a write is
      // admitted again.
      for (const socket of held) socket.destroy();
      await delay(200);
      const admitted = await postOrder(book.port, 200, "198.51.100.40");
      assert.equal(admitted.status, 201);
      const persisted = JSON.parse(
        readFileSync(book.dataFile, "utf8"),
      ) as unknown[];
      assert.equal(persisted.length, 1);
    },
  );

  it(
    "keeps a half-open request out of the mutation bound",
    { timeout: 120_000 },
    async () => {
      const book = await startBook({
        ORDERBOOK_MAX_INFLIGHT_MUTATIONS: "2",
        ORDERBOOK_RESERVED_MAKER_MUTATIONS: "1",
        ORDERBOOK_BODY_READ_TIMEOUT_MS: "2000",
      });
      // Four requests that promise a body and send none, which is twice the
      // whole mutation bound. Before the bound moved behind the body read,
      // two of these refused every writer for the request timeout.
      const held = await Promise.all([
        halfOpenPost(book.port, 400, "198.51.100.11"),
        halfOpenPost(book.port, 400, "198.51.100.12"),
        halfOpenPost(book.port, 400, "198.51.100.13"),
        halfOpenPost(book.port, 400, "198.51.100.14"),
      ]);
      await delay(300);
      const legitimate = await postOrder(book.port, 1, "198.51.100.20");
      assert.equal(legitimate.status, 201);

      // Each half-open request is answered at the read deadline and lets go.
      const replies = await Promise.all(
        held.map((socket) => readSocket(socket)),
      );
      for (const reply of replies) {
        assert.match(reply, /^HTTP\/1\.1 408 /);
        assert.match(reply, /request body was too slow/);
      }
      for (const socket of held) socket.destroy();

      // Nothing leaked: the bound is free again.
      const after = await postOrder(book.port, 2, "198.51.100.21");
      assert.equal(after.status, 201);
    },
  );

  it(
    "cuts a slow body at the read deadline",
    { timeout: 120_000 },
    async () => {
      const book = await startBook({
        ORDERBOOK_BODY_READ_TIMEOUT_MS: "500",
      });
      const socket = await halfOpenPost(book.port, 4000, "198.51.100.80");
      socket.write("{");
      const startedAt = Date.now();
      const reply = await readSocket(socket);
      const elapsed = Date.now() - startedAt;
      assert.match(reply, /^HTTP\/1\.1 408 /);
      assert.match(reply, /x-refusal-stage: pre-verification/i);
      assert.match(reply, /connection: close/i);
      // The read deadline is what ends this request, so it ends long before
      // ORDERBOOK_REQUEST_TIMEOUT_MS, which is 15 s and would be the other way
      // for it to end. The margin is wide because the assertion is about which
      // limit fired, and not about the scheduler.
      assert.ok(
        elapsed < 10_000,
        `the deadline must cut the read early, took ${String(elapsed)} ms`,
      );
      socket.destroy();
      const after = await postOrder(book.port, 1);
      assert.equal(after.status, 201);
    },
  );

  it(
    "returns a slot when the handler throws and when a body is aborted",
    { timeout: 120_000 },
    async () => {
      const book = await startBook({
        ORDERBOOK_MAX_INFLIGHT_MUTATIONS: "2",
        ORDERBOOK_RESERVED_MAKER_MUTATIONS: "1",
      });
      // Handlers that throw: an invalid order body is refused inside the slot.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const res = await fetch(
          `http://127.0.0.1:${String(book.port)}/api/orders`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Forwarded-For": `192.0.2.${String(40 + attempt)}`,
            },
            body: JSON.stringify({ direction: "nonsense" }),
          },
        );
        // The body is refused inside the slot, whichever check catches it.
        assert.ok(res.status >= 400 && res.status < 500, String(res.status));
        await res.json();
      }
      // Bodies that stop halfway and abort. Each one gets its own source, so a
      // slot that is slow to come back cannot be mistaken for one that leaked.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const socket = await halfOpenPost(
          book.port,
          4000,
          `198.51.100.${String(90 + attempt)}`,
        );
        socket.write("{");
        await delay(20);
        socket.destroy();
      }
      // Nothing leaked: both bounds admit a write again, from a source that
      // held none of the slots above.
      const after = await postOrder(book.port, 1, "198.51.100.99");
      assert.equal(after.status, 201);
    },
  );

  it(
    "keeps the maker lane open when the body-read bound is exhausted",
    { timeout: 120_000 },
    async () => {
      const book = await startBook({
        ORDERBOOK_MAX_INFLIGHT_BODY_READS: "8",
        ORDERBOOK_RESERVED_MAKER_BODY_READS: "4",
        ORDERBOOK_BODY_READ_TIMEOUT_MS: "3000",
      });
      const created = await postOrder(book.port, 1, "192.0.2.10");
      assert.equal(created.status, 201);
      const order = created.body["order"] as Record<string, unknown>;
      const id = String(order["id"]);
      const makerToken = String(created.body["makerToken"]);

      // Four sources, two half-open bodies each, which is the whole taker
      // share of the body-read bound. Every further taker body is refused,
      // and none of them ever reaches the mutation bound at all.
      const held: Socket[] = [];
      const floodSources = [
        "198.51.100.31",
        "198.51.100.32",
        "198.51.100.33",
        "198.51.100.34",
      ];
      for (const source of floodSources) {
        held.push(await halfOpenPost(book.port, 400, source));
        held.push(await halfOpenPost(book.port, 400, source));
      }
      await awaitTakerBodyLaneFull(book.port);
      const refusedTaker = await postOrder(book.port, 2, "198.51.100.40");
      assert.equal(refusedTaker.status, 503);
      assert.equal(refusedTaker.stage, "pre-verification");
      assert.deepEqual(refusedTaker.body, {
        error:
          "order book has too many request bodies in flight, retry shortly",
      });

      // The maker's lane is a different share of the same bound, so a caller
      // that presents the order's capability still gets its body read and its
      // cancel served. This is the whole point of the reservation: a flood of
      // bodies must not be able to refuse the route that stops the bleeding.
      const cancelled = await fetch(
        `http://127.0.0.1:${String(book.port)}/api/orders/${id}/cancel`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "192.0.2.10",
            "X-Maker-Token": makerToken,
          },
          body: JSON.stringify({}),
        },
      );
      const cancelBody = (await cancelled.json()) as {
        order?: { status?: string };
      };
      assert.equal(cancelled.status, 200);
      assert.equal(cancelBody.order?.status, "cancelled");

      for (const socket of held) socket.destroy();
      await delay(200);
      const resumed = await postOrder(book.port, 3, "198.51.100.41");
      assert.equal(resumed.status, 201);
    },
  );

  it(
    "admits the shipped maker client's cancel while takers are refused",
    { timeout: 120_000 },
    async () => {
      const book = await startBook({
        ORDERBOOK_MAX_INFLIGHT_BODY_READS: "8",
        ORDERBOOK_RESERVED_MAKER_BODY_READS: "4",
        ORDERBOOK_BODY_READ_TIMEOUT_MS: "30000",
      });
      const created = await postOrder(book.port, 1, "192.0.2.10");
      assert.equal(created.status, 201);
      const order = created.body["order"] as Record<string, unknown>;
      const id = String(order["id"]);
      const makerToken = String(created.body["makerToken"]);

      const held: Socket[] = [];
      for (const source of ["198.51.100.61", "198.51.100.62"]) {
        held.push(await halfOpenPost(book.port, 400, source));
        held.push(await halfOpenPost(book.port, 400, source));
      }
      // The taker lane is full, held by sockets this test owns, and the book
      // confirms it before anything else is asserted.
      await awaitTakerBodyLaneFull(book.port);
      const refused = await postOrder(book.port, 2, "198.51.100.70");
      assert.equal(refused.status, 503);

      // The request both shipped maker clients send for a legacy cancel: the
      // capability in X-Maker-Token, which is what the admission gate reads
      // before the body, and the same value in the body, which is what an
      // order book from before the reserved lane authenticates against. See
      // frontend/src/lib/orderbookClient.ts and marketmaker/src/orderbook.ts,
      // whose own tests pin that shape.
      const cancelled = await fetch(
        `http://127.0.0.1:${String(book.port)}/api/orders/${id}/cancel`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "192.0.2.10",
            "X-Maker-Token": makerToken,
          },
          body: JSON.stringify({ token: makerToken }),
        },
      );
      const cancelBody = (await cancelled.json()) as {
        order?: { status?: string };
      };
      assert.equal(cancelled.status, 200);
      assert.equal(cancelBody.order?.status, "cancelled");
      for (const socket of held) socket.destroy();
    },
  );

  it(
    "keeps a maker route without its capability in the taker lane",
    { timeout: 120_000 },
    async () => {
      const book = await startBook({
        ORDERBOOK_MAX_INFLIGHT_BODY_READS: "8",
        ORDERBOOK_RESERVED_MAKER_BODY_READS: "4",
        ORDERBOOK_BODY_READ_TIMEOUT_MS: "3000",
      });
      const created = await postOrder(book.port, 1, "192.0.2.10");
      assert.equal(created.status, 201);
      const order = created.body["order"] as Record<string, unknown>;
      const id = String(order["id"]);

      const held: Socket[] = [];
      const floodSources = [
        "198.51.100.51",
        "198.51.100.52",
        "198.51.100.53",
        "198.51.100.54",
      ];
      for (const source of floodSources) {
        held.push(await halfOpenPost(book.port, 400, source));
        held.push(await halfOpenPost(book.port, 400, source));
      }
      await awaitTakerBodyLaneFull(book.port);

      // A maker path is not a maker: naming one without the capability would
      // otherwise be a way for anyone to reach the reserved share.
      for (const token of [undefined, "ff".repeat(32)]) {
        const reply = await fetch(
          `http://127.0.0.1:${String(book.port)}/api/orders/${id}/cancel`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Forwarded-For": "198.51.100.60",
              ...(token === undefined ? {} : { "X-Maker-Token": token }),
            },
            body: JSON.stringify({}),
          },
        );
        await reply.json();
        assert.equal(reply.status, 503);
        assert.equal(reply.headers.get("x-refusal-stage"), "pre-verification");
      }
      for (const socket of held) socket.destroy();
    },
  );

  it(
    "persists every create it answered with 201",
    { timeout: 120_000 },
    async () => {
      const book = await startBook();
      const replies = await Promise.all(
        Array.from({ length: 24 }, (_value, index) =>
          postOrder(book.port, index + 1, `198.51.100.${String(index + 1)}`),
        ),
      );
      const ids = replies
        .filter((reply) => reply.status === 201)
        .map((reply) => {
          const order = reply.body["order"] as Record<string, unknown>;
          return String(order["id"]);
        });
      assert.ok(ids.length >= 1);
      // Every receipt the book handed out is on disk, in both files, with no
      // further request needed to get it there.
      const persisted = JSON.parse(
        readFileSync(book.dataFile, "utf8"),
      ) as Array<Record<string, unknown>>;
      const persistedIds = new Set(persisted.map((row) => String(row["id"])));
      for (const id of ids) assert.ok(persistedIds.has(id), `${id} is on disk`);
      const feed = readFileSync(book.federationDataFile, "utf8");
      assert.ok(feed.length > 0);
      assert.equal(persisted.length, ids.length);
    },
  );
});
