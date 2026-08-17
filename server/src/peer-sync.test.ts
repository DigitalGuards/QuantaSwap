import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  MAX_FEDERATION_RESPONSE_BYTES,
  federationEventId,
  type FederationEvent,
} from "./federation.js";
import {
  FederationPeerSync,
  parseFederationPage,
  readFederationJson,
  validateFederationPageProgress,
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

function releaseEvent(index: number, orderId = "a".repeat(64)): FederationEvent {
  return {
    kind: "release-v1",
    payload: {
      orderId,
      intentDigest: `0x${index.toString(16).padStart(64, "0")}`,
      releaseSecret: `0x${"44".repeat(32)}`,
    },
  };
}

function federationResponse(page: Record<string, unknown>): Response {
  return new Response(JSON.stringify(page), {
    headers: { "Content-Type": "application/json" },
  });
}

describe("federation peer pages", () => {
  it("reports a privacy-safe disabled status", async () => {
    const sync = new FederationPeerSync({
      peers: [],
      timeoutMs: 1_000,
      apply: () => "applied",
    });
    assert.deepEqual(sync.status(1_000), {
      enabled: false,
      state: "disabled",
      running: false,
      configuredPeers: 0,
      healthyPeers: 0,
      deferredEvents: 0,
      lastCompletedAt: null,
      peers: [],
    });
    assert.throws(
      () =>
        new FederationPeerSync({
          peers: Array.from(
            { length: 17 },
            (_unused, index) => `https://mirror-${index + 1}.example/api`,
          ),
          timeoutMs: 1_000,
          apply: () => "applied",
        }),
      /peer count exceeds/,
    );
    assert.throws(
      () =>
        new FederationPeerSync({
          peers: ["https://mirror.example/api", "https://mirror.example/api"],
          timeoutMs: 1_000,
          apply: () => "applied",
        }),
      /peers contain duplicates/,
    );
    assert.throws(
      () =>
        new FederationPeerSync({
          peers: ["https://mirror.example/api"],
          peerTokens: [],
          timeoutMs: 1_000,
          apply: () => "applied",
        }),
      /peer tokens are invalid/,
    );
  });

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

  it("accepts sequence zero only in reset snapshots", () => {
    const reset = parseFederationPage({
      reset: true,
      cursor: `${"ab".repeat(16)}:0`,
      hasMore: false,
      events: [],
      snapshot: [{ ...record, seq: 0 }],
    });
    assert.equal(reset.snapshot?.[0]?.seq, 0);

    assert.throws(
      () =>
        parseFederationPage({
          reset: false,
          cursor: `${"ab".repeat(16)}:0`,
          hasMore: false,
          events: [{ ...record, seq: 0 }],
        }),
      /invalid sequence/,
    );
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

  it("requires canonical safe-integer cursor sequences", () => {
    for (const sequence of ["00", "01", "9007199254740992", "10000000000000000"]) {
      assert.throws(
        () =>
          parseFederationPage({
            reset: true,
            cursor: `${"ab".repeat(16)}:${sequence}`,
            hasMore: false,
            events: [],
            snapshot: [],
          }),
        /invalid cursor/,
      );
    }
    assert.doesNotThrow(() =>
      parseFederationPage({
        reset: true,
        cursor: `${"ab".repeat(16)}:${Number.MAX_SAFE_INTEGER}`,
        hasMore: false,
        events: [],
        snapshot: [],
      }),
    );

    const page = parseFederationPage({
      reset: false,
      cursor: `${"ab".repeat(16)}:2`,
      hasMore: false,
      events: [{ ...record, seq: 2 }],
    });
    assert.throws(
      () => validateFederationPageProgress(`${"ab".repeat(16)}:01`, page),
      /invalid cursor/,
    );
  });

  it("rejects unknown page, record, and event envelope fields", () => {
    assert.throws(
      () =>
        parseFederationPage({
          reset: false,
          cursor: `${"ab".repeat(16)}:7`,
          hasMore: false,
          events: [record],
          padding: "ignored",
        }),
      /page has invalid fields/,
    );
    assert.throws(
      () =>
        parseFederationPage({
          reset: false,
          cursor: `${"ab".repeat(16)}:7`,
          hasMore: false,
          events: [{ ...record, padding: "ignored" }],
        }),
      /event 0 has invalid fields/,
    );
    assert.throws(
      () =>
        parseFederationPage({
          reset: false,
          cursor: `${"ab".repeat(16)}:7`,
          hasMore: false,
          events: [
            {
              ...record,
              event: { ...event, padding: "ignored" },
            },
          ],
        }),
      /event 0 event has invalid fields/,
    );
    assert.throws(
      () =>
        parseFederationPage({
          reset: false,
          cursor: `${"ab".repeat(16)}:7`,
          hasMore: false,
          events: [record],
          snapshot: undefined,
        }),
      /snapshot without a reset/,
    );
  });

  it("rejects duplicate event ids before accepting a page", () => {
    assert.throws(
      () =>
        parseFederationPage({
          reset: false,
          cursor: `${"ab".repeat(16)}:8`,
          hasMore: false,
          events: [record, { ...record, seq: 8, event: null }],
        }),
      /duplicate event id/,
    );
    assert.throws(
      () =>
        parseFederationPage({
          reset: true,
          cursor: `${"ab".repeat(16)}:7`,
          hasMore: false,
          events: [],
          snapshot: [record, record],
        }),
      /duplicate event id/,
    );
  });

  it("rejects reset amplification and nonadvancing continuation pages", () => {
    assert.throws(
      () =>
        parseFederationPage({
          reset: true,
          cursor: `${"ab".repeat(16)}:0`,
          hasMore: true,
          events: [],
          snapshot: [],
        }),
      /reset cannot continue/,
    );
    assert.throws(
      () =>
        parseFederationPage({
          reset: false,
          cursor: `${"ab".repeat(16)}:0`,
          hasMore: true,
          events: [],
        }),
      /continuation page cannot be empty/,
    );

    const page = parseFederationPage({
      reset: false,
      cursor: `${"ab".repeat(16)}:7`,
      hasMore: false,
      events: [record],
    });
    assert.doesNotThrow(() =>
      validateFederationPageProgress(`${"ab".repeat(16)}:6`, page),
    );
    assert.throws(
      () => validateFederationPageProgress(`${"cd".repeat(16)}:6`, page),
      /changed feed id/,
    );
    assert.throws(
      () => validateFederationPageProgress(null, page),
      /required initial reset/,
    );

    const nextEvent = releaseEvent(2);
    assert.throws(
      () =>
        parseFederationPage({
          reset: false,
          cursor: `${"ab".repeat(16)}:9`,
          hasMore: false,
          events: [
            record,
            {
              seq: 9,
              eventId: federationEventId(nextEvent),
              event: nextEvent,
            },
          ],
        }),
      /not contiguous/,
    );

    const stalePage = parseFederationPage({
      reset: false,
      cursor: `${"ab".repeat(16)}:7`,
      hasMore: false,
      events: [],
    });
    assert.throws(
      () => validateFederationPageProgress(`${"ab".repeat(16)}:8`, stalePage),
      /nonadvancing empty page/,
    );
  });

  it("bounds and content-types peer response bodies before parsing", async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
    assert.deepEqual(await readFederationJson(response, 64), { ok: true });
    assert.deepEqual(
      await readFederationJson(
        new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "Application/JSON; Charset=UTF-8" },
        }),
        64,
      ),
      { ok: true },
    );

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
    await assert.rejects(
      readFederationJson(
        new Response("{}", { headers: { "Content-Type": "application/json" } }),
        MAX_FEDERATION_RESPONSE_BYTES + 1,
      ),
      /byte limit is invalid/,
    );
  });

  it("sends an aligned bearer token only to its configured peer", async () => {
    const authenticatedPeer = "https://reserved.example/api";
    const publicPeer = "https://public.example/api";
    const token = "reserved_token-123";
    const originalFetch = globalThis.fetch;
    const requestHeaders = new Map<string, Array<[string, string]>>();
    globalThis.fetch = async (input, init) => {
      const peer = String(input).startsWith(authenticatedPeer)
        ? authenticatedPeer
        : publicPeer;
      const captured: Array<[string, string]> = [];
      new Headers(init?.headers).forEach((value, key) => captured.push([key, value]));
      requestHeaders.set(peer, captured);
      const feedId = peer === authenticatedPeer ? "ab" : "cd";
      return federationResponse({
        reset: true,
        cursor: `${feedId.repeat(16)}:0`,
        hasMore: false,
        events: [],
        snapshot: [],
      });
    };
    try {
      const sync = new FederationPeerSync({
        peers: [authenticatedPeer, publicPeer],
        peerTokens: [token, null],
        timeoutMs: 1_000,
        apply: () => "applied",
      });
      await sync.syncAll();
      assert.deepEqual(requestHeaders.get(authenticatedPeer), [
        ["accept", "application/json"],
        ["authorization", `Bearer ${token}`],
      ]);
      assert.deepEqual(requestHeaders.get(publicPeer), [
        ["accept", "application/json"],
      ]);
      assert.equal(JSON.stringify(sync.status()).includes(token), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("applies a sequence-zero reset snapshot before an empty incremental page", async () => {
    const peer = "https://new-feed.example/api";
    const feedId = "ef".repeat(16);
    const originalFetch = globalThis.fetch;
    const requestedCursors: Array<string | null> = [];
    let fetchCount = 0;
    let applyCount = 0;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      requestedCursors.push(url.searchParams.get("cursor"));
      fetchCount += 1;
      return federationResponse(
        fetchCount === 1
          ? {
              reset: true,
              cursor: `${feedId}:0`,
              hasMore: false,
              events: [],
              snapshot: [{ ...record, seq: 0 }],
            }
          : {
              reset: false,
              cursor: `${feedId}:0`,
              hasMore: false,
              events: [],
            },
      );
    };
    try {
      const sync = new FederationPeerSync({
        peers: [peer],
        timeoutMs: 1_000,
        apply: () => {
          applyCount += 1;
          return "applied";
        },
      });
      await sync.syncAll();
      await sync.syncAll();

      assert.equal(applyCount, 1);
      assert.deepEqual(requestedCursors, [null, `${feedId}:0`]);
      assert.equal(sync.status().peers[0]?.state, "healthy");
    } finally {
      globalThis.fetch = originalFetch;
    }
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
          reset: calls === 2,
          cursor: `${"aa".repeat(16)}:0`,
          hasMore: false,
          events: [],
          ...(calls === 2 ? { snapshot: [] } : {}),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    };
    try {
      const sync = new FederationPeerSync({
        peers: ["https://mirror.example/api"],
        peerIds: ["community"],
        timeoutMs: 1_000,
        staleAfterMs: 30_000,
        apply: () => "applied",
      });
      assert.deepEqual(sync.status(clock).peers, [
        {
          id: "community",
          state: "pending",
          consecutiveFailures: 0,
          resetStreak: 0,
          lastAttemptAt: null,
          lastSuccessAt: null,
          nextAttemptAt: null,
        },
      ]);
      await sync.syncAll();
      const failedStatus = sync.status(clock);
      assert.equal(failedStatus.state, "degraded");
      assert.equal(failedStatus.peers[0]?.state, "degraded");
      assert.equal(failedStatus.peers[0]?.consecutiveFailures, 1);
      assert.equal(failedStatus.peers[0]?.lastAttemptAt, 1_000);
      assert.equal(failedStatus.peers[0]?.lastSuccessAt, null);
      assert.equal(failedStatus.peers[0]?.nextAttemptAt, 11_000);
      assert.equal(JSON.stringify(failedStatus).includes("mirror.example"), false);
      await sync.syncAll();
      assert.equal(calls, 1);
      clock += 10_000;
      await sync.syncAll();
      const recoveredStatus = sync.status(clock);
      assert.equal(recoveredStatus.state, "healthy");
      assert.equal(recoveredStatus.healthyPeers, 1);
      assert.equal(recoveredStatus.peers[0]?.state, "healthy");
      assert.equal(recoveredStatus.peers[0]?.consecutiveFailures, 0);
      assert.equal(recoveredStatus.peers[0]?.lastSuccessAt, 11_000);
      assert.equal(recoveredStatus.peers[0]?.nextAttemptAt, null);
      assert.equal(sync.status(clock + 30_001).peers[0]?.state, "stale");
      await sync.syncAll();
      assert.equal(calls, 3);
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
    }
  });

  it("does not hide a stale peer while a new sync is in progress", async () => {
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let clock = 1_000;
    let calls = 0;
    let resolveSecond: ((response: Response) => void) | undefined;
    const page = (reset: boolean) =>
      new Response(
        JSON.stringify({
          reset,
          cursor: `${"aa".repeat(16)}:0`,
          hasMore: false,
          events: [],
          ...(reset ? { snapshot: [] } : {}),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    Date.now = () => clock;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) return page(true);
      return new Promise<Response>((resolve) => {
        resolveSecond = resolve;
      });
    };
    try {
      const sync = new FederationPeerSync({
        peers: ["https://mirror.example/api"],
        timeoutMs: 1_000,
        staleAfterMs: 30_000,
        apply: () => "applied",
      });
      await sync.syncAll();
      clock += 30_001;
      const running = sync.syncAll();
      await new Promise<void>((resolve) => setImmediate(resolve));

      const stale = sync.status(clock);
      assert.equal(stale.running, true);
      assert.equal(stale.state, "degraded");
      assert.equal(stale.healthyPeers, 0);
      assert.equal(stale.peers[0]?.state, "stale");

      resolveSecond?.(page(false));
      await running;
      assert.equal(sync.status(clock).peers[0]?.state, "healthy");
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

  it("rejects a cross-page duplicate before applying the repeated record", async () => {
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let clock = 1_000;
    const urls: string[] = [];
    const errors: string[] = [];
    let applied = 0;
    Date.now = () => clock;
    globalThis.fetch = async (input) => {
      urls.push(String(input));
      if (urls.length === 1) {
        return federationResponse({
          reset: true,
          cursor: `${"ab".repeat(16)}:0`,
          hasMore: false,
          events: [],
          snapshot: [],
        });
      }
      if (urls.length === 2) {
        return federationResponse({
          reset: false,
          cursor: `${"ab".repeat(16)}:1`,
          hasMore: true,
          events: [{ ...record, seq: 1 }],
        });
      }
      if (urls.length === 3) {
        return federationResponse({
          reset: false,
          cursor: `${"ab".repeat(16)}:2`,
          hasMore: false,
          events: [{ ...record, seq: 2 }],
        });
      }
      return federationResponse({
        reset: false,
        cursor: `${"ab".repeat(16)}:2`,
        hasMore: false,
        events: [{ ...record, seq: 2 }],
      });
    };
    try {
      const sync = new FederationPeerSync({
        peers: ["https://mirror.example/api"],
        timeoutMs: 1_000,
        apply: () => {
          applied += 1;
          return "applied";
        },
        onError: (_peer, error) => {
          errors.push(error instanceof Error ? error.message : String(error));
        },
      });
      await sync.syncAll();
      await sync.syncAll();
      assert.equal(applied, 1);
      assert.equal(sync.status(clock).peers[0]?.state, "degraded");
      assert.deepEqual(errors, ["federation peer repeated an event id across pages"]);

      clock += 10_000;
      await sync.syncAll();
      assert.equal(new URL(urls[3]!).searchParams.get("cursor"), `${"ab".repeat(16)}:1`);
      assert.equal(applied, 2);
      assert.equal(sync.status(clock).peers[0]?.state, "healthy");
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
    }
  });

  it("rejects a reset that replaces an in-progress page batch", async () => {
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    const first = releaseEvent(20);
    const replacement = releaseEvent(21);
    let clock = 1_000;
    let fetches = 0;
    let applied = 0;
    const errors: string[] = [];
    Date.now = () => clock;
    globalThis.fetch = async () => {
      fetches += 1;
      if (fetches === 1) {
        return federationResponse({
          reset: true,
          cursor: `${"ab".repeat(16)}:0`,
          hasMore: false,
          events: [],
          snapshot: [],
        });
      }
      if (fetches === 2) {
        return federationResponse({
          reset: false,
          cursor: `${"ab".repeat(16)}:1`,
          hasMore: true,
          events: [{ seq: 1, eventId: federationEventId(first), event: first }],
        });
      }
      return federationResponse({
        reset: true,
        cursor: `${"cd".repeat(16)}:1`,
        hasMore: false,
        events: [],
        snapshot: [
          { seq: 1, eventId: federationEventId(replacement), event: replacement },
        ],
      });
    };
    try {
      const sync = new FederationPeerSync({
        peers: ["https://mirror.example/api"],
        timeoutMs: 1_000,
        apply: () => {
          applied += 1;
          return "applied";
        },
        onError: (_peer, error) => {
          errors.push(error instanceof Error ? error.message : String(error));
        },
      });
      await sync.syncAll();
      await sync.syncAll();
      assert.equal(applied, 1);
      assert.deepEqual(errors, ["federation peer reset during pagination"]);
      assert.equal(sync.status(clock).peers[0]?.state, "degraded");
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
    const records = [release, order].map((entry) => ({
      seq: 2,
      eventId: federationEventId(entry),
      event: entry,
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          reset: true,
          cursor: `${"ab".repeat(16)}:2`,
          hasMore: false,
          events: [],
          snapshot: records,
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

  it("collapses a shared deferred event to one apply attempt per pass", async () => {
    const originalFetch = globalThis.fetch;
    let applyCalls = 0;
    globalThis.fetch = async (input) => {
      const feedId = String(input).includes("mirror-a") ? "ab" : "cd";
      return federationResponse({
        reset: true,
        cursor: `${feedId.repeat(16)}:1`,
        hasMore: false,
        events: [],
        snapshot: [{ ...record, seq: 1 }],
      });
    };
    try {
      const sync = new FederationPeerSync({
        peers: ["https://mirror-a.example/api", "https://mirror-b.example/api"],
        timeoutMs: 1_000,
        apply: () => {
          applyCalls += 1;
          return "deferred";
        },
      });
      await sync.syncAll();
      assert.equal(applyCalls, 3);
      assert.equal(sync.status().deferredEvents, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rotates a shared deferred event to a peer whose capacity later recovers", async () => {
    const peerA = "https://mirror-a.example/api";
    const peerB = "https://mirror-b.example/api";
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let clock = 1_000;
    Date.now = () => clock;
    let releasePeerB!: () => void;
    const peerACapacityCheck = new Promise<void>((resolve) => {
      releasePeerB = resolve;
    });
    const applications: string[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      const peer = url.toString().startsWith(peerA) ? peerA : peerB;
      if (peer === peerB) await peerACapacityCheck;
      const feedId = peer === peerA ? "ab" : "cd";
      const initial = !url.searchParams.has("cursor");
      return federationResponse({
        reset: initial,
        cursor: `${feedId.repeat(16)}:1`,
        hasMore: false,
        events: [],
        ...(initial ? { snapshot: [{ ...record, seq: 1 }] } : {}),
      });
    };
    let peerBHasCapacity = false;
    try {
      const sync = new FederationPeerSync({
        peers: [peerA, peerB],
        timeoutMs: 1_000,
        apply: (_candidate, peer) => {
          applications.push(peer);
          if (peer === peerA) {
            releasePeerB();
            return "deferred";
          }
          return peerBHasCapacity ? "applied" : "deferred";
        },
      });
      await sync.syncAll();
      assert.deepEqual(applications, [peerA, peerB, peerA]);
      assert.equal(sync.status().deferredEvents, 1);

      peerBHasCapacity = true;
      clock += 500;
      await sync.syncAll();
      assert.deepEqual(applications, [peerA, peerB, peerA, peerB]);
      assert.equal(sync.status().deferredEvents, 0);
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
    }
  });

  it("deduplicates a settled apply result within each sync cycle", async () => {
    const peers = [
      "https://mirror-a.example/api",
      "https://mirror-b.example/api",
      "https://mirror-c.example/api",
    ];
    const originalFetch = globalThis.fetch;
    let cycle = 0;
    let applyCalls = 0;
    globalThis.fetch = async (input) => {
      const peerIndex = peers.findIndex((peer) => String(input).startsWith(peer));
      const feedId = (peerIndex + 1).toString(16).padStart(2, "0").repeat(16);
      if (cycle === 0) {
        return federationResponse({
          reset: true,
          cursor: `${feedId}:1`,
          hasMore: false,
          events: [],
          snapshot: [{ ...record, seq: 1 }],
        });
      }
      return federationResponse({
        reset: false,
        cursor: `${feedId}:2`,
        hasMore: false,
        events: [{ ...record, seq: 2 }],
      });
    };
    try {
      const sync = new FederationPeerSync({
        peers,
        timeoutMs: 1_000,
        apply: async (): Promise<"applied"> => {
          applyCalls += 1;
          await new Promise<void>((resolve) => setImmediate(resolve));
          return "applied";
        },
      });
      await sync.syncAll();
      assert.equal(applyCalls, 1);
      assert.equal(sync.status().healthyPeers, peers.length);

      cycle = 1;
      await sync.syncAll();
      assert.equal(applyCalls, 2);
      assert.equal(sync.status().healthyPeers, peers.length);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("degrades every source when a shared deferred event is later rejected", async () => {
    const peers = ["https://mirror-a.example/api", "https://mirror-b.example/api"];
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    const errors: Array<{ peer: string; message: string }> = [];
    let clock = 1_000;
    let applyCalls = 0;
    Date.now = () => clock;
    globalThis.fetch = async (input) => {
      const feedId = String(input).includes("mirror-a") ? "ab" : "cd";
      return federationResponse({
        reset: true,
        cursor: `${feedId.repeat(16)}:1`,
        hasMore: false,
        events: [],
        snapshot: [{ ...record, seq: 1 }],
      });
    };
    try {
      const sync = new FederationPeerSync({
        peers,
        timeoutMs: 1_000,
        apply: () => {
          applyCalls += 1;
          return applyCalls === 1 ? "deferred" : "rejected";
        },
        onError: (peer, error) => {
          errors.push({
            peer,
            message: error instanceof Error ? error.message : String(error),
          });
        },
      });
      await sync.syncAll();
      const status = sync.status(clock);
      assert.equal(applyCalls, 2);
      assert.equal(status.deferredEvents, 0);
      assert.deepEqual(
        status.peers.map((peerStatus) => ({
          state: peerStatus.state,
          failures: peerStatus.consecutiveFailures,
          nextAttemptAt: peerStatus.nextAttemptAt,
        })),
        [
          { state: "degraded", failures: 1, nextAttemptAt: 11_000 },
          { state: "degraded", failures: 1, nextAttemptAt: 11_000 },
        ],
      );
      assert.deepEqual(
        errors.map(({ peer, message }) => ({ peer, message })),
        peers.map((peer) => ({
          peer,
          message: "federation peer supplied 1 rejected events",
        })),
      );
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
    }
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
          reset: fetchCount === 1,
          cursor: `${"ab".repeat(16)}:1`,
          hasMore: false,
          events: [],
          ...(fetchCount === 1 ? { snapshot: [{ ...record, seq: 1 }] } : {}),
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

  it("aggregates deferred expiry into peer health and backoff", async () => {
    const peer = "https://mirror.example/api";
    const candidates = [releaseEvent(40), releaseEvent(41)];
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    const errors: string[] = [];
    let clock = 1_000;
    let fetches = 0;
    Date.now = () => clock;
    globalThis.fetch = async () => {
      fetches += 1;
      if (fetches === 1) {
        return federationResponse({
          reset: true,
          cursor: `${"ab".repeat(16)}:2`,
          hasMore: false,
          events: [],
          snapshot: candidates.map((candidate) => ({
            seq: 2,
            eventId: federationEventId(candidate),
            event: candidate,
          })),
        });
      }
      return federationResponse({
        reset: false,
        cursor: `${"ab".repeat(16)}:2`,
        hasMore: false,
        events: [],
      });
    };
    try {
      const sync = new FederationPeerSync({
        peers: [peer],
        timeoutMs: 1_000,
        apply: () => "deferred",
        onError: (_peer, error) => {
          errors.push(error instanceof Error ? error.message : String(error));
        },
      });
      await sync.syncAll();
      assert.equal(sync.status(clock).deferredEvents, 2);

      clock += 60 * 60 * 1_000;
      await sync.syncAll();
      const status = sync.status(clock);
      assert.equal(status.deferredEvents, 0);
      assert.equal(status.peers[0]?.state, "degraded");
      assert.equal(status.peers[0]?.consecutiveFailures, 1);
      assert.equal(status.peers[0]?.nextAttemptAt, clock + 10_000);
      assert.deepEqual(errors, [
        "federation peer had 2 expired deferred events; cursor reset",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
    }
  });

  it("backs off a peer that reaches the rejected-event quota", async () => {
    const hostilePeer = "https://hostile.example/api";
    const honestPeer = "https://honest.example/api";
    const rejectedRecords = Array.from({ length: 12 }, (_, index) => {
      const candidate: FederationEvent = {
        kind: "release-v1",
        payload: {
          orderId: "a".repeat(64),
          intentDigest: `0x${index.toString(16).padStart(64, "0")}`,
          releaseSecret: `0x${"44".repeat(32)}`,
        },
      };
      return {
        seq: 12,
        eventId: federationEventId(candidate),
        event: candidate,
      };
    });
    const originalFetch = globalThis.fetch;
    let rejected = 0;
    let honestApplied = 0;
    const errors: string[] = [];
    globalThis.fetch = async (input) => {
      const hostile = String(input).startsWith(hostilePeer);
      return new Response(
        JSON.stringify({
          reset: true,
          cursor: `${(hostile ? "ab" : "cd").repeat(16)}:${hostile ? 12 : 1}`,
          hasMore: false,
          events: [],
          snapshot: hostile ? rejectedRecords : [{ ...record, seq: 1 }],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    };
    try {
      const sync = new FederationPeerSync({
        peers: [hostilePeer, honestPeer],
        timeoutMs: 1_000,
        apply: (_candidate, peer) => {
          if (peer === hostilePeer) {
            rejected += 1;
            return "rejected";
          }
          honestApplied += 1;
          return "applied";
        },
        onError: (peer, error) => {
          errors.push(`${peer}: ${error instanceof Error ? error.message : String(error)}`);
        },
      });
      await sync.syncAll();
      const status = sync.status();
      assert.equal(status.peers[0]?.state, "degraded");
      assert.equal(status.peers[1]?.state, "healthy");
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(rejected, 8);
    assert.equal(honestApplied, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /hostile.*rejected-event quota/);
  });

  it("replays a rejected reset snapshot before reporting the peer healthy", async () => {
    const peer = "https://hostile.example/api";
    const candidates = Array.from({ length: 10 }, (_, index) => releaseEvent(index + 100));
    const records = candidates.map((candidate) => ({
      seq: 10,
      eventId: federationEventId(candidate),
      event: candidate,
    }));
    const tailEventId = records.at(-1)!.eventId;
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    const urls: string[] = [];
    const errors: string[] = [];
    let clock = 1_000;
    let rejectPrefix = true;
    let tailApplications = 0;
    Date.now = () => clock;
    globalThis.fetch = async (input) => {
      urls.push(String(input));
      return federationResponse({
        reset: true,
        cursor: `${"ab".repeat(16)}:10`,
        hasMore: false,
        events: [],
        snapshot: records,
      });
    };
    try {
      const sync = new FederationPeerSync({
        peers: [peer],
        timeoutMs: 1_000,
        apply: (candidate) => {
          const eventId = federationEventId(candidate);
          if (eventId === tailEventId) {
            tailApplications += 1;
            return "applied";
          }
          return rejectPrefix ? "rejected" : "applied";
        },
        onError: (_peer, error) => {
          errors.push(error instanceof Error ? error.message : String(error));
        },
      });

      await sync.syncAll();
      const rejected = sync.status(clock);
      assert.equal(tailApplications, 0);
      assert.equal(rejected.peers[0]?.state, "degraded");
      assert.equal(rejected.peers[0]?.lastSuccessAt, null);
      assert.equal(rejected.peers[0]?.nextAttemptAt, 11_000);
      assert.deepEqual(errors, ["federation peer reached the rejected-event quota"]);

      await sync.syncAll();
      assert.equal(urls.length, 1);
      rejectPrefix = false;
      clock += 10_000;
      await sync.syncAll();
      assert.equal(new URL(urls[1]!).searchParams.has("cursor"), false);
      assert.equal(tailApplications, 1);
      assert.equal(sync.status(clock).peers[0]?.state, "healthy");
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
    }
  });

  it("aggregates and caps rejected deferred-event retries", async () => {
    const peer = "https://hostile.example/api";
    const candidates = Array.from({ length: 12 }, (_, index) => releaseEvent(index + 200));
    const records = candidates.map((candidate) => ({
      seq: 12,
      eventId: federationEventId(candidate),
      event: candidate,
    }));
    const attempts = new Map<string, number>();
    const errors: string[] = [];
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let clock = 1_000;
    Date.now = () => clock;
    globalThis.fetch = async () =>
      federationResponse({
        reset: true,
        cursor: `${"ab".repeat(16)}:12`,
        hasMore: false,
        events: [],
        snapshot: records,
      });
    try {
      const sync = new FederationPeerSync({
        peers: [peer],
        timeoutMs: 1_000,
        apply: (candidate) => {
          const eventId = federationEventId(candidate);
          const count = (attempts.get(eventId) ?? 0) + 1;
          attempts.set(eventId, count);
          return count === 1 ? "deferred" : "rejected";
        },
        onError: (_peer, error) => {
          errors.push(error instanceof Error ? error.message : String(error));
        },
      });
      await sync.syncAll();
      const status = sync.status(clock);
      assert.equal([...attempts.values()].filter((count) => count === 2).length, 8);
      assert.equal([...attempts.values()].filter((count) => count === 1).length, 4);
      assert.equal(status.deferredEvents, 4);
      assert.equal(status.peers[0]?.state, "degraded");
      assert.equal(status.peers[0]?.nextAttemptAt, 11_000);
      assert.deepEqual(errors, [
        "federation peer supplied 8 rejected deferred events and reached its rejected-event quota",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
    }
  });

  it("shares one rejection budget between fetched and deferred events", async () => {
    const peer = "https://hostile.example/api";
    const deferredCandidates = [releaseEvent(400), releaseEvent(401)];
    const directCandidates = Array.from({ length: 8 }, (_, index) =>
      releaseEvent(index + 500),
    );
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    const attempts = new Map<string, number>();
    const errors: string[] = [];
    let clock = 1_000;
    let cycle = 0;
    Date.now = () => clock;
    globalThis.fetch = async () => {
      if (cycle === 0) {
        return federationResponse({
          reset: true,
          cursor: `${"ab".repeat(16)}:2`,
          hasMore: false,
          events: [],
          snapshot: deferredCandidates.map((candidate) => ({
            seq: 2,
            eventId: federationEventId(candidate),
            event: candidate,
          })),
        });
      }
      return federationResponse({
        reset: false,
        cursor: `${"ab".repeat(16)}:10`,
        hasMore: false,
        events: directCandidates.map((candidate, index) => ({
          seq: index + 3,
          eventId: federationEventId(candidate),
          event: candidate,
        })),
      });
    };
    try {
      const directIds = new Set(directCandidates.map((candidate) => federationEventId(candidate)));
      const sync = new FederationPeerSync({
        peers: [peer],
        timeoutMs: 1_000,
        apply: (candidate) => {
          const eventId = federationEventId(candidate);
          if (directIds.has(eventId)) return "rejected";
          const count = (attempts.get(eventId) ?? 0) + 1;
          attempts.set(eventId, count);
          return count < 3 ? "deferred" : "rejected";
        },
        onError: (_peer, error) => {
          errors.push(error instanceof Error ? error.message : String(error));
        },
      });
      await sync.syncAll();
      assert.equal(sync.status(clock).deferredEvents, 2);

      cycle = 1;
      clock += 501;
      await sync.syncAll();
      assert.equal(sync.status(clock).deferredEvents, 2);
      assert.equal([...attempts.values()].filter((count) => count === 3).length, 0);
      assert.deepEqual(errors, ["federation peer reached the rejected-event quota"]);
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
    }
  });

  it("limits concurrent peer synchronization to two workers", async () => {
    const peers = Array.from(
      { length: 5 },
      (_unused, index) => `https://mirror-${index + 1}.example/api`,
    );
    const originalFetch = globalThis.fetch;
    let active = 0;
    let maxActive = 0;
    let fetches = 0;
    globalThis.fetch = async (input) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      fetches += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      const match = /mirror-([1-5])/.exec(String(input));
      const byte = Number(match?.[1] ?? "0").toString(16).padStart(2, "0");
      return federationResponse({
        reset: true,
        cursor: `${byte.repeat(16)}:0`,
        hasMore: false,
        events: [],
        snapshot: [],
      });
    };
    try {
      const sync = new FederationPeerSync({
        peers,
        timeoutMs: 1_000,
        apply: () => "applied",
      });
      await sync.syncAll();
      assert.equal(fetches, peers.length);
      assert.equal(maxActive, 2);
      assert.equal(sync.status().healthyPeers, peers.length);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("bounds a multipage peer by one total deadline and reaches the queued peer", async () => {
    const slowPeers = ["https://slow-a.example/api", "https://slow-b.example/api"];
    const honestPeer = "https://honest.example/api";
    const peers = [...slowPeers, honestPeer];
    const feedIds = new Map([
      [slowPeers[0]!, "aa".repeat(16)],
      [slowPeers[1]!, "bb".repeat(16)],
      [honestPeer, "cc".repeat(16)],
    ]);
    const slowRequests = new Map<string, number>();
    const errors: Array<{ peer: string; message: string }> = [];
    const originalFetch = globalThis.fetch;
    let cycle = 0;
    let honestApplied = 0;

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const peer = peers.find((candidate) => url.startsWith(candidate));
      assert.notEqual(peer, undefined);
      const feedId = feedIds.get(peer!)!;
      if (cycle === 0) {
        return federationResponse({
          reset: true,
          cursor: `${feedId}:0`,
          hasMore: false,
          events: [],
          snapshot: [],
        });
      }
      if (peer === honestPeer) {
        const candidate = releaseEvent(900);
        return federationResponse({
          reset: false,
          cursor: `${feedId}:1`,
          hasMore: false,
          events: [
            {
              seq: 1,
              eventId: federationEventId(candidate),
              event: candidate,
            },
          ],
        });
      }

      const page = (slowRequests.get(peer!) ?? 0) + 1;
      slowRequests.set(peer!, page);
      const signal = init?.signal;
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, 30);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      const candidate = releaseEvent((peer === slowPeers[0] ? 1_000 : 2_000) + page);
      return federationResponse({
        reset: false,
        cursor: `${feedId}:${page}`,
        hasMore: true,
        events: [
          {
            seq: page,
            eventId: federationEventId(candidate),
            event: candidate,
          },
        ],
      });
    };

    try {
      const sync = new FederationPeerSync({
        peers,
        timeoutMs: 50,
        apply: (_candidate, peer) => {
          if (peer === honestPeer) honestApplied += 1;
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
      cycle = 1;
      await sync.syncAll();

      assert.equal(honestApplied, 1);
      assert.ok([...slowRequests.values()].every((count) => count <= 2));
      assert.deepEqual(
        errors,
        slowPeers.map((peer) => ({
          peer,
          message: "federation peer exceeded the total sync deadline",
        })),
      );
      assert.equal(sync.status().peers[2]?.state, "healthy");
    } finally {
      globalThis.fetch = originalFetch;
    }
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
    let honestFetches = 0;
    let honestReady = false;
    let honestApplied = 0;
    Date.now = () => clock;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith(hostilePeer)) {
        hostileUrls.push(url);
        return new Response(
          JSON.stringify({
            reset: true,
            cursor: `${"cd".repeat(16)}:513`,
            hasMore: false,
            events: [],
            snapshot: hostileEvents.map((entry) => ({ ...entry, seq: 513 })),
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      honestFetches += 1;
      return new Response(
        JSON.stringify({
          reset: honestFetches === 1,
          cursor: `${"ef".repeat(16)}:1`,
          hasMore: false,
          events: [],
          ...(honestFetches === 1 ? { snapshot: [{ ...record, seq: 1 }] } : {}),
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
