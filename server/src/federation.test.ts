import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CryptoBytes, CryptoPublicKeyBytes } from "@theqrl/mldsa87";
import {
  FederationFeed,
  FederationResponseTooLargeError,
  MAX_FEDERATION_RESPONSE_BYTES,
  MAX_FEDERATION_INCREMENTAL_BYTES,
  canonicalFederationJson,
  federationEventId,
  serializeFederationPage,
  type FederationEvent,
  type FederationRecord,
} from "./federation.js";
import { MAX_PUBLIC_PORTABLE_ORDERS } from "./store.js";

const orderEvent = (id: string): FederationEvent => ({
  kind: "order-v2",
  payload: { auth: { nonce: id }, order: { asset: "ETH", amount: "1" } },
});

function withTempFile(run: (file: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "quantaswap-federation-"));
  try {
    run(join(directory, "events.json"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("federation event feed", () => {
  it("uses canonical content ids independent of object insertion order", () => {
    const left: FederationEvent = {
      kind: "cancel-v2",
      payload: {
        cancel: { reasonCode: 1, orderDigest: `0x${"11".repeat(32)}` },
        auth: {},
      },
    };
    const right: FederationEvent = {
      payload: {
        auth: {},
        cancel: { orderDigest: `0x${"11".repeat(32)}`, reasonCode: 1 },
      },
      kind: "cancel-v2",
    };
    assert.equal(canonicalFederationJson(left), canonicalFederationJson(right));
    assert.equal(federationEventId(left), federationEventId(right));
  });

  it("deduplicates exact replays and resumes from a mirror-local cursor", () => {
    withTempFile((file) => {
      const feed = new FederationFeed(file, 8);
      const first = feed.append(orderEvent("one"), 100);
      const replay = feed.append(orderEvent("one"), 101);
      const second = feed.append(orderEvent("two"), 102);
      assert.deepEqual(replay, first);
      assert.equal(second.seq, first.seq + 1);
      assert.deepEqual(feed.status(), {
        retainedEvents: 2,
        oldestSequence: first.seq,
        latestSequence: second.seq,
        lastEventAt: 102_000,
      });
      assert.equal(JSON.stringify(feed.status()).includes("feedId"), false);

      const reset = feed.page(null, 8, () => [orderEvent("snapshot")]);
      assert.equal(reset.reset, true);
      assert.equal(reset.snapshot?.length, 1);
      const page = feed.page(
        reset.cursor.replace(/:[0-9]+$/, `:${first.seq}`),
        8,
        () => [],
      );
      assert.equal(page.reset, false);
      assert.deepEqual(
        page.events.map((entry) => entry.eventId),
        [second.eventId],
      );
      assert.equal(page.cursor.endsWith(`:${second.seq}`), true);
    });
  });

  it("returns a reset snapshot when a cursor fell behind the bounded ring", () => {
    withTempFile((file) => {
      const feed = new FederationFeed(file, 2);
      const initial = feed.page(null, 2, () => []);
      feed.append(orderEvent("one"), 100);
      feed.append(orderEvent("two"), 101);
      feed.append(orderEvent("three"), 102);
      const stale = feed.page(initial.cursor, 2, () => [orderEvent("current")]);
      assert.equal(stale.reset, true);
      assert.equal(stale.snapshot?.[0]?.event.kind, "order-v2");
    });
  });

  it("paginates incremental events by serialized bytes", () => {
    withTempFile((file) => {
      const feed = new FederationFeed(file, 128);
      const cursor = feed.page(null, 8, () => []).cursor;
      for (let index = 0; index < 72; index += 1) {
        feed.append({
          kind: "order-v2",
          payload: { id: String(index), padding: "x".repeat(60 * 1024) },
        });
      }

      const page = feed.page(cursor, 256, () => []);
      assert.equal(page.reset, false);
      assert.equal(page.hasMore, true);
      assert.ok(page.events.length > 0);
      assert.ok(
        Buffer.byteLength(JSON.stringify(page), "utf8") <=
          MAX_FEDERATION_INCREMENTAL_BYTES,
      );
    });
  });

  it("caches reset snapshots while the returned cursor remains recoverable", () => {
    withTempFile((file) => {
      let now = 1_000;
      let snapshotCalls = 0;
      const feed = new FederationFeed(file, 4, () => now);
      const snapshot = (): FederationEvent[] => {
        snapshotCalls += 1;
        return [orderEvent(`snapshot-${snapshotCalls}`)];
      };

      const first = feed.page(null, 4, snapshot);
      const repeated = feed.page("malformed", 4, snapshot);
      assert.equal(snapshotCalls, 1);
      assert.deepEqual(repeated, first);

      const appended = feed.append(orderEvent("later"), 100);
      const stillCached = feed.page(null, 4, snapshot);
      assert.equal(snapshotCalls, 1);
      assert.equal(stillCached.cursor, first.cursor);
      const incremental = feed.page(stillCached.cursor, 4, snapshot);
      assert.equal(incremental.reset, false);
      assert.deepEqual(
        incremental.events.map((entry) => entry.eventId),
        [appended.eventId],
      );

      now += 5_000;
      const refreshed = feed.page(null, 4, snapshot);
      assert.equal(snapshotCalls, 2);
      assert.notEqual(refreshed.cursor, first.cursor);
    });
  });

  it("invalidates a cached reset snapshot after its cursor falls behind", () => {
    withTempFile((file) => {
      let snapshotCalls = 0;
      const feed = new FederationFeed(file, 2);
      const snapshot = (): FederationEvent[] => {
        snapshotCalls += 1;
        return [orderEvent(`snapshot-${snapshotCalls}`)];
      };

      const first = feed.page(null, 2, snapshot);
      feed.append(orderEvent("one"), 100);
      feed.append(orderEvent("two"), 101);
      feed.append(orderEvent("three"), 102);
      assert.equal(feed.requiresReset(first.cursor), true);

      const refreshed = feed.page(null, 2, snapshot);
      assert.equal(snapshotCalls, 2);
      assert.notEqual(refreshed.cursor, first.cursor);
      assert.equal(feed.requiresReset(refreshed.cursor), false);
    });
  });

  it("detects malformed, foreign, future, and stale cursors without a snapshot", () => {
    withTempFile((file) => {
      const feed = new FederationFeed(file, 2);
      let snapshotCalls = 0;
      const initial = feed.page(null, 2, () => {
        snapshotCalls += 1;
        return [];
      });
      const [feedId] = initial.cursor.split(":");
      assert.ok(feedId);
      const differentPrefix = feedId.startsWith("0") ? "1" : "0";
      const foreign = `${differentPrefix}${feedId.slice(1)}:0`;

      assert.equal(feed.requiresReset(null), true);
      assert.equal(feed.requiresReset("malformed"), true);
      assert.equal(feed.requiresReset(foreign), true);
      assert.equal(feed.requiresReset(`${feedId}:00`), true);
      assert.equal(feed.requiresReset(`${feedId}:0000000000000000`), true);
      assert.equal(feed.requiresReset(`${feedId}:9007199254740992`), true);
      assert.equal(feed.requiresReset(initial.cursor), false);
      assert.equal(snapshotCalls, 1);

      feed.append(orderEvent("one"), 100);
      feed.append(orderEvent("two"), 101);
      feed.append(orderEvent("three"), 102);
      assert.equal(feed.requiresReset(initial.cursor), true);
      assert.equal(snapshotCalls, 1);
    });
  });

  it("persists feed identity and rejects corrupted content ids", () => {
    withTempFile((file) => {
      const first = new FederationFeed(file, 8);
      first.append(orderEvent("one"), 100);
      const cursor = first.page(null, 8, () => []).cursor;
      const restored = new FederationFeed(file, 8);
      assert.equal(restored.page(cursor, 8, () => []).reset, false);

      const lines = readFileSync(file, "utf8").trimEnd().split("\n");
      const event = JSON.parse(lines[1] ?? "") as { eventId: string };
      event.eventId = "0".repeat(64);
      lines[1] = JSON.stringify(event);
      writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
      assert.throws(() => new FederationFeed(file, 8), /mismatched id/);
    });
  });

  it("appends one line per event and compacts past a quarter of slack", () => {
    withTempFile((file) => {
      const lineCount = (): number =>
        readFileSync(file, "utf8").trimEnd().split("\n").length;
      const feed = new FederationFeed(file, 4);
      feed.append(orderEvent("one"), 100);
      // The first write creates the header and the retained ring.
      assert.equal(lineCount(), 2);
      feed.append(orderEvent("two"), 101);
      feed.append(orderEvent("one"), 102);
      assert.equal(lineCount(), 3);
      for (const id of ["three", "four", "five"]) {
        feed.append(orderEvent(id), 103);
      }
      assert.equal(lineCount(), 6);
      // The sixth event line exceeds 4 + 1 and compacts to the ring of four.
      feed.append(orderEvent("six"), 104);
      assert.equal(lineCount(), 5);

      const restored = new FederationFeed(file, 4);
      assert.deepEqual(restored.status(), feed.status());
      assert.equal(restored.has(federationEventId(orderEvent("one"))), false);
      assert.equal(restored.has(federationEventId(orderEvent("six"))), true);
    });
  });

  it("keeps an append that succeeded when the following compaction fails", () => {
    withTempFile((file) => {
      const feed = new FederationFeed(file, 2);
      for (const id of ["one", "two", "three"]) feed.append(orderEvent(id), 100);
      // The fourth event line exceeds 2 + 1 and triggers compaction.
      const failing = feed as unknown as { compact: () => void };
      failing.compact = () => {
        throw new Error("simulated compaction failure");
      };
      const appended = feed.append(orderEvent("four"), 101);
      assert.equal(appended.seq, 4);
      assert.equal(feed.status().latestSequence, 4);
      Reflect.deleteProperty(failing, "compact");
      assert.equal(new FederationFeed(file, 2).status().latestSequence, 4);
      feed.append(orderEvent("five"), 102);
      assert.equal(new FederationFeed(file, 2).status().latestSequence, 5);
    });
  });

  it("drops a torn final line and rewrites a clean log", () => {
    withTempFile((file) => {
      const feed = new FederationFeed(file, 8);
      feed.append(orderEvent("one"), 100);
      feed.append(orderEvent("two"), 101);
      const cursor = feed.page(null, 8, () => []).cursor;
      writeFileSync(
        file,
        `${readFileSync(file, "utf8")}{"type":"event","seq":3,"eve`,
        "utf8",
      );

      const restored = new FederationFeed(file, 8);
      assert.equal(restored.status().latestSequence, 2);
      assert.equal(restored.page(cursor, 8, () => []).reset, false);
      assert.equal(readFileSync(file, "utf8").endsWith("\n"), true);
      restored.append(orderEvent("three"), 102);
      assert.equal(new FederationFeed(file, 8).status().latestSequence, 3);
    });
  });

  it("keeps the newest copy of an event appended again after trimming", () => {
    withTempFile((file) => {
      const feed = new FederationFeed(file, 2);
      feed.append(orderEvent("one"), 100);
      feed.append(orderEvent("two"), 101);
      feed.append(orderEvent("three"), 102);
      feed.append(orderEvent("one"), 103);
      const restored = new FederationFeed(file, 2);
      assert.deepEqual(restored.status(), feed.status());
      assert.equal(restored.has(federationEventId(orderEvent("one"))), true);
    });
  });

  it("migrates a version 2 envelope without rotating the feed identity", () => {
    withTempFile((file) => {
      const records = ["one", "two"].map((id, index) => {
        const event = orderEvent(id);
        return {
          seq: index + 1,
          eventId: federationEventId(event),
          event,
          receivedAt: 100 + index,
        };
      });
      const feedId = "ab".repeat(16);
      writeFileSync(
        file,
        JSON.stringify({
          version: 2,
          feedId,
          nextSeq: 3,
          events: records,
          snapshotDigest: null,
        }),
        "utf8",
      );
      const migrated = new FederationFeed(file, 8);
      assert.equal(migrated.requiresReset(`${feedId}:1`), false);
      assert.equal(migrated.status().latestSequence, 2);
      const header = JSON.parse(
        readFileSync(file, "utf8").split("\n")[0] ?? "",
      ) as { type: string; version: number };
      assert.equal(header.type, "header");
      assert.equal(header.version, 3);
      assert.equal(new FederationFeed(file, 8).requiresReset(`${feedId}:1`), false);
    });
  });

  it("rotates after an unchecked append and keeps identity after a checkpoint", () => {
    withTempFile((file) => {
      const base = [orderEvent("base")];
      const grown = [...base, orderEvent("grown")];
      const feed = new FederationFeed(file, 8);
      feed.reconcileSnapshot(base);
      const cursor = feed.page(null, 8, () => base).cursor;
      // A crash after this append leaves the digest unknown.
      feed.append(orderEvent("grown"), 100);
      const crashed = new FederationFeed(file, 8);
      assert.equal(crashed.reconcileSnapshot(grown), true);
      assert.equal(crashed.requiresReset(cursor), true);

      const afterReset = crashed.page(null, 8, () => grown).cursor;
      crashed.append(orderEvent("later"), 101);
      const final = [...grown, orderEvent("later")];
      crashed.checkpoint(final);
      const restarted = new FederationFeed(file, 8);
      assert.equal(restarted.reconcileSnapshot(final), false);
      assert.equal(restarted.requiresReset(afterReset), false);
    });
  });

  it("reconciles an oversized snapshot with one identity rotation", () => {
    withTempFile((file) => {
      const snapshot = Array.from({ length: 6 }, (_value, index) =>
        orderEvent(`snapshot-${index}`),
      );
      const first = new FederationFeed(file, 4);
      assert.equal(first.reconcileSnapshot(snapshot), true);
      const initial = first.page(null, 8, () => snapshot);
      const firstCursor = initial.cursor;
      const firstFile = readFileSync(file, "utf8");

      const restored = new FederationFeed(file, 4);
      assert.equal(restored.reconcileSnapshot(snapshot), false);
      assert.equal(restored.page(null, 8, () => snapshot).cursor, firstCursor);
      assert.equal(readFileSync(file, "utf8"), firstFile);

      const crashGapSnapshot = [orderEvent("prefix-crash-gap"), ...snapshot];
      assert.equal(restored.reconcileSnapshot(crashGapSnapshot), true);
      assert.equal(restored.requiresReset(firstCursor), true);
      const recovered = restored.page(firstCursor, 8, () => crashGapSnapshot);
      assert.equal(recovered.reset, true);
      assert.equal(
        recovered.snapshot?.some(
          (record) =>
            record.event.payload["auth"] !== undefined &&
            JSON.stringify(record.event).includes("prefix-crash-gap"),
        ),
        true,
      );
    });
  });

  it("rejects unsupported values and oversized pages", () => {
    withTempFile((file) => {
      const feed = new FederationFeed(file, 8);
      assert.throws(
        () =>
          feed.append({
            kind: "order-v2",
            payload: { unsafe: Number.NaN },
          }),
        /safe integer/,
      );
      assert.throws(() => feed.page(null, 257, () => []), /between 1 and 256/);
      assert.throws(
        () =>
          feed.append({
            kind: "order-v2",
            payload: {},
            padding: "ignored",
          } as FederationEvent),
        /unexpected fields/,
      );
    });
  });

  it("refuses to serialize federation pages beyond the configured byte ceiling", () => {
    const page = {
      reset: false,
      cursor: `${"0".repeat(32)}:0`,
      hasMore: false,
      events: [],
    };
    const serialized = serializeFederationPage(page);
    const actualBytes = Buffer.byteLength(serialized, "utf8");
    assert.equal(serializeFederationPage(page, actualBytes), serialized);
    assert.throws(
      () => serializeFederationPage(page, actualBytes - 1),
      (error: unknown) => {
        assert.ok(error instanceof FederationResponseTooLargeError);
        assert.equal(error.actualBytes, actualBytes);
        assert.equal(error.maxBytes, actualBytes - 1);
        return true;
      },
    );
    assert.throws(
      () => serializeFederationPage(page, MAX_FEDERATION_RESPONSE_BYTES + 1),
      /byte limit is invalid/,
    );
  });

  it("fits the admitted maximum portable state in one reset response", () => {
    const auth = {
      version: "2",
      scheme: "qrl-sign-message-v2",
      issuedAt: 1,
      expiresAt: 2,
      nonce: `0x${"11".repeat(32)}`,
      makerTokenCommitment: `0x${"22".repeat(32)}`,
      shareTokenCommitment: `0x${"00".repeat(32)}`,
      signature: `0x${"33".repeat(CryptoBytes)}`,
      publicKey: `0x${"44".repeat(CryptoPublicKeyBytes)}`,
      descriptor: "0x010000",
    };
    const snapshot: FederationRecord[] = [];
    const add = (event: FederationEvent) => {
      snapshot.push({
        seq: 0,
        eventId: federationEventId(event),
        event,
      });
    };
    for (let index = 0; index < MAX_PUBLIC_PORTABLE_ORDERS; index += 1) {
      const orderId = index.toString(16).padStart(64, "0");
      const orderDigest = `0x${index.toString(16).padStart(64, "0")}`;
      const order = {
        direction: "eth->qrl",
        asset: "ETH",
        fromAmount: "1".repeat(30),
        toAmount: "2".repeat(30),
        makerEthAccount: `0x${"55".repeat(20)}`,
        makerQrlAccount: `Q${"66".repeat(20)}`,
        visibility: "public",
      };
      for (let variant = 0; variant < 3; variant += 1) {
        add({ kind: "order-v2", payload: { order, auth } });
      }
      for (let intentIndex = 0; intentIndex < 8; intentIndex += 1) {
        const intentDigest = `0x${intentIndex.toString(16).padStart(64, "0")}`;
        const intent = {
          orderDigest,
          takerEthAccount: `0x${"77".repeat(20)}`,
          takerQrlAccount: `Q${"88".repeat(20)}`,
          releaseCommitment: `0x${"99".repeat(32)}`,
        };
        add({
          kind: "fill-intent-v2",
          payload: { orderId, intent, auth },
        });
        add({
          kind: "release-v2",
          payload: {
            orderId,
            intentDigest,
            releaseSecret: `0x${"aa".repeat(32)}`,
          },
        });
      }
      const fill = {
        orderDigest,
        intentDigest: `0x${"bb".repeat(32)}`,
        takerEthAccount: `0x${"77".repeat(20)}`,
        takerQrlAccount: `Q${"88".repeat(20)}`,
        releaseCommitment: `0x${"99".repeat(32)}`,
        hashlock: `0x${"cc".repeat(32)}`,
        initiatorTimeout: Number.MAX_SAFE_INTEGER,
        responderTimeout: Number.MAX_SAFE_INTEGER,
      };
      const intent = {
        orderDigest,
        takerEthAccount: fill.takerEthAccount,
        takerQrlAccount: fill.takerQrlAccount,
        releaseCommitment: fill.releaseCommitment,
      };
      for (let terminal = 0; terminal < 3; terminal += 1) {
        add({
          kind: "fill-v2",
          payload: { orderId, fill, auth, intent, intentAuth: auth },
        });
      }
      add({
        kind: "release-v2",
        payload: {
          orderId,
          fillDigest: `0x${"dd".repeat(32)}`,
          releaseSecret: `0x${"ee".repeat(32)}`,
        },
      });
    }

    const serialized = serializeFederationPage({
      reset: true,
      cursor: `${"0".repeat(32)}:0`,
      hasMore: false,
      events: [],
      snapshot,
    });
    assert.ok(
      Buffer.byteLength(serialized, "utf8") < MAX_FEDERATION_RESPONSE_BYTES,
    );
  });
});
