// Two real order book processes on one data directory. The lease is a
// filesystem protocol between processes, so the exclusion it promises is only
// proven by starting a second process for real.

import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

interface StartedBook {
  child: ChildProcess;
  port: number;
  stderr: () => string;
  stdout: () => string;
  exited: Promise<number>;
}

function startBook(
  dataFile: string,
  federationDataFile: string,
  port: number,
): StartedBook {
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
      ORDERBOOK_TRUST_PROXY: "none",
      ORDERBOOK_CORS_ORIGINS: "",
      PRESENCE_TTL_S: "90",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let err = "";
  let out = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  const exited = new Promise<number>((resolve) => {
    child.once("exit", (code, signal) =>
      resolve(code ?? (signal === null ? -1 : 128)),
    );
  });
  return { child, port, stderr: () => err, stdout: () => out, exited };
}

async function waitForHealth(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        await res.text();
        return;
      }
      await res.text();
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error("the order book never became healthy");
    }
    await delay(100);
  }
}

interface FileFingerprint {
  content: string;
  mtimeMs: number;
}

const fingerprint = (file: string): FileFingerprint => ({
  content: readFileSync(file, "utf8"),
  mtimeMs: statSync(file).mtimeMs,
});

const makerOrder = (index: number): string =>
  JSON.stringify({
    direction: "eth->qrl",
    fromAmount: (10n ** 18n).toString(),
    toAmount: (10n ** 18n).toString(),
    makerEthAccount: `0x${index.toString(16).padStart(40, "0")}`,
    makerQrlAccount: `Q${index.toString(16).padStart(128, "0")}`,
  });

async function postOrder(port: number, index: number): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: makerOrder(index),
  });
}

describe("two order book processes on one data directory", () => {
  it(
    "refuses the second process and leaves every file untouched",
    { timeout: 120_000 },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "quantaswap-lease-live-"));
      tempDirectories.push(directory);
      const dataFile = join(directory, "orders.json");
      const federationDataFile = join(directory, "orders.json.federation");

      const first = startBook(dataFile, federationDataFile, await freePort());
      await waitForHealth(first.port);

      // One durable mutation, so both protected files hold real content.
      const created = await postOrder(first.port, 1);
      assert.equal(created.status, 201);
      await created.json();

      const before = {
        orders: fingerprint(dataFile),
        feed: fingerprint(federationDataFile),
        ordersLock: fingerprint(`${dataFile}.lock`),
        feedLock: fingerprint(`${federationDataFile}.lock`),
      };
      assert.match(first.stdout(), /single-writer lease held on/);

      const second = startBook(
        dataFile,
        federationDataFile,
        await freePort(),
      );
      const exitCode = await second.exited;
      assert.notEqual(exitCode, 0);
      assert.match(
        second.stderr(),
        /cannot take the single-writer lease.*refusing a second order book process/s,
      );

      // Nothing the holder owns was read-modified-written, and no quarantine
      // copy of the feed log was made.
      assert.deepEqual(fingerprint(dataFile), before.orders);
      assert.deepEqual(fingerprint(federationDataFile), before.feed);
      assert.deepEqual(fingerprint(`${dataFile}.lock`), before.ordersLock);
      assert.deepEqual(
        fingerprint(`${federationDataFile}.lock`),
        before.feedLock,
      );
      assert.deepEqual(
        readdirSync(directory).filter((name) => name.includes(".corrupt-")),
        [],
      );
      assert.deepEqual(
        readdirSync(directory).filter((name) => name.includes(".lock.next.")),
        [],
      );

      // The holder kept serving through the refused start.
      const health = await fetch(`http://127.0.0.1:${first.port}/api/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: "ok" });
      const status = await fetch(`http://127.0.0.1:${first.port}/api/status`);
      assert.equal(status.status, 200);
      const statusBody = (await status.json()) as {
        lease: { ready: boolean; lost: boolean; unverifiableSince: null };
      };
      assert.deepEqual(statusBody.lease, {
        ready: true,
        lost: false,
        unverifiableSince: null,
      });

      // A clean shutdown releases both leases, so the replacement starts at
      // once, with no heartbeat lifetime to wait out.
      first.child.kill("SIGTERM");
      assert.equal(await first.exited, 0);
      assert.deepEqual(
        readdirSync(directory).filter((name) => name.endsWith(".lock")),
        [],
      );

      const replacement = startBook(
        dataFile,
        federationDataFile,
        await freePort(),
      );
      await waitForHealth(replacement.port);
      const orders = (await fetch(
        `http://127.0.0.1:${replacement.port}/api/orders`,
      ).then((res) => res.json())) as { orders: unknown[] };
      assert.equal(orders.orders.length, 1);
      replacement.child.kill("SIGTERM");
      assert.equal(await replacement.exited, 0);
    },
  );

  it(
    "refuses the write and exits non-zero once its lease is taken over",
    { timeout: 120_000 },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "quantaswap-lease-lost-"));
      tempDirectories.push(directory);
      const dataFile = join(directory, "orders.json");
      const federationDataFile = join(directory, "orders.json.federation");

      const book = startBook(dataFile, federationDataFile, await freePort());
      await waitForHealth(book.port);
      const created = await postOrder(book.port, 1);
      assert.equal(created.status, 201);
      await created.json();
      const before = {
        orders: fingerprint(dataFile),
        feed: fingerprint(federationDataFile),
      };

      // Another holder's record at the same path. Only the lease id matters,
      // and this one is not the running book's.
      const held = JSON.parse(readFileSync(`${dataFile}.lock`, "utf8")) as {
        leaseId: string;
        pidNamespace: string;
      };
      writeFileSync(
        `${dataFile}.lock`,
        JSON.stringify({
          ...held,
          pidNamespace: "pid:[4026539999]",
          leaseId: "b".repeat(64),
        }),
        { mode: 0o600 },
      );

      const refused = await postOrder(book.port, 2);
      assert.equal(refused.status, 503);
      assert.deepEqual(await refused.json(), {
        error: "order book no longer owns its data and is stopping",
      });

      assert.equal(await book.exited, 1);
      assert.match(
        book.stderr(),
        /FATAL: this process no longer holds the single-writer lease/,
      );
      // The refused write never reached either file, and the displaced
      // process left the successor's lease record in place.
      assert.deepEqual(fingerprint(dataFile), before.orders);
      assert.deepEqual(fingerprint(federationDataFile), before.feed);
      const after = JSON.parse(readFileSync(`${dataFile}.lock`, "utf8")) as {
        leaseId: string;
      };
      assert.equal(after.leaseId, "b".repeat(64));
    },
  );
});
