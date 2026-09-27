// The in-flight gate and the body-read bound are HTTP admission rules, so they
// are only proven by running the real service and racing real sockets at it.

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
      probe.close(() => resolve(port));
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
    socket.once("connect", () => resolve());
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

interface StagedRequest {
  socket: Socket;
  /** Sends the one byte still missing, which completes the body. */
  finish: () => void;
  reply: Promise<{ status: number; stage: string | null; text: string }>;
}

/**
 * A POST on its own socket with every byte of the body but the last already
 * sent, so the server has parsed the request and is waiting on one byte.
 *
 * This is how the tests below get requests genuinely in flight together. The
 * global fetch pools and can serialise requests to one origin, and even one
 * socket per request only overlaps when the connects and writes happen to land
 * in the same event-loop turn, which a slower machine does not guarantee.
 * Staging first and then writing every last byte in one synchronous loop puts
 * the bytes in flight at the same moment, so the handlers resume together.
 */
async function stageRequest(
  port: number,
  path: string,
  payload: string,
  forwardedFor?: string,
  makerToken?: string,
): Promise<StagedRequest> {
  const socket = connect(port, "127.0.0.1");
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  const body = Buffer.from(payload, "utf8");
  socket.write(
    `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
      "Content-Type: application/json\r\n" +
      (forwardedFor === undefined
        ? ""
        : `X-Forwarded-For: ${forwardedFor}\r\n`) +
      (makerToken === undefined
        ? ""
        : `X-Maker-Token: ${makerToken}\r\n`) +
      `Content-Length: ${String(body.byteLength)}\r\n\r\n`,
  );
  socket.write(body.subarray(0, body.byteLength - 1));
  const reply = readSocket(socket).then((text) => ({
    status: Number(/^HTTP\/1\.1 ([0-9]{3})/.exec(text)?.[1] ?? "0"),
    stage: /x-refusal-stage: ([a-z-]+)/i.exec(text)?.[1] ?? null,
    text,
  }));
  return {
    socket,
    finish: () => {
      socket.write(body.subarray(body.byteLength - 1));
    },
    reply,
  };
}

/** Completes every staged body in one turn, then collects the replies. */
async function releaseTogether(
  staged: readonly StagedRequest[],
): Promise<Array<{ status: number; stage: string | null; text: string }>> {
  for (const entry of staged) entry.finish();
  const replies = await Promise.all(staged.map((entry) => entry.reply));
  for (const entry of staged) entry.socket.destroy();
  return replies;
}

function readSocket(socket: Socket): Promise<string> {
  return new Promise<string>((resolve) => {
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.includes("\r\n\r\n")) resolve(text);
    });
    socket.once("close", () => resolve(text));
    socket.once("error", () => resolve(text));
  });
}

describe("in-flight mutation gate", () => {
  it(
    "refuses a mutation burst at the door and keeps reads answering",
    { timeout: 120_000 },
    async () => {
      const book = await startBook({
        ORDERBOOK_MAX_INFLIGHT_MUTATIONS: "2",
        ORDERBOOK_RESERVED_MAKER_MUTATIONS: "1",
      });
      const staged = await Promise.all(
        Array.from({ length: 12 }, (_value, index) =>
          stageRequest(
            book.port,
            "/api/orders",
            makerOrder(index + 1),
            `198.51.100.${String(index + 1)}`,
          ),
        ),
      );
      const burst = await releaseTogether(staged);
      const created = burst.filter((reply) => reply.status === 201);
      const refused = burst.filter((reply) => reply.status === 503);
      assert.ok(created.length >= 1, "a bound of one taker slot admits work");
      assert.ok(refused.length >= 1, "a burst of twelve must be shed");
      assert.equal(created.length + refused.length, burst.length);
      for (const reply of refused) {
        assert.match(reply.text, /retry-after: 1/i);
        assert.equal(reply.stage, "pre-verification");
        assert.match(
          reply.text,
          /order book has too many requests in flight, retry shortly/,
        );
      }

      // Reads and the probes are not gated, so the book stays answerable
      // while it refuses mutations.
      const health = await fetch(
        `http://127.0.0.1:${String(book.port)}/api/health`,
      );
      assert.equal(health.status, 200);
      await health.text();
      const listing = (await fetch(
        `http://127.0.0.1:${String(book.port)}/api/orders`,
      ).then((res) => res.json())) as { orders: unknown[] };
      // A refused request leaves nothing behind: the store holds exactly the
      // rows the book answered 201 for.
      assert.equal(listing.orders.length, created.length);
      const persisted = JSON.parse(
        readFileSync(book.dataFile, "utf8"),
      ) as unknown[];
      assert.equal(persisted.length, created.length);

      // The slot is released when a request finishes, so a later mutation is
      // admitted again.
      const after = await postOrder(book.port, 200);
      assert.equal(after.status, 201);
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
      const replies = await Promise.all(held.map((socket) => readSocket(socket)));
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
      const socket = await halfOpenPost(book.port, 4000);
      socket.write("{");
      const startedAt = Date.now();
      const reply = await readSocket(socket);
      const elapsed = Date.now() - startedAt;
      assert.match(reply, /^HTTP\/1\.1 408 /);
      assert.match(reply, /x-refusal-stage: pre-verification/i);
      assert.ok(
        elapsed < 5000,
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
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ direction: "nonsense" }),
          },
        );
        // The body is refused inside the slot, whichever check catches it.
        assert.ok(res.status >= 400 && res.status < 500, String(res.status));
        await res.json();
      }
      // Bodies that stop halfway and abort.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const socket = await halfOpenPost(book.port, 4000);
        socket.write("{");
        await delay(20);
        socket.destroy();
      }
      await delay(200);
      const after = await postOrder(book.port, 1);
      assert.equal(after.status, 201);
    },
  );

  it(
    "keeps headroom for maker routes while takers fill the bound",
    { timeout: 120_000 },
    async () => {
      const book = await startBook({
        ORDERBOOK_MAX_INFLIGHT_MUTATIONS: "2",
        ORDERBOOK_RESERVED_MAKER_MUTATIONS: "1",
      });
      const created = await postOrder(book.port, 1);
      assert.equal(created.status, 201);
      const order = created.body["order"] as Record<string, unknown>;
      const id = order["id"];
      const makerToken = created.body["makerToken"];
      assert.equal(typeof id, "string");
      assert.equal(typeof makerToken, "string");

      // One taker slot only, so a taker burst cannot take the last slot. The
      // maker's cancel goes through while that burst is being refused.
      const staged = await Promise.all([
        stageRequest(
          book.port,
          `/api/orders/${String(id)}/cancel`,
          JSON.stringify({}),
          "192.0.2.7",
          String(makerToken),
        ),
        ...Array.from({ length: 10 }, (_value, index) =>
          stageRequest(
            book.port,
            "/api/orders",
            makerOrder(index + 10),
            `198.51.100.${String(index + 1)}`,
          ),
        ),
      ]);
      const [cancelled, ...rest] = await releaseTogether(staged);
      if (cancelled === undefined) throw new Error("the cancel had no reply");
      assert.equal(cancelled.status, 200);
      assert.match(cancelled.text, /"status":"cancelled"/);
      assert.equal(rest.length, 10);
      // The reserved headroom is for maker paths only, so the taker burst
      // cannot reach it and part of it is shed.
      const shed = rest.filter((reply) => reply.status === 503);
      assert.ok(
        shed.length >= 1,
        `a taker burst above the taker ceiling must be shed: ${rest
          .map((reply) => String(reply.status))
          .join(",")}`,
      );
      for (const reply of shed) {
        assert.equal(reply.stage, "pre-verification");
      }
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
      for (const source of ["198.51.100.31", "198.51.100.32", "198.51.100.33", "198.51.100.34"]) {
        held.push(await halfOpenPost(book.port, 400, source));
        held.push(await halfOpenPost(book.port, 400, source));
      }
      await delay(200);
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
      for (const source of ["198.51.100.51", "198.51.100.52", "198.51.100.53", "198.51.100.54"]) {
        held.push(await halfOpenPost(book.port, 400, source));
        held.push(await halfOpenPost(book.port, 400, source));
      }
      await delay(200);

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
