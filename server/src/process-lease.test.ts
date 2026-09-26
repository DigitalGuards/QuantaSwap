import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, it } from "node:test";
import {
  BookLease,
  LEASE_CLOCK_SKEW_MS,
  LEASE_TTL_MS,
  ProcessLease,
  ProcessLeaseLostError,
  ProcessLeaseUnverifiableError,
  UNKNOWN_PID_NAMESPACE,
} from "./process-lease.js";
import { OrderStore } from "./store.js";
import { FederationFeed, type FederationEvent } from "./federation.js";

const LOCAL_NS = "pid:[4026531836]";
const FOREIGN_NS = "pid:[4026539999]";
const DIGEST = "a".repeat(64);

const tempDirectories: string[] = [];
const openLeases: Array<{ close: () => void }> = [];

const makeTemp = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "quantaswap-lease-test-"));
  tempDirectories.push(directory);
  return directory;
};

const track = <T extends { close: () => void }>(lease: T): T => {
  openLeases.push(lease);
  return lease;
};

afterEach(() => {
  for (const lease of openLeases.splice(0)) {
    try {
      lease.close();
    } catch {
      // A test may have removed the lease file on purpose.
    }
  }
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface LeaseRecordShape {
  version: number;
  pid: number;
  processStart: string;
  bootId: string;
  pidNamespace: string;
  identityDigest: string;
  leaseId: string;
}

const readLock = (file: string): LeaseRecordShape =>
  JSON.parse(readFileSync(`${file}.lock`, "utf8")) as LeaseRecordShape;

const writeLock = (
  file: string,
  overrides: Partial<LeaseRecordShape>,
): void => {
  const record: LeaseRecordShape = {
    version: 1,
    pid: process.pid,
    processStart: "0",
    bootId: "other-boot",
    pidNamespace: FOREIGN_NS,
    identityDigest: "other-identity",
    leaseId: "other-lease",
    ...overrides,
  };
  writeFileSync(`${file}.lock`, JSON.stringify(record), { mode: 0o600 });
};

/** Backdates the lease heartbeat by the given number of milliseconds. */
const ageLock = (file: string, byMs: number): void => {
  const stamp = new Date(Date.now() - byMs);
  utimesSync(`${file}.lock`, stamp, stamp);
};

async function waitFor(ready: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error("the awaited lease condition never held");
    }
    await delay(2);
  }
}

