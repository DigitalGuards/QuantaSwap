import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { federationEventId, type FederationEvent } from "./federation.js";
import {
  FederationPeerSync,
  parseFederationPage,
  readFederationJson,
} from "./peer-sync.js";

const event: FederationEvent = {
  kind: "release-v1",
  payload: {
    fillDigest: `0x${"11".repeat(32)}`,
    releaseSecret: `0x${"22".repeat(32)}`,
  },
};

const record = {
  seq: 7,
  eventId: federationEventId(event),
  event,
};

describe("federation peer pages", () => {
  it("accepts a bounded incremental page", () => {
    const parsed = parseFederationPage({
      reset: false,
      cursor: `${"ab".repeat(16)}:7`,
      hasMore: false,
      events: [record],
    });
    assert.equal(parsed.events[0]?.eventId, record.eventId);
    assert.equal(parsed.snapshot, undefined);
  });

  it("requires a snapshot exactly when reset is true", () => {
    assert.throws(
      () =>
        parseFederationPage({
          reset: true,
          cursor: `${"ab".repeat(16)}:7`,
          hasMore: false,
          events: [],
        }),
      /omitted its snapshot/,
    );
    assert.throws(
      () =>
        parseFederationPage({
          reset: false,
          cursor: `${"ab".repeat(16)}:7`,
          hasMore: false,
          events: [],
          snapshot: [],
        }),
      /snapshot without a reset/,
    );
  });

  it("rejects content hash and cursor tampering", () => {
    assert.throws(
      () =>
        parseFederationPage({
          reset: false,
          cursor: `${"ab".repeat(16)}:7`,
          hasMore: false,
          events: [{ ...record, eventId: "0".repeat(64) }],
        }),
      /content hash does not match/,
    );
    assert.throws(
      () =>
        parseFederationPage({
          reset: false,
          cursor: "foreign",
          hasMore: false,
          events: [],
        }),
      /invalid cursor/,
    );
  });

  it("bounds and content-types peer response bodies before parsing", async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
    assert.deepEqual(await readFederationJson(response, 64), { ok: true });

    await assert.rejects(
      readFederationJson(
        new Response("not json", { headers: { "Content-Type": "text/plain" } }),
        64,
      ),
      /non-JSON/,
    );
    await assert.rejects(
      readFederationJson(
        new Response(JSON.stringify({ payload: "x".repeat(100) }), {
          headers: { "Content-Type": "application/json" },
        }),
        32,
      ),
      /size limit/,
    );
  });

  it("backs off a failing peer and clears the delay after success", async () => {
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let clock = 1_000;
    let calls = 0;
    Date.now = () => clock;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) throw new Error("peer unavailable");
      return new Response(
        JSON.stringify({
          reset: false,
          cursor: `${"aa".repeat(16)}:0`,
          hasMore: false,
          events: [],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    };
    try {
      const sync = new FederationPeerSync({
        peers: ["https://mirror.example/api"],
        timeoutMs: 1_000,
        apply: () => "applied",
      });
      await sync.syncAll();
      await sync.syncAll();
      assert.equal(calls, 1);
      clock += 10_000;
      await sync.syncAll();
      await sync.syncAll();
      assert.equal(calls, 3);
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
    }
  });

  it("backs off repeated reset snapshots from one peer", async () => {
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let clock = 1_000;
    let calls = 0;
    Date.now = () => clock;
    globalThis.fetch = async () => {
      calls += 1;
      const feedId = (calls % 2 === 0 ? "bb" : "cc").repeat(16);
      return new Response(
        JSON.stringify({
          reset: true,
          cursor: `${feedId}:0`,
          hasMore: false,
          events: [],
          snapshot: [],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    };
    try {
      const sync = new FederationPeerSync({
        peers: ["https://churning.example/api"],
        timeoutMs: 1_000,
        apply: () => "applied",
      });
      await sync.syncAll();
      await sync.syncAll();
      await sync.syncAll();
      assert.equal(calls, 2);
      clock += 10_000;
      await sync.syncAll();
      assert.equal(calls, 3);
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
    }
  });

  it("retries dependency-missing events after their prerequisite arrives", async () => {
    const release: FederationEvent = {
      kind: "release-v1",
      payload: {
        orderId: "a".repeat(64),
        intentDigest: `0x${"11".repeat(32)}`,
        releaseSecret: `0x${"22".repeat(32)}`,
      },
    };
    const order: FederationEvent = {
      kind: "order-v1",
      payload: { order: { marker: "order" }, auth: { marker: "auth" } },
    };
    const records = [release, order].map((entry, index) => ({
      seq: index + 1,
      eventId: federationEventId(entry),
      event: entry,
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          reset: false,
          cursor: `${"ab".repeat(16)}:2`,
          hasMore: false,
          events: records,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    const applied: string[] = [];
    let hasOrder = false;
    try {
      const sync = new FederationPeerSync({
        peers: ["https://mirror.example/api"],
        timeoutMs: 1_000,
        apply: (candidate) => {
          if (candidate.kind === "release-v1" && !hasOrder) return "deferred";
          if (candidate.kind === "order-v1") hasOrder = true;
          applied.push(candidate.kind);
          return "applied";
        },
      });
      await sync.syncAll();
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(applied, ["order-v1", "release-v1"]);
  });

  it("retries a transient capacity rejection without replaying the peer page", async () => {
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let clock = 1_000;
    let fetchCount = 0;
    let capacityAvailable = false;
    let applied = 0;
    Date.now = () => clock;
    globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response(
        JSON.stringify({
          reset: false,
          cursor: `${"ab".repeat(16)}:1`,
          hasMore: false,
          events: fetchCount === 1 ? [record] : [],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    };
    try {
      const sync = new FederationPeerSync({
        peers: ["https://mirror.example/api"],
        timeoutMs: 1_000,
        apply: () => {
          if (!capacityAvailable) return "deferred";
          applied += 1;
          return "applied";
        },
      });
      await sync.syncAll();
      capacityAvailable = true;
      clock += 501;
      await sync.syncAll();
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
    }
    assert.equal(fetchCount, 2);
    assert.equal(applied, 1);
  });

  it("isolates a peer that exhausts its deferred-event quota", async () => {
    const hostilePeer = "https://hostile.example/api";
    const honestPeer = "https://honest.example/api";
    const hostileEvents = Array.from({ length: 513 }, (_, index) => {
      const candidate: FederationEvent = {
        kind: "release-v1",
        payload: {
          orderId: "a".repeat(64),
          intentDigest: `0x${index.toString(16).padStart(64, "0")}`,
          releaseSecret: `0x${"33".repeat(32)}`,
        },
      };
      return {
        seq: index + 1,
        eventId: federationEventId(candidate),
        event: candidate,
      };
    });
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    const hostileUrls: string[] = [];
    const errors: Array<{ peer: string; message: string }> = [];
    let clock = 1_000;
    let hostilePage = 0;
    let honestFetches = 0;
    let honestReady = false;
    let honestApplied = 0;
    Date.now = () => clock;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith(hostilePeer)) {
        hostileUrls.push(url);
        const page = hostilePage % 3;
        hostilePage += 1;
        const start = page * 256;
        const records = hostileEvents.slice(start, start + 256);
        return new Response(
          JSON.stringify({
            reset: false,
            cursor: `${"cd".repeat(16)}:${start + records.length}`,
            hasMore: page < 2,
            events: records,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      honestFetches += 1;
      return new Response(
        JSON.stringify({
          reset: false,
          cursor: `${"ef".repeat(16)}:1`,
          hasMore: false,
          events: honestFetches === 1 ? [record] : [],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    };
    try {
      const sync = new FederationPeerSync({
        peers: [hostilePeer, honestPeer],
        timeoutMs: 1_000,
        apply: (_candidate, peer) => {
          if (peer === hostilePeer || !honestReady) return "deferred";
          honestApplied += 1;
          return "applied";
        },
        onError: (peer, error) => {
          errors.push({
            peer,
            message: error instanceof Error ? error.message : String(error),
          });
        },
      });
      await sync.syncAll();
      const firstRunHostileRequests = hostileUrls.length;
      honestReady = true;
      clock += 501;
      await sync.syncAll();
      assert.equal(hostileUrls.length, firstRunHostileRequests);
      clock += 9_499;
      await sync.syncAll();
      assert.equal(
        new URL(hostileUrls[firstRunHostileRequests]!).searchParams.has("cursor"),
        false,
      );
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
    }
    assert.equal(honestApplied, 1);
    assert.ok(
      errors.some(
        ({ peer, message }) =>
          peer === hostilePeer && message.includes("deferred-event quota"),
      ),
    );
    assert.equal(errors.some(({ peer }) => peer === honestPeer), false);
  });
});
