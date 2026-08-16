import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  FederationFeed,
  canonicalFederationJson,
  federationEventId,
  type FederationEvent,
} from "./federation.js";

const orderEvent = (id: string): FederationEvent => ({
  kind: "order-v1",
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
      kind: "cancel-v1",
      payload: { cancel: { reasonCode: 1, orderDigest: `0x${"11".repeat(32)}` }, auth: {} },
    };
    const right: FederationEvent = {
      payload: { auth: {}, cancel: { orderDigest: `0x${"11".repeat(32)}`, reasonCode: 1 } },
      kind: "cancel-v1",
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

      const reset = feed.page(null, 8, () => [orderEvent("snapshot")]);
      assert.equal(reset.reset, true);
      assert.equal(reset.snapshot?.length, 1);
      const page = feed.page(reset.cursor.replace(/:[0-9]+$/, `:${first.seq}`), 8, () => []);
      assert.equal(page.reset, false);
      assert.deepEqual(page.events.map((entry) => entry.eventId), [second.eventId]);
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
      assert.equal(stale.snapshot?.[0]?.event.kind, "order-v1");
    });
  });

  it("persists feed identity and rejects corrupted content ids", () => {
    withTempFile((file) => {
      const first = new FederationFeed(file, 8);
      first.append(orderEvent("one"), 100);
      const cursor = first.page(null, 8, () => []).cursor;
      const restored = new FederationFeed(file, 8);
      assert.equal(restored.page(cursor, 8, () => []).reset, false);

      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        events: Array<{ eventId: string }>;
      };
      const event = parsed.events[0];
      assert.ok(event);
      event.eventId = "0".repeat(64);
      writeFileSync(file, JSON.stringify(parsed), "utf8");
      assert.throws(() => new FederationFeed(file, 8), /mismatched id/);
    });
  });

  it("rejects unsupported values and oversized pages", () => {
    withTempFile((file) => {
      const feed = new FederationFeed(file, 8);
      assert.throws(
        () =>
          feed.append({
            kind: "order-v1",
            payload: { unsafe: Number.NaN },
          }),
        /safe integer/,
      );
      assert.throws(() => feed.page(null, 257, () => []), /between 1 and 256/);
    });
  });
});
