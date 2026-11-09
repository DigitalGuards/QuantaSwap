import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { federationEventId, type FederationEvent } from "./federation.js";
import { FederationPeerSync } from "./peer-sync.js";

const HOUR_MS = 60 * 60 * 1000;
const peer = "https://busy.example/api";
const feedId = "ab".repeat(16);

function child(index = 1): FederationEvent {
  return {
    kind: "release-v2",
    payload: {
      orderId: "a".repeat(64),
      intentDigest: `0x${index.toString(16).padStart(64, "0")}`,
      releaseSecret: `0x${"44".repeat(32)}`,
    },
  };
}

const parent: FederationEvent = {
  kind: "order-v2",
  payload: { order: {}, auth: {} },
};

function response(
  reset: boolean,
  events: FederationEvent[],
  sequence: number,
  id = feedId,
): Promise<Response> {
  const records = events.map((event, index) => ({
    seq: reset ? sequence : sequence - events.length + index + 1,
    eventId: federationEventId(event),
    event,
  }));
  return Promise.resolve(
    new Response(
      JSON.stringify({
        reset,
        cursor: `${id}:${sequence}`,
        hasMore: false,
        events: reset ? [] : records,
        ...(reset ? { snapshot: records } : {}),
      }),
      { headers: { "Content-Type": "application/json" } },
    ),
  );
}