describe("order book single-writer lease", () => {
  it("refuses a second holder and lets a clean restart take over at once", () => {
    const file = join(makeTemp(), "orders.json");
    const first = ProcessLease.acquire(file, DIGEST);
    assert.throws(
      () => ProcessLease.acquire(file, DIGEST),
      /held by live process.*refusing a second order book process/,
    );
    // A clean shutdown removes the lease, so the restart needs no timeout.
    first.close();
    assert.equal(existsSync(`${file}.lock`), false);
    track(ProcessLease.acquire(file, DIGEST));
  });

  it("records this process's PID namespace and a 0600 lease file", () => {
    const file = join(makeTemp(), "orders.json");
    track(ProcessLease.acquire(file, DIGEST, { pidNamespace: LOCAL_NS }));
    const record = readLock(file);
    assert.equal(record.version, 1);
    assert.equal(record.pidNamespace, LOCAL_NS);
    assert.equal(record.identityDigest, DIGEST);
    assert.equal(statSync(`${file}.lock`).mode & 0o777, 0o600);
  });

  it("takes over a crashed holder in this namespace whose PID is gone", () => {
    const file = join(makeTemp(), "orders.json");
    // Same namespace and boot as the record this process would write, with a
    // process start time that cannot match any live PID.
    const own = ProcessLease.acquire(file, DIGEST, { pidNamespace: LOCAL_NS });
    const live = readLock(file);
    own.close();
    writeLock(file, {
      ...live,
      processStart: "999999999999",
      leaseId: "crashed",
    });
    const lease = track(
      ProcessLease.acquire(file, DIGEST, { pidNamespace: LOCAL_NS }),
    );
    assert.notEqual(readLock(file).leaseId, "crashed");
    lease.assertOwned();
  });

  it("recovers an unparseable lease left by a crash between create and write", () => {
    const file = join(makeTemp(), "orders.json");
    writeFileSync(`${file}.lock`, "incomplete crash record", { mode: 0o600 });
    const lease = track(ProcessLease.acquire(file, DIGEST));
    assert.throws(
      () => ProcessLease.acquire(file, DIGEST),
      /held by live process/,
    );
    lease.assertOwned();
  });

  it("refuses a live holder in another PID namespace and leaves its record", () => {
    const file = join(makeTemp(), "orders.json");
    writeLock(file, { pidNamespace: FOREIGN_NS, leaseId: "peer-container" });
    const held = readFileSync(`${file}.lock`, "utf8");
    assert.throws(
      () => ProcessLease.acquire(file, DIGEST, { pidNamespace: LOCAL_NS }),
      /another PID namespace.*refusing a second order book process/,
    );
    assert.equal(readFileSync(`${file}.lock`, "utf8"), held);
  });

  it("takes over a foreign-namespace lease once its heartbeat expires", () => {
    const file = join(makeTemp(), "orders.json");
    writeLock(file, { pidNamespace: FOREIGN_NS, leaseId: "crashed-container" });
    ageLock(file, LEASE_TTL_MS + 5_000);
    const lease = track(
      ProcessLease.acquire(file, DIGEST, { pidNamespace: LOCAL_NS }),
    );
    assert.notEqual(readLock(file).leaseId, "crashed-container");
    lease.assertOwned();
  });

  it("honours an injected heartbeat lifetime", () => {
    const file = join(makeTemp(), "orders.json");
    writeLock(file, { pidNamespace: FOREIGN_NS });
    ageLock(file, 400);
    assert.throws(
      () =>
        ProcessLease.acquire(file, DIGEST, {
          pidNamespace: LOCAL_NS,
          ttlMs: 10_000,
        }),
      /another PID namespace/,
    );
    track(
      ProcessLease.acquire(file, DIGEST, {
        pidNamespace: LOCAL_NS,
        ttlMs: 200,
      }),
    );
  });

  it("treats a heartbeat dated past the skew tolerance as stale", () => {
    const file = join(makeTemp(), "orders.json");
    writeLock(file, { pidNamespace: FOREIGN_NS });
    // Inside the tolerance the holder is still live.
    ageLock(file, -(LEASE_CLOCK_SKEW_MS - 5_000));
    assert.throws(
      () => ProcessLease.acquire(file, DIGEST, { pidNamespace: LOCAL_NS }),
      /another PID namespace/,
    );
    ageLock(file, -(LEASE_CLOCK_SKEW_MS + 5_000));
    track(ProcessLease.acquire(file, DIGEST, { pidNamespace: LOCAL_NS }));
  });

  it("judges every record by its heartbeat when this namespace is unknown", () => {
    const file = join(makeTemp(), "orders.json");
    const holder = ProcessLease.acquire(file, DIGEST, {
      pidNamespace: LOCAL_NS,
    });
    // A live PID in the recorded namespace, which a process that cannot read
    // its own namespace must not trust.
    assert.throws(
      () =>
        ProcessLease.acquire(file, DIGEST, {
          pidNamespace: UNKNOWN_PID_NAMESPACE,
        }),
      /another PID namespace/,
    );
    ageLock(file, LEASE_TTL_MS + 5_000);
    track(
      ProcessLease.acquire(file, DIGEST, {
        pidNamespace: UNKNOWN_PID_NAMESPACE,
      }),
    );
    holder.close();
  });

  it("takes over a recovery guard whose creator is gone", () => {
    const file = join(makeTemp(), "orders.json");
    // A guard record from this namespace and boot, so it is judged by its PID,
    // with a process start time no live PID can match. A kill between the
    // guard's creation and its release leaves exactly this, and blocking on it
    // forever would be a restart loop with no way out.
    const probe = ProcessLease.acquire(file, DIGEST, {
      pidNamespace: LOCAL_NS,
    });
    const own = readLock(file);
    probe.close();
    writeFileSync(
      `${file}.lock.recovery`,
      JSON.stringify({
        ...own,
        processStart: "999999999999",
        leaseId: "stale-guard",
      }),
      { mode: 0o600 },
    );
    const lease = track(
      ProcessLease.acquire(file, DIGEST, { pidNamespace: LOCAL_NS }),
    );
    lease.assertOwned();
    // The guard was released again, so it cannot block the next start either.
    assert.equal(existsSync(`${file}.lock.recovery`), false);
  });

  it("takes over a foreign-namespace guard past the heartbeat lifetime", () => {
    const file = join(makeTemp(), "orders.json");
    writeFileSync(
      `${file}.lock.recovery`,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        processStart: "0",
        bootId: "other-boot",
        pidNamespace: FOREIGN_NS,
        identityDigest: DIGEST,
        leaseId: "dead-container",
      }),
      { mode: 0o600 },
    );
    const old = new Date(Date.now() - (LEASE_TTL_MS + 5_000));
    utimesSync(`${file}.lock.recovery`, old, old);
    const lease = track(
      ProcessLease.acquire(file, DIGEST, { pidNamespace: LOCAL_NS }),
    );
    lease.assertOwned();
    assert.equal(existsSync(`${file}.lock.recovery`), false);
  });

  it("waits on a half-written guard whose owner may still run", () => {
    const file = join(makeTemp(), "orders.json");
    writeFileSync(`${file}.lock.recovery`, "half a guard record", {
      mode: 0o600,
    });
    assert.throws(
      () => ProcessLease.acquire(file, DIGEST, { pidNamespace: LOCAL_NS }),
      /remained contended.*remove the recovery guard .*\.lock\.recovery/s,
    );
    // Neither file was touched, so a live starter's guard is safe.
    assert.equal(
      readFileSync(`${file}.lock.recovery`, "utf8"),
      "half a guard record",
    );
    assert.equal(existsSync(`${file}.lock`), false);
  });

  it("refuses to return a lease another starter replaced before confirmation", () => {
    const file = join(makeTemp(), "orders.json");
    let interfered = false;
    assert.throws(
      () =>
        ProcessLease.acquire(file, DIGEST, {
          pidNamespace: LOCAL_NS,
          afterLeaseWritten: () => {
            if (interfered) return;
            interfered = true;
            // Another starter that took the same guard over wins the write.
            writeLock(file, { pidNamespace: FOREIGN_NS, leaseId: "winner" });
          },
        }),
      /another PID namespace/,
    );
    assert.equal(readLock(file).leaseId, "winner");
    assert.equal(existsSync(`${file}.lock.recovery`), false);
  });

  it("sweeps staging files past the heartbeat lifetime and keeps fresh ones", () => {
    const directory = makeTemp();
    const file = join(directory, "orders.json");
    const stale = `${file}.lock.next.1.stale`;
    const fresh = `${file}.lock.next.2.fresh`;
    writeFileSync(stale, "{}", { mode: 0o600 });
    writeFileSync(fresh, "{}", { mode: 0o600 });
    const old = new Date(Date.now() - (LEASE_TTL_MS + 5_000));
    utimesSync(stale, old, old);
    track(ProcessLease.acquire(file, DIGEST, { pidNamespace: LOCAL_NS }));
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(fresh), true);
  });

  it("refreshes the heartbeat while owned and reports a replacement once", async () => {
    const file = join(makeTemp(), "orders.json");
    const lease = track(
      ProcessLease.acquire(file, DIGEST, { pidNamespace: LOCAL_NS }),
    );
    const losses: string[] = [];
    ageLock(file, 5_000);
    const stamped = statSync(`${file}.lock`).mtimeMs;
    lease.startHeartbeat((reason) => losses.push(reason), 5);
    await waitFor(() => statSync(`${file}.lock`).mtimeMs > stamped);
    assert.deepEqual(losses, []);

    writeLock(file, { pidNamespace: FOREIGN_NS, leaseId: "successor" });
    await waitFor(() => losses.length === 1);
    assert.match(String(losses[0]), /another holder's lease id/);
    await delay(30);
    assert.equal(losses.length, 1);
  });

  it("reports a loss when the lease file is removed", async () => {
    const file = join(makeTemp(), "orders.json");
    const lease = track(
      ProcessLease.acquire(file, DIGEST, { pidNamespace: LOCAL_NS }),
    );
    const losses: string[] = [];
    lease.startHeartbeat((reason) => losses.push(reason), 5);
    rmSync(`${file}.lock`);
    await waitFor(() => losses.length === 1);
    assert.match(String(losses[0]), /was removed/);
  });

  it("declares a loss when beats keep failing, before a peer could take over", async () => {
    const file = join(makeTemp(), "orders.json");
    const lease = track(
      ProcessLease.acquire(file, DIGEST, {
        pidNamespace: LOCAL_NS,
        ttlMs: 200,
      }),
    );
    let lost = 0;
    lease.startHeartbeat(() => {
      lost += 1;
    }, 10);
    // A lease path this process can no longer read. Reading a directory as a
    // file fails for every user.
    rmSync(`${file}.lock`);
    mkdirSync(`${file}.lock`);
    const start = Date.now();
    await waitFor(() => lost === 1);
    assert.ok(Date.now() - start < 200, "loss must precede a peer takeover");
  });

  it("rejects a heartbeat interval with no detection margin", () => {
    const file = join(makeTemp(), "orders.json");
    const lease = track(
      ProcessLease.acquire(file, DIGEST, {
        pidNamespace: LOCAL_NS,
        ttlMs: 100,
      }),
    );
    assert.throws(
      () => lease.startHeartbeat(() => undefined, 40),
      /no detection margin/,
    );
    lease.startHeartbeat(() => undefined, 30);
  });

  it("re-reads the lease file on every ownership check and latches a loss", () => {
    const file = join(makeTemp(), "orders.json");
    const lease = track(
      ProcessLease.acquire(file, DIGEST, { pidNamespace: LOCAL_NS }),
    );
    const held = readFileSync(`${file}.lock`, "utf8");
    lease.assertOwned();
    // No heartbeat runs here, so only a fresh read can catch this.
    writeLock(file, { pidNamespace: FOREIGN_NS, leaseId: "successor" });
    assert.throws(() => lease.assertOwned(), ProcessLeaseLostError);
    writeFileSync(`${file}.lock`, held, { mode: 0o600 });
    assert.throws(() => lease.assertOwned(), ProcessLeaseLostError);
    // A lost lease is never removed: the path belongs to its new holder.
    lease.close();
    assert.equal(existsSync(`${file}.lock`), true);
  });

  it("separates an unverifiable check from a proven loss", async () => {
    const file = join(makeTemp(), "orders.json");
    const lease = track(
      ProcessLease.acquire(file, DIGEST, { pidNamespace: LOCAL_NS }),
    );
    const held = readFileSync(`${file}.lock`, "utf8");
    let lost = 0;
    // A long interval, so only the checks below observe the failure.
    lease.startHeartbeat(() => {
      lost += 1;
    }, 30_000);

    rmSync(`${file}.lock`);
    mkdirSync(`${file}.lock`);
    assert.throws(() => lease.assertOwned(), ProcessLeaseUnverifiableError);

    rmSync(`${file}.lock`, { recursive: true });
    writeFileSync(`${file}.lock`, "half a record", { mode: 0o600 });
    assert.throws(() => lease.assertOwned(), ProcessLeaseUnverifiableError);

    writeFileSync(`${file}.lock`, held, { mode: 0o600 });
    lease.assertOwned();
    await delay(20);
    // A transient failure never latches a loss, so the book keeps running.
    assert.equal(lost, 0);
  });

  it("treats a removed lease file as a proven loss on an ownership check", () => {
    const file = join(makeTemp(), "orders.json");
    const lease = track(
      ProcessLease.acquire(file, DIGEST, { pidNamespace: LOCAL_NS }),
    );
    rmSync(`${file}.lock`);
    assert.throws(() => lease.assertOwned(), ProcessLeaseLostError);
  });

  it("refuses writes after release, so a shutdown cannot be raced", () => {
    const file = join(makeTemp(), "orders.json");
    const lease = ProcessLease.acquire(file, DIGEST, {
      pidNamespace: LOCAL_NS,
    });
    lease.close();
    assert.throws(() => lease.assertOwned(), ProcessLeaseLostError);
  });
});

