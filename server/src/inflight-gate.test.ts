// The in-flight gate is an HTTP admission bound, so it is only proven by
// running the real service and racing real requests at it.

import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const serverEntry = fileURLToPath(new URL("./server.js", import.meta.url));

const tempDirectories: string[] = [];
const children: ChildProcess[] = [];

after(() => {
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

function startBook(
  directory: string,
  port: number,
  limit: string,
): ChildProcess {
  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      PORT: String(port),
      ORDERBOOK_HOST: "127.0.0.1",
      ORDERBOOK_DATA: join(directory, "orders.json"),
      ORDERBOOK_FEDERATION_DATA: join(directory, "orders.json.federation"),
      ORDERBOOK_FEDERATION_PEERS: "",
      ORDERBOOK_FEDERATION_PEER_IDS: "",
      ORDERBOOK_FEDERATION_PEER_TOKENS: "",
      ORDERBOOK_FEDERATION_ONION_ONLY: "false",
      ORDERBOOK_FEDERATION_ONION_PROXY: "",
      ORDERBOOK_FEDERATION_READ_TOKEN: "",
      ORDERBOOK_TRUST_PROXY: "none",
      ORDERBOOK_CORS_ORIGINS: "",
      ORDERBOOK_MAX_INFLIGHT_MUTATIONS: limit,
      PRESENCE_TTL_S: "90",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(child);
  return child;
}

async function waitForHealth(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      await res.text();
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error("the order book never became healthy");
    }
    await delay(100);
  }
}

const makerOrder = (index: number): string =>
  JSON.stringify({
    direction: "eth->qrl",
    fromAmount: (10n ** 18n).toString(),
    toAmount: (10n ** 18n).toString(),
    makerEthAccount: `0x${index.toString(16).padStart(40, "0")}`,
    makerQrlAccount: `Q${index.toString(16).padStart(128, "0")}`,
  });

describe("in-flight mutation gate", () => {
  it(
    "refuses a mutation burst at the door and keeps reads answering",
    { timeout: 120_000 },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "quantaswap-inflight-"));
      tempDirectories.push(directory);
      const port = await freePort();
      const book = startBook(directory, port, "1");
      await waitForHealth(port);

      const burst = await Promise.all(
        Array.from({ length: 12 }, (_value, index) =>
          fetch(`http://127.0.0.1:${port}/api/orders`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: makerOrder(index + 1),
          }).then(async (res) => ({
            status: res.status,
            retryAfter: res.headers.get("retry-after"),
            body: (await res.json()) as Record<string, unknown>,
          })),
        ),
      );
      const created = burst.filter((reply) => reply.status === 201);
      const refused = burst.filter((reply) => reply.status === 503);
      assert.ok(created.length >= 1, "a gate of one still admits work");
      assert.ok(refused.length >= 1, "a burst of twelve must be shed");
      assert.equal(created.length + refused.length, burst.length);
      for (const reply of refused) {
        assert.equal(reply.retryAfter, "1");
        assert.deepEqual(reply.body, {
          error: "order book has too many requests in flight, retry shortly",
        });
      }

      // Reads and the probes are not gated, so the book stays answerable
      // while it refuses mutations.
      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(health.status, 200);
      await health.text();
      const listing = (await fetch(`http://127.0.0.1:${port}/api/orders`).then(
        (res) => res.json(),
      )) as { orders: unknown[] };
      assert.equal(listing.orders.length, created.length);

      // The slot is released when a request finishes, so the gate is not a
      // leak: a later mutation is admitted again.
      const after = await fetch(`http://127.0.0.1:${port}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makerOrder(200),
      });
      assert.equal(after.status, 201);
      await after.json();

      book.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        book.once("exit", () => resolve());
      });
    },
  );
});