void describe("federation deferred recovery", () => {
  void it("applies an out-of-order child when a later incremental page supplies its parent", async (t) => {
    let clock = 1000;
    t.mock.method(Date, "now", () => clock);
    let cycle = 0;
    let hasParent = false;
    let applied = 0;
    const errors: unknown[] = [];
    const sync = new FederationPeerSync({
      peers: [peer],
      timeoutMs: 1000,
      fetch: () =>
        cycle === 0
          ? response(true, [], 0)
          : response(false, [cycle === 1 ? child() : parent], cycle),
      apply: (event) => {
        if (event.kind === "order-v2") hasParent = true;
        else if (!hasParent) return "deferred";
        else applied += 1;
        return "applied";
      },
      onError: (_peer, error) => errors.push(error),
    });
    await sync.syncAll();
    cycle = 1;
    await sync.syncAll();
    assert.equal(sync.status().deferredEvents, 1);
    assert.equal(applied, 0);
    clock += 501;
    cycle = 2;
    await sync.syncAll();
    assert.equal(applied, 1);
    assert.equal(sync.status().deferredEvents, 0);
    assert.equal(sync.status().state, "healthy");
    assert.deepEqual(errors, []);
  });

  void it("uses all causal passes to repair an expired child omitted from the recovery snapshot", async (t) => {
    let clock = 1000;
    t.mock.method(Date, "now", () => clock);
    let hasParent = false;
    let parentAttempts = 0;
    let applied = 0;
    const cursors: (string | null)[] = [];
    const errors: unknown[] = [];
    const sync = new FederationPeerSync({
      peers: [peer],
      timeoutMs: 1000,
      fetch: (input) => {
        const cursor = new URL(String(input)).searchParams.get("cursor");
        cursors.push(cursor);
        if (cursor !== null) return response(false, [], 2);
        return clock === 1000
          ? response(true, [child()], 1)
          : response(true, [parent], 2);
      },
      apply: (event) => {
        if (event.kind === "order-v2") {
          parentAttempts += 1;
          if (parentAttempts === 1) return "deferred";
          hasParent = true;
        } else if (!hasParent) return "deferred";
        else applied += 1;
        return "applied";
      },
      onError: (_peer, error) => errors.push(error),
    });
    await sync.syncAll();
    assert.equal(sync.status().deferredEvents, 1);
    clock += HOUR_MS;
    await sync.syncAll();
    assert.equal(parentAttempts, 2);
    assert.equal(applied, 1);
    assert.equal(sync.status().deferredEvents, 0);
    assert.equal(sync.status().state, "healthy");
    await sync.syncAll();
    assert.deepEqual(cursors, [null, null, `${feedId}:2`]);
    assert.deepEqual(errors, []);
  });

  void it("retires only the omitting source of a shared event while another source is offline", async (t) => {
    let clock = 1000;
    t.mock.method(Date, "now", () => clock);
    const other = "https://other.example/api";
    let cycle = 0;
    let hasParent = false;
    const applied: string[] = [];
    const errors: string[] = [];
    const sync = new FederationPeerSync({
      peers: [peer, other],
      timeoutMs: 1000,
      fetch: (input) => {
        const isOther = String(input).startsWith(other);
        const id = isOther ? "cd".repeat(16) : feedId;
        if (cycle === 1 && isOther)
          return Promise.resolve(new Response(null, { status: 503 }));
        if (cycle === 2 && !isOther) return response(false, [], 1, id);
        return response(
          true,
          cycle === 0 ? [child()] : isOther ? [child(), parent] : [],
          1,
          id,
        );
      },
      apply: (event, source) => {
        if (event.kind === "order-v2") hasParent = true;
        else if (!hasParent) return "deferred";
        else applied.push(source);
        return "applied";
      },
      onError: (source) => errors.push(source),
    });
    await sync.syncAll();
    assert.equal(sync.status().deferredEvents, 1);
    clock += 501;
    cycle = 1;
    await sync.syncAll();
    assert.equal(sync.status().deferredEvents, 1);
    assert.equal(sync.status().peers[0]?.resetStreak, 1);
    assert.equal(sync.status().peers[1]?.state, "degraded");
    clock += 10000;
    cycle = 2;
    await sync.syncAll();
    assert.deepEqual(applied, [other]);
    assert.deepEqual(errors, [other]);
    assert.equal(sync.status().deferredEvents, 0);
    clock += 10000;
    await sync.syncAll();
    assert.equal(sync.status().peers[0]?.state, "healthy");
  });

  for (const failure of [
    "transport",
    "malformed",
    "rejected",
    "application",
  ] as const) {
    void it(`preserves unexpired claims after a ${failure} snapshot failure and bounds their lifetime`, async (t) => {
      let clock = 1000;
      t.mock.method(Date, "now", () => clock);
      let cycle = 0;
      const cursors: (string | null)[] = [];
      const sync = new FederationPeerSync({
        peers: [peer],
        timeoutMs: 1000,
        fetch: (input) => {
          cursors.push(new URL(String(input)).searchParams.get("cursor"));
          if (cycle === 0) return response(true, [child()], 1);
          if (cycle === 1) {
            if (failure === "transport")
              return Promise.resolve(new Response(null, { status: 503 }));
            if (failure === "malformed")
              return Promise.resolve(
                new Response("{}", {
                  headers: { "Content-Type": "application/json" },
                }),
              );
            return response(true, [parent], 2);
          }
          return Promise.resolve(new Response(null, { status: 503 }));
        },
        apply: (event) => {
          if (event.kind === "order-v2") {
            if (failure === "application")
              throw new Error("storage unavailable");
            return "rejected";
          }
          return "deferred";
        },
      });
      await sync.syncAll();
      clock += 501;
      cycle = 1;
      await sync.syncAll();
      assert.equal(sync.status().deferredEvents, 1);
      assert.equal(sync.status().state, "degraded");
      clock += HOUR_MS;
      cycle = 2;
      await sync.syncAll();
      assert.equal(sync.status().deferredEvents, 0);
      assert.equal(sync.status().state, "degraded");
      assert.equal(cursors[0], null);
      assert.equal(cursors[1], `${feedId}:1`);
      assert.equal(cursors[2], null);
    });
  }

  void it("enforces the rejection budget during expired-event snapshot retries", async (t) => {
    let clock = 1000;
    t.mock.method(Date, "now", () => clock);
    let reject = false;
    let rejected = 0;
    const sync = new FederationPeerSync({
      peers: [peer],
      timeoutMs: 1000,
      fetch: () =>
        response(
          true,
          Array.from({ length: 12 }, (_value, index) => child(index)),
          12,
        ),
      apply: () => {
        if (!reject) return "deferred";
        rejected += 1;
        return "rejected";
      },
    });
    await sync.syncAll();
    clock += HOUR_MS;
    reject = true;
    await sync.syncAll();
    assert.equal(rejected, 8);
    assert.equal(sync.status().deferredEvents, 0);
    assert.equal(sync.status().state, "degraded");
    assert.equal(sync.status().peers[0]?.nextAttemptAt, clock + 20000);
  });

  void it("keeps the shared global deferred budget and isolates only its overflow source", async (t) => {
    let clock = 1000;
    t.mock.method(Date, "now", () => clock);
    const peers = Array.from(
      { length: 9 },
      (_value, index) => `https://peer-${index}.example/api`,
    );
    const shared = child(0);
    let cycle = 0;
    let sharedReady = false;
    let applied = 0;
    const errors: string[] = [];
    const sync = new FederationPeerSync({
      peers,
      timeoutMs: 10000,
      fetch: (input) => {
        const url = new URL(String(input));
        const index = peers.findIndex((source) =>
          String(input).startsWith(source),
        );
        const id = index.toString(16).repeat(32);
        if (cycle === 0) {
          const events = [
            shared,
            ...Array.from({ length: index === 8 ? 7 : 511 }, (_value, offset) =>
              child(index * 512 + offset + 1),
            ),
          ];
          return response(true, events, 1, id);
        }
        if (index === 8) return response(false, [child(10000)], 2, id);
        assert.equal(url.searchParams.get("cursor"), `${id}:1`);
        return response(false, [], 1, id);
      },
      apply: (event) => {
        if (
          sharedReady &&
          federationEventId(event) === federationEventId(shared)
        ) {
          applied += 1;
          return "applied";
        }
        return "deferred";
      },
      onError: (source, error) => errors.push(`${source}: ${String(error)}`),
    });
    await sync.syncAll();
    assert.equal(sync.status().deferredEvents, 4096);
    cycle = 1;
    await sync.syncAll();
    assert.equal(sync.status().deferredEvents, 4089);
    assert.equal(sync.status().healthyPeers, 8);
    assert.equal(sync.status().peers[8]?.state, "degraded");
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /peer-8.*global bound/);
    sharedReady = true;
    clock += 501;
    await sync.syncAll();
    assert.equal(applied, 1);
    assert.equal(sync.status().deferredEvents, 4088);
  });
});