describe("book lease over the protected file set", () => {
  const files = (directory: string): [string, string] => [
    join(directory, "orders.json"),
    join(directory, "orders.json.federation"),
  ];

  it("takes a lease beside every protected file and releases both", () => {
    const directory = makeTemp();
    const [orders, feed] = files(directory);
    const lease = BookLease.acquire([orders, feed]);
    assert.deepEqual(lease.paths.sort(), [`${feed}.lock`, `${orders}.lock`]);
    assert.equal(existsSync(`${orders}.lock`), true);
    assert.equal(existsSync(`${feed}.lock`), true);
    lease.close();
    assert.equal(existsSync(`${orders}.lock`), false);
    assert.equal(existsSync(`${feed}.lock`), false);
  });

  it("refuses a second book and leaves it holding nothing", () => {
    const directory = makeTemp();
    const [orders, feed] = files(directory);
    track(BookLease.acquire([orders, feed]));
    const firstOrders = readFileSync(`${orders}.lock`, "utf8");
    const firstFeed = readFileSync(`${feed}.lock`, "utf8");
    assert.throws(
      () => BookLease.acquire([orders, feed]),
      /refusing a second order book process/,
    );
    // The refused starter released the lease it did take, and never replaced
    // either of the holder's records.
    assert.equal(readFileSync(`${orders}.lock`, "utf8"), firstOrders);
    assert.equal(readFileSync(`${feed}.lock`, "utf8"), firstFeed);
  });

  it("refuses a book that shares only one of the two files", () => {
    const directory = makeTemp();
    const [orders, feed] = files(directory);
    track(BookLease.acquire([orders, feed]));
    assert.throws(
      () => BookLease.acquire([join(directory, "other.json"), feed]),
      /refusing a second order book process/,
    );
  });

  it("fails ownership when any one protected file is taken over", () => {
    const directory = makeTemp();
    const [orders, feed] = files(directory);
    const lease = track(BookLease.acquire([orders, feed]));
    lease.assertOwned();
    writeLock(feed, { pidNamespace: FOREIGN_NS, leaseId: "successor" });
    assert.throws(() => lease.assertOwned(), ProcessLeaseLostError);
  });

  it("reports a loss once for the whole file set", async () => {
    const directory = makeTemp();
    const [orders, feed] = files(directory);
    const lease = track(BookLease.acquire([orders, feed]));
    const losses: string[] = [];
    lease.startHeartbeat((reason) => losses.push(reason), 5);
    rmSync(`${orders}.lock`);
    rmSync(`${feed}.lock`);
    await waitFor(() => losses.length === 1);
    await delay(40);
    assert.equal(losses.length, 1);
    assert.match(String(losses[0]), /\.lock: the lease file was removed/);
  });

  it("deduplicates a repeated protected path", () => {
    const directory = makeTemp();
    const [orders] = files(directory);
    const lease = track(BookLease.acquire([orders, orders]));
    assert.deepEqual(lease.paths, [`${orders}.lock`]);
  });
});

describe("protected writes under the lease", () => {
  const orderBody = (index = 1): Record<string, unknown> => ({
    direction: "eth->qrl",
    fromAmount: (10n ** 18n).toString(),
    toAmount: (10n ** 18n).toString(),
    makerEthAccount: `0x${index.toString(16).padStart(40, "0")}`,
    makerQrlAccount: `Q${index.toString(16).padStart(128, "0")}`,
  });

  const feedEvent = (nonce: string): FederationEvent => ({
    kind: "order-v2",
    payload: { auth: { nonce }, order: { asset: "ETH", amount: "1" } },
  });

  it("refuses an orders rewrite after a proven loss and leaves the file", () => {
    const dataFile = join(makeTemp(), "orders.json");
    const lease = track(
      ProcessLease.acquire(dataFile, DIGEST, { pidNamespace: LOCAL_NS }),
    );
    const store = new OrderStore(dataFile, {
      assertOwned: () => lease.assertOwned(),
    });
    store.create(orderBody(), "203.0.113.1");
    const persisted = readFileSync(dataFile, "utf8");

    writeLock(dataFile, { pidNamespace: FOREIGN_NS, leaseId: "successor" });
    assert.throws(
      () => store.create(orderBody(2), "203.0.113.2"),
      ProcessLeaseLostError,
    );
    assert.equal(readFileSync(dataFile, "utf8"), persisted);
  });

  it("defers an orders rewrite it cannot verify, then persists it", () => {
    const dataFile = join(makeTemp(), "orders.json");
    const lease = track(
      ProcessLease.acquire(dataFile, DIGEST, { pidNamespace: LOCAL_NS }),
    );
    const held = readFileSync(`${dataFile}.lock`, "utf8");
    const store = new OrderStore(dataFile, {
      assertOwned: () => lease.assertOwned(),
    });
    store.create(orderBody(), "203.0.113.1");
    const persisted = readFileSync(dataFile, "utf8");

    rmSync(`${dataFile}.lock`);
    mkdirSync(`${dataFile}.lock`);
    assert.throws(
      () => store.create(orderBody(2), "203.0.113.2"),
      ProcessLeaseUnverifiableError,
    );
    assert.equal(readFileSync(dataFile, "utf8"), persisted);

    rmSync(`${dataFile}.lock`, { recursive: true });
    writeFileSync(`${dataFile}.lock`, held, { mode: 0o600 });
    store.create(orderBody(3), "203.0.113.3");
    assert.notEqual(readFileSync(dataFile, "utf8"), persisted);
  });

  it("refuses a feed append after a proven loss and keeps the log intact", () => {
    const feedFile = join(makeTemp(), "orders.json.federation");
    const lease = track(
      ProcessLease.acquire(feedFile, DIGEST, { pidNamespace: LOCAL_NS }),
    );
    const feed = new FederationFeed(feedFile, 8, undefined, () =>
      lease.assertOwned(),
    );
    feed.append(feedEvent("one"), 1_000);
    const log = readFileSync(feedFile, "utf8");
    const before = feed.status();

    writeLock(feedFile, { pidNamespace: FOREIGN_NS, leaseId: "successor" });
    assert.throws(
      () => feed.append(feedEvent("two"), 1_001),
      ProcessLeaseLostError,
    );
    assert.equal(readFileSync(feedFile, "utf8"), log);
    // The refused append rolled its retained ring back, so the feed still
    // reports exactly what the log holds.
    assert.deepEqual(feed.status(), before);
  });

  it("refuses a compaction it cannot verify and keeps the log intact", () => {
    const feedFile = join(makeTemp(), "orders.json.federation");
    const lease = track(
      ProcessLease.acquire(feedFile, DIGEST, { pidNamespace: LOCAL_NS }),
    );
    const feed = new FederationFeed(feedFile, 8, undefined, () =>
      lease.assertOwned(),
    );
    feed.append(feedEvent("one"), 1_000);
    const log = readFileSync(feedFile, "utf8");

    rmSync(`${feedFile}.lock`);
    mkdirSync(`${feedFile}.lock`);
    assert.throws(
      () => feed.reconcileSnapshot([feedEvent("one")]),
      ProcessLeaseUnverifiableError,
    );
    assert.equal(readFileSync(feedFile, "utf8"), log);
  });
});
