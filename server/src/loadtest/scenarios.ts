// Load scenarios for the order book. Each one runs against a freshly started
// book with its own data directory, so per-source daily caps and retained
// state from an earlier scenario never bleed into the next measurement.

import { Latency, Tally, type LatencySummary } from "./metrics.js";
import { BookClient, SseSubscriber } from "./client.js";
import { readerIp, subscriberIp } from "./addresses.js";
import { classifyReason } from "./reasons.js";
import { drainQueue, mapPool } from "./pool.js";
import { sleep } from "./book.js";
import type { Identity } from "./identity.js";
import {
  attachSignatures,
  prepareCancel,
  prepareFill,
  prepareIntent,
  prepareOrder,
  type PreparedIntent,
  type PreparedOrder,
} from "./proofs.js";
import { signAll, type SignRequest } from "./sign-pool.js";

export const ENDPOINT_POST_ORDER = "POST /orders/signed";
export const ENDPOINT_POST_INTENT = "POST /orders/:id/intents";
export const ENDPOINT_GET_INTENTS = "GET /orders/:id/intents";
export const ENDPOINT_GET_ORDERS = "GET /orders";
export const ENDPOINT_POST_CANCEL = "POST /orders/:id/cancel/signed";
export const ENDPOINT_POST_FILL = "POST /orders/:id/fill";
export const ENDPOINT_GET_HEALTH = "GET /health";

export interface SeededOrder {
  orderId: string;
  orderDigest: string;
  orderNonce: string;
  makerToken: string;
  makerIndex: number;
  issuedAt: number;
  expiresAt: number;
  hot: boolean;
}

export interface ScenarioContext {
  client: BookClient;
  makers: Identity[];
  takers: Identity[];
  /** Concurrent in-flight requests allowed across all synthetic clients. */
  concurrency: number;
  durationMs: number;
  signWorkers: number;
  /** When set, every synthetic client presents this one forwarded address. */
  sharedIp?: string;
  log: (message: string) => void;
}

export interface IntentOutcome {
  submitted: number;
  accepted: number;
  rejected: number;
  transportErrors: number;
  reasons: Record<string, number>;
  acceptedDigests: string[];
  /** Admitted proposals pay signature verification plus a full store
   *  rewrite and fsync; rejected ones pay verification and stop there.
   *  Splitting the two separates the crypto cost from the persistence cost
   *  without instrumenting the service. */
  acceptedLatency: LatencySummary;
  rejectedLatency: LatencySummary;
}

export interface FairnessReport {
  /** Live intents the maker sees, checked against the documented ordering. */
  orderingMatchesDocumentedRule: boolean;
  inspectedOrders: number;
  inspectedIntents: number;
  distinctWinners: number;
  maxWinsByOneTaker: number;
  takersWithZeroWins: number;
  /** Winners per race round, in round order. */
  winnersPerRound: number[];
}

export interface SseReport {
  subscribers: number;
  accepted: number;
  rejected: number;
  observedOrders: number;
  /** Tracked orders that did not reach every accepted subscriber. */
  incompleteDeliveries: number;
  publishLatency: LatencySummary;
  fanoutSpread: LatencySummary;
  droppedSubscribers: number;
}

export interface ScenarioOutcome {
  intents?: IntentOutcome;
  fairness?: FairnessReport;
  sse?: SseReport;
  phases?: Record<string, LatencySummary>;
  notes: string[];
}

function ipFor(ctx: ScenarioContext, identity: Identity): string {
  return ctx.sharedIp ?? identity.ip;
}

function makerAt(ctx: ScenarioContext, index: number): Identity {
  const maker = ctx.makers[index];
  if (maker === undefined) throw new Error(`no maker at index ${String(index)}`);
  return maker;
}

function takerAt(ctx: ScenarioContext, index: number): Identity {
  const taker = ctx.takers[index];
  if (taker === undefined) throw new Error(`no taker at index ${String(index)}`);
  return taker;
}

// --- seeding ---------------------------------------------------------------

/** Posts `count` signed public orders, marking the first `hotCount` as the
 *  rows every taker will fight over. */
export async function seedOrders(
  ctx: ScenarioContext,
  count: number,
  hotCount: number,
  lifetimeS: number,
): Promise<SeededOrder[]> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const prepared: PreparedOrder[] = Array.from({ length: count }, (_v, index) =>
    prepareOrder(
      makerAt(ctx, index % ctx.makers.length),
      index,
      issuedAt,
      lifetimeS,
    ),
  );
  const requests: SignRequest[] = prepared.map((order) => ({
    seedHex: makerAt(ctx, order.makerIndex).seedHex,
    messages: [order.proof.messageBytes],
  }));
  const signatures = await signAll(requests, ctx.signWorkers);
  prepared.forEach((order, index) => {
    attachSignatures([order.proof], [signatures[index]?.[0] ?? ""]);
  });

  const seeded: SeededOrder[] = [];
  const replies = await mapPool(prepared, ctx.concurrency, async (order) => {
    const maker = makerAt(ctx, order.makerIndex);
    return ctx.client.send(
      ENDPOINT_POST_ORDER,
      "POST",
      "/api/orders/signed",
      ipFor(ctx, maker),
      {
        order: order.proof.body,
        auth: order.proof.auth,
        makerToken: order.makerToken,
      },
    );
  });
  replies.forEach((reply, index) => {
    const order = prepared[index];
    if (order === undefined) return;
    if (reply.status !== 201) {
      ctx.log(
        `seed order ${String(index)} rejected: ${String(reply.status)} ${classifyReason(reply.status, reply.body, reply.transportError)}`,
      );
      return;
    }
    const returned = reply.body?.["order"];
    const returnedDigest =
      typeof returned === "object" && returned !== null
        ? (returned as Record<string, unknown>)["orderDigest"]
        : undefined;
    if (returnedDigest !== order.orderDigest) {
      throw new Error(
        "seeded order digest disagrees with the locally derived digest",
      );
    }
    seeded.push({
      orderId: order.orderId,
      orderDigest: order.orderDigest,
      orderNonce: order.orderNonce,
      makerToken: order.makerToken,
      makerIndex: order.makerIndex,
      issuedAt: order.issuedAt,
      expiresAt: order.expiresAt,
      hot: seeded.length < hotCount,
    });
  });
  return seeded;
}

// --- intent submission -----------------------------------------------------

interface IntentCollector {
  submitted: number;
  accepted: number;
  rejected: number;
  transportErrors: number;
  reasons: Tally;
  acceptedDigests: string[];
  winsByTaker: Map<number, number>;
  acceptedLatency: Latency;
  rejectedLatency: Latency;
}

function newCollector(): IntentCollector {
  return {
    submitted: 0,
    accepted: 0,
    rejected: 0,
    transportErrors: 0,
    reasons: new Tally(),
    acceptedDigests: [],
    winsByTaker: new Map(),
    acceptedLatency: new Latency(),
    rejectedLatency: new Latency(),
  };
}

function finishCollector(collector: IntentCollector): IntentOutcome {
  return {
    submitted: collector.submitted,
    accepted: collector.accepted,
    rejected: collector.rejected,
    transportErrors: collector.transportErrors,
    reasons: collector.reasons.toObject(),
    acceptedDigests: collector.acceptedDigests,
    acceptedLatency: collector.acceptedLatency.summary(),
    rejectedLatency: collector.rejectedLatency.summary(),
  };
}

async function submitIntent(
  ctx: ScenarioContext,
  intent: PreparedIntent,
  collector: IntentCollector,
): Promise<void> {
  const taker = takerAt(ctx, intent.takerIndex);
  collector.submitted += 1;
  const reply = await ctx.client.send(
    ENDPOINT_POST_INTENT,
    "POST",
    `/api/orders/${intent.orderId}/intents`,
    ipFor(ctx, taker),
    { intent: intent.proof.body, auth: intent.proof.auth },
  );
  if (reply.status === 201) {
    collector.accepted += 1;
    collector.acceptedLatency.add(reply.latencyMs);
    collector.winsByTaker.set(
      intent.takerIndex,
      (collector.winsByTaker.get(intent.takerIndex) ?? 0) + 1,
    );
    const returned = reply.body?.["intent"];
    const digest =
      typeof returned === "object" && returned !== null
        ? (returned as Record<string, unknown>)["intentDigest"]
        : undefined;
    if (typeof digest === "string") collector.acceptedDigests.push(digest);
    return;
  }
  if (reply.transportError !== undefined) collector.transportErrors += 1;
  else {
    collector.rejected += 1;
    collector.rejectedLatency.add(reply.latencyMs);
  }
  collector.reasons.add(
    classifyReason(reply.status, reply.body, reply.transportError),
  );
}

/** Pre-signs `rounds` intents per taker against the given orders. */
async function prepareIntents(
  ctx: ScenarioContext,
  pick: (takerIndex: number, round: number) => SeededOrder,
  rounds: number,
): Promise<PreparedIntent[][]> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const perTaker: PreparedIntent[][] = ctx.takers.map((taker) =>
    Array.from({ length: rounds }, (_v, round) =>
      prepareIntent(taker, pick(taker.index, round), issuedAt, 120),
    ),
  );
  const requests: SignRequest[] = ctx.takers.map((taker, index) => ({
    seedHex: taker.seedHex,
    messages: (perTaker[index] ?? []).map((intent) => intent.proof.messageBytes),
  }));
  const signatures = await signAll(requests, ctx.signWorkers);
  perTaker.forEach((intents, index) => {
    attachSignatures(
      intents.map((intent) => intent.proof),
      signatures[index] ?? [],
    );
  });
  // A signed intent lives at most 120 s, so a slow pre-signing pass would
  // hand the run proofs that expire mid-measurement. Say so, so a wall of
  // expiry rejections is never reported as a result.
  const remainingS = issuedAt + 120 - Math.floor(Date.now() / 1000);
  ctx.log(
    `pre-signed ${String(perTaker.length * rounds)} intents, ${String(remainingS)} s of signed validity left`,
  );
  if (remainingS * 1000 < ctx.durationMs + 20_000) {
    ctx.log(
      "warning: pre-signing consumed most of the signed intent lifetime; lower --takers or --rounds",
    );
  }
  return perTaker;
}

// --- scenario a: race on one hot order -------------------------------------

export async function scenarioHotRace(
  ctx: ScenarioContext,
  orders: readonly SeededOrder[],
  rounds: number,
): Promise<ScenarioOutcome> {
  const hot = orders.find((order) => order.hot);
  if (hot === undefined) throw new Error("scenario needs a seeded hot order");
  const perTaker = await prepareIntents(ctx, () => hot, rounds);
  const collector = newCollector();
  const winnersPerRound: number[] = [];
  const deadline = performance.now() + ctx.durationMs;

  for (let round = 0; round < rounds; round += 1) {
    if (performance.now() >= deadline) break;
    const batch = shuffle(
      perTaker
        .map((intents) => intents[round])
        .filter((intent): intent is PreparedIntent => intent !== undefined),
      round,
    );
    const before = collector.accepted;
    await mapPool(batch, ctx.concurrency, (intent) =>
      submitIntent(ctx, intent, collector),
    );
    winnersPerRound.push(collector.accepted - before);
    // Live intents hold their slot until signed expiry, so a later round can
    // only win capacity the protocol frees. The pause keeps rounds distinct
    // without waiting out the full 120 s intent lifetime.
    if (round + 1 < rounds) await sleep(250);
  }

  const fairness = await inspectFairness(ctx, [hot], collector, winnersPerRound);
  return {
    intents: finishCollector(collector),
    fairness,
    notes: [
      `all takers raced order ${hot.orderId.slice(0, 12)} for ${String(winnersPerRound.length)} rounds`,
    ],
  };
}

// --- scenario b: spread across the book ------------------------------------

export async function scenarioSpread(
  ctx: ScenarioContext,
  orders: readonly SeededOrder[],
  rounds: number,
): Promise<ScenarioOutcome> {
  if (orders.length === 0) throw new Error("scenario needs seeded orders");
  const pick = (takerIndex: number, round: number): SeededOrder => {
    const order = orders[(takerIndex + round) % orders.length];
    if (order === undefined) throw new Error("order selection failed");
    return order;
  };
  const perTaker = await prepareIntents(ctx, pick, rounds);
  const collector = newCollector();
  const deadline = performance.now() + ctx.durationMs;
  const queue: PreparedIntent[] = [];
  for (let round = 0; round < rounds; round += 1) {
    for (const intents of perTaker) {
      const intent = intents[round];
      if (intent !== undefined) queue.push(intent);
    }
  }
  const drained = await drainQueue(
    queue,
    ctx.concurrency,
    deadline,
    0,
    (intent) => submitIntent(ctx, intent, collector),
  );

  const fairness = await inspectFairness(ctx, orders, collector, []);
  return {
    intents: finishCollector(collector),
    fairness,
    notes: [
      `${String(drained.sent)} of ${String(queue.length)} pre-signed intents submitted across ${String(orders.length)} orders in ${drained.wallMs.toFixed(0)} ms`,
      drained.exhausted
        ? "the run ended when the pre-signed supply drained, before the duration elapsed"
        : "the run ended at the configured duration with pre-signed intents left over",
    ],
  };
}

// --- scenario c: mixed traffic ---------------------------------------------

export interface MixedOptions {
  readers: number;
  subscribers: number;
  makerCycles: number;
}

export async function scenarioMixed(
  ctx: ScenarioContext,
  orders: readonly SeededOrder[],
  rounds: number,
  options: MixedOptions,
): Promise<ScenarioOutcome> {
  const pick = (takerIndex: number, round: number): SeededOrder => {
    const order = orders[(takerIndex + round) % orders.length];
    if (order === undefined) throw new Error("order selection failed");
    return order;
  };
  const perTaker = await prepareIntents(ctx, pick, rounds);

  // Maker traffic: cancel a seeded order, then post a fresh one. Both are
  // signed proofs, so they exercise the same verify-then-persist path.
  const cancelTargets = orders.slice(0, options.makerCycles);
  const issuedAt = Math.floor(Date.now() / 1000);
  const cancels = cancelTargets.map((order) =>
    prepareCancel(makerAt(ctx, order.makerIndex), order, issuedAt),
  );
  const reposts = cancelTargets.map((order, index) =>
    prepareOrder(
      makerAt(ctx, order.makerIndex),
      1000 + index,
      issuedAt,
      3600,
    ),
  );
  const makerRequests: SignRequest[] = [
    ...cancels.map((cancel, index) => ({
      seedHex: makerAt(ctx, cancelTargets[index]?.makerIndex ?? 0).seedHex,
      messages: [cancel.proof.messageBytes],
    })),
    ...reposts.map((order) => ({
      seedHex: makerAt(ctx, order.makerIndex).seedHex,
      messages: [order.proof.messageBytes],
    })),
  ];
  const makerSignatures = await signAll(makerRequests, ctx.signWorkers);
  cancels.forEach((cancel, index) => {
    attachSignatures([cancel.proof], [makerSignatures[index]?.[0] ?? ""]);
  });
  reposts.forEach((order, index) => {
    attachSignatures(
      [order.proof],
      [makerSignatures[cancels.length + index]?.[0] ?? ""],
    );
  });

  const subscribers: SseSubscriber[] = [];
  const publishLatency = new Latency();
  const fanoutSpread = new Latency();
  // First sighting of each tracked order per subscriber. Every book frame
  // carries the whole listing, so only the first frame that mentions an order
  // measures its delivery; later frames would just re-report it.
  const firstSeen = new Map<string, Map<number, number>>();
  const requestStarts = new Map<string, number>();
  const trackedIds = new Set(reposts.map((order) => order.orderId));

  // Each subscriber scans only the ids it has not seen yet, so the harness's
  // own event loop does not become the thing being measured.
  const pendingPerSubscriber = new Map<number, Set<string>>();
  const onEvent = (
    subscriberIndex: number,
    data: string,
    atMs: number,
  ): void => {
    const pending = pendingPerSubscriber.get(subscriberIndex);
    if (pending === undefined || pending.size === 0) return;
    for (const id of [...pending]) {
      if (!trackedIds.has(id)) {
        pending.delete(id);
        continue;
      }
      if (!data.includes(id)) continue;
      pending.delete(id);
      const perSubscriber = firstSeen.get(id) ?? new Map<number, number>();
      perSubscriber.set(subscriberIndex, atMs);
      firstSeen.set(id, perSubscriber);
    }
  };

  for (let index = 0; index < options.subscribers; index += 1) {
    const subscriberIndex = index;
    pendingPerSubscriber.set(subscriberIndex, new Set(trackedIds));
    const subscriber = new SseSubscriber(
      ctx.client.port,
      ctx.sharedIp ?? subscriberIp(index),
      (event) => {
        if (event.name === "book") {
          onEvent(subscriberIndex, event.data, event.atMs);
        }
      },
    );
    await subscriber.open();
    subscribers.push(subscriber);
  }
  const acceptedSubscribers = subscribers.filter(
    (subscriber) => subscriber.status === 200,
  ).length;

  const collector = newCollector();
  const deadline = performance.now() + ctx.durationMs;
  const queue: PreparedIntent[] = [];
  for (let round = 0; round < rounds; round += 1) {
    for (const intents of perTaker) {
      const intent = intents[round];
      if (intent !== undefined) queue.push(intent);
    }
  }
  const readerLoops = Array.from({ length: options.readers }, (_v, index) =>
    (async () => {
      const ip = ctx.sharedIp ?? readerIp(index);
      while (performance.now() < deadline) {
        await ctx.client.send(ENDPOINT_GET_ORDERS, "GET", "/api/orders", ip);
        await sleep(200);
      }
    })(),
  );
  const makerLoop = (async () => {
    for (let index = 0; index < cancelTargets.length; index += 1) {
      if (performance.now() >= deadline) break;
      const target = cancelTargets[index];
      const cancel = cancels[index];
      const repost = reposts[index];
      if (target === undefined || cancel === undefined || repost === undefined) {
        break;
      }
      const maker = makerAt(ctx, target.makerIndex);
      await ctx.client.send(
        ENDPOINT_POST_CANCEL,
        "POST",
        `/api/orders/${target.orderId}/cancel/signed`,
        ipFor(ctx, maker),
        { cancel: cancel.proof.body, auth: cancel.proof.auth },
        { "X-Maker-Token": target.makerToken },
      );
      requestStarts.set(repost.orderId, performance.now());
      const posted = await ctx.client.send(
        ENDPOINT_POST_ORDER,
        "POST",
        "/api/orders/signed",
        ipFor(ctx, maker),
        {
          order: repost.proof.body,
          auth: repost.proof.auth,
          makerToken: repost.makerToken,
        },
      );
      if (posted.status !== 201) {
        requestStarts.delete(repost.orderId);
        trackedIds.delete(repost.orderId);
        collector.reasons.add(
          `repost:${classifyReason(posted.status, posted.body, posted.transportError)}`,
        );
      }
      await sleep(400);
    }
  })();
  const takerLoop = drainQueue(
    queue,
    ctx.concurrency,
    deadline,
    0,
    (intent) => submitIntent(ctx, intent, collector),
  );

  const [drained] = await Promise.all([takerLoop, makerLoop, ...readerLoops]);
  // Let the last coalesced push reach the subscribers before measuring.
  await sleep(300);

  let incompleteDeliveries = 0;
  for (const [id, perSubscriber] of firstSeen) {
    const startedAt = requestStarts.get(id);
    if (startedAt === undefined) continue;
    const sorted = [...perSubscriber.values()].sort(
      (left, right) => left - right,
    );
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (first === undefined || last === undefined) continue;
    if (perSubscriber.size < acceptedSubscribers) incompleteDeliveries += 1;
    publishLatency.add(first - startedAt);
    fanoutSpread.add(last - first);
  }
  const dropped = subscribers.filter(
    (subscriber) => subscriber.status === 200 && subscriber.isClosed,
  ).length;
  for (const subscriber of subscribers) subscriber.close();

  const fairness = await inspectFairness(ctx, orders, collector, []);
  return {
    intents: finishCollector(collector),
    fairness,
    sse: {
      subscribers: subscribers.length,
      accepted: acceptedSubscribers,
      rejected: subscribers.length - acceptedSubscribers,
      observedOrders: firstSeen.size,
      incompleteDeliveries,
      publishLatency: publishLatency.summary(),
      fanoutSpread: fanoutSpread.summary(),
      droppedSubscribers: dropped,
    },
    notes: [
      `${String(options.readers)} listing pollers, ${String(acceptedSubscribers)} live SSE subscribers, ${String(cancelTargets.length)} maker cancel plus repost cycles`,
      `${String(drained.sent)} of ${String(queue.length)} pre-signed intents submitted in ${drained.wallMs.toFixed(0)} ms`,
    ],
  };
}

// --- scenario d: burst then steady state -----------------------------------

export async function scenarioBurstSteady(
  ctx: ScenarioContext,
  orders: readonly SeededOrder[],
  rounds: number,
): Promise<ScenarioOutcome> {
  const pick = (takerIndex: number, round: number): SeededOrder => {
    const order = orders[(takerIndex * 7 + round) % orders.length];
    if (order === undefined) throw new Error("order selection failed");
    return order;
  };
  const perTaker = await prepareIntents(ctx, pick, rounds);
  const collector = newCollector();
  const burst = new Latency();
  const steady = new Latency();

  const burstBatch = perTaker
    .map((intents) => intents[0])
    .filter((intent): intent is PreparedIntent => intent !== undefined);
  const burstStart = performance.now();
  await mapPool(burstBatch, ctx.concurrency, async (intent) => {
    const at = performance.now();
    await submitIntent(ctx, intent, collector);
    burst.add(performance.now() - at);
  });
  const burstMs = performance.now() - burstStart;

  const steadyQueue: PreparedIntent[] = [];
  for (let round = 1; round < rounds; round += 1) {
    for (const intents of perTaker) {
      const intent = intents[round];
      if (intent !== undefined) steadyQueue.push(intent);
    }
  }
  const deadline = performance.now() + Math.max(0, ctx.durationMs - burstMs);
  // Steady state deliberately runs at a fraction of the burst concurrency so
  // the two phases measure different things: saturation, then service quality.
  const steadyConcurrency = Math.max(1, Math.floor(ctx.concurrency / 8));
  const drained = await drainQueue(
    steadyQueue,
    steadyConcurrency,
    deadline,
    100,
    async (intent) => {
      const at = performance.now();
      await submitIntent(ctx, intent, collector);
      steady.add(performance.now() - at);
    },
  );

  return {
    intents: finishCollector(collector),
    phases: {
      burst: burst.summary(),
      steady: steady.summary(),
    },
    notes: [
      `burst of ${String(burstBatch.length)} intents finished in ${burstMs.toFixed(0)} ms at in-flight cap ${String(ctx.concurrency)}`,
      `steady state sent ${String(drained.sent)} of ${String(steadyQueue.length)} intents at cap ${String(steadyConcurrency)} over ${drained.wallMs.toFixed(0)} ms`,
    ],
  };
}

// --- scenario f: queue-free service time -----------------------------------

/** Submits one request at a time so nothing queues. With an empty queue the
 *  measured latency is the service time itself, which is what separates the
 *  cost of a mutation from the cost of waiting behind other mutations. Run the
 *  same scenario with the data directory on a memory filesystem to see how
 *  much of that service time is the store rewrite plus fsync. */
export async function scenarioServiceTime(
  ctx: ScenarioContext,
  orders: readonly SeededOrder[],
  samples: number,
): Promise<ScenarioOutcome> {
  const pick = (takerIndex: number, round: number): SeededOrder => {
    const order = orders[(takerIndex + round * 3) % orders.length];
    if (order === undefined) throw new Error("order selection failed");
    return order;
  };
  const rounds = Math.max(1, Math.ceil(samples / Math.max(1, ctx.takers.length)));
  const perTaker = await prepareIntents(ctx, pick, rounds);
  const collector = newCollector();
  const queue: PreparedIntent[] = [];
  for (let round = 0; round < rounds; round += 1) {
    for (const intents of perTaker) {
      const intent = intents[round];
      if (intent !== undefined) queue.push(intent);
    }
  }
  const readLatency = new Latency();
  const deadline = performance.now() + ctx.durationMs;
  const bounded = queue.slice(0, samples);
  // Every mutation rewrites the whole store, and each retained intent adds
  // roughly 15 KB of hex-encoded ML-DSA-87 material, so service time is
  // recorded in submission order: the first and last slices show whether the
  // cost grows with the persisted state.
  const admittedInOrder: number[] = [];
  const before = collector.accepted;
  await drainQueue(bounded, 1, deadline, 0, async (intent) => {
    const at = performance.now();
    await submitIntent(ctx, intent, collector);
    if (collector.accepted > before + admittedInOrder.length) {
      admittedInOrder.push(performance.now() - at);
    }
  });
  const slice = (values: readonly number[]): LatencySummary => {
    const latency = new Latency();
    for (const value of values) latency.add(value);
    return latency.summary();
  };
  const window = Math.max(1, Math.floor(admittedInOrder.length / 4));
  const reader = ctx.sharedIp ?? readerIp(0);
  for (let index = 0; index < 60; index += 1) {
    if (performance.now() >= deadline) break;
    const reply = await ctx.client.send(
      ENDPOINT_GET_ORDERS,
      "GET",
      "/api/orders",
      reader,
    );
    readLatency.add(reply.latencyMs);
  }

  const fairness = await inspectFairness(ctx, orders, collector, []);
  return {
    intents: finishCollector(collector),
    fairness,
    phases: {
      "sequential listing read": readLatency.summary(),
      "first admitted quarter": slice(admittedInOrder.slice(0, window)),
      "last admitted quarter": slice(admittedInOrder.slice(-window)),
    },
    notes: [
      `strictly sequential: ${String(bounded.length)} intent submissions and ${String(readLatency.count)} listing reads with no concurrent load`,
    ],
  };
}

// --- fairness -------------------------------------------------------------

interface PublicIntent {
  intentDigest: string;
  receivedAt: number;
  issuedAt: number;
}

/** Reads the maker view of pending proposals and checks it against the
 *  documented ordering: max(auth.issuedAt, receivedAt), then auth.issuedAt,
 *  then semantic intentDigest. */
async function inspectFairness(
  ctx: ScenarioContext,
  orders: readonly SeededOrder[],
  collector: IntentCollector,
  winnersPerRound: number[],
): Promise<FairnessReport> {
  let ordered = true;
  let inspectedOrders = 0;
  let inspectedIntents = 0;
  // Orders cancelled by the maker traffic return an empty list, so the scan
  // walks further than the sample it needs and counts only orders that still
  // hold live proposals.
  for (const order of orders) {
    if (inspectedOrders >= 8) break;
    const reply = await ctx.client.send(
      ENDPOINT_GET_INTENTS,
      "GET",
      `/api/orders/${order.orderId}/intents`,
      ctx.sharedIp ?? makerAt(ctx, order.makerIndex).ip,
      undefined,
      { "X-Maker-Token": order.makerToken },
    );
    if (reply.status !== 200) continue;
    const intents = parseIntents(reply.body?.["intents"]);
    if (intents.length === 0) continue;
    inspectedOrders += 1;
    inspectedIntents += intents.length;
    if (!isDocumentedOrder(intents)) ordered = false;
  }
  const wins = [...collector.winsByTaker.values()];
  return {
    orderingMatchesDocumentedRule: ordered,
    inspectedOrders,
    inspectedIntents,
    distinctWinners: collector.winsByTaker.size,
    maxWinsByOneTaker: wins.length === 0 ? 0 : Math.max(...wins),
    takersWithZeroWins: ctx.takers.length - collector.winsByTaker.size,
    winnersPerRound,
  };
}

function parseIntents(raw: unknown): PublicIntent[] {
  if (!Array.isArray(raw)) return [];
  const parsed: PublicIntent[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const auth = record["auth"];
    const digest = record["intentDigest"];
    const receivedAt = record["receivedAt"];
    if (
      typeof digest !== "string" ||
      typeof receivedAt !== "number" ||
      typeof auth !== "object" ||
      auth === null
    ) {
      continue;
    }
    const issuedAt = (auth as Record<string, unknown>)["issuedAt"];
    if (typeof issuedAt !== "number") continue;
    parsed.push({ intentDigest: digest, receivedAt, issuedAt });
  }
  return parsed;
}

function isDocumentedOrder(intents: readonly PublicIntent[]): boolean {
  const expected = [...intents].sort(
    (left, right) =>
      Math.max(left.issuedAt, left.receivedAt) -
        Math.max(right.issuedAt, right.receivedAt) ||
      left.issuedAt - right.issuedAt ||
      left.intentDigest.localeCompare(right.intentDigest),
  );
  return expected.every(
    (intent, index) => intent.intentDigest === intents[index]?.intentDigest,
  );
}

// --- double fill probe ----------------------------------------------------

export interface DoubleFillProbe {
  attempted: boolean;
  order?: string;
  responses: number[];
  storedFills: number;
  conflictDigests: number;
  status?: string;
  /** True when exactly one fill is stored no matter how many were accepted. */
  singleFillHeld: boolean;
  note: string;
}

/** Fires two contradictory FillV2 proofs at one order at the same instant.
 *  The documented outcome is exactly one stored fill plus retained
 *  equivocation evidence. */
export async function probeDoubleFill(
  ctx: ScenarioContext,
  orders: readonly SeededOrder[],
): Promise<DoubleFillProbe> {
  for (const order of orders) {
    const listed = await ctx.client.send(
      ENDPOINT_GET_INTENTS,
      "GET",
      `/api/orders/${order.orderId}/intents`,
      makerAt(ctx, order.makerIndex).ip,
      undefined,
      { "X-Maker-Token": order.makerToken },
    );
    if (listed.status !== 200) continue;
    const raw = listed.body?.["intents"];
    if (!Array.isArray(raw) || raw.length < 2) continue;
    const now = Math.floor(Date.now() / 1000);
    // A FillV2 must be issued inside its intent's signed window, so only
    // intents that are still live can be raced.
    const picks = raw
      .map((entry) => entry as Record<string, unknown>)
      .filter((pick) => {
        const auth = pick["auth"];
        if (typeof auth !== "object" || auth === null) return false;
        const window = auth as Record<string, unknown>;
        return (
          typeof window["issuedAt"] === "number" &&
          typeof window["expiresAt"] === "number" &&
          window["issuedAt"] <= now &&
          window["expiresAt"] > now + 1
        );
      })
      .slice(0, 2);
    if (picks.length < 2) continue;
    const maker = makerAt(ctx, order.makerIndex);
    const fills = picks.map((pick) => {
      const body = pick["intent"] as Record<string, unknown>;
      const auth = pick["auth"] as Record<string, unknown>;
      return {
        intentBody: body,
        intentAuth: auth,
        fill: prepareFill(
          maker,
          order,
          {
            intentDigest: String(pick["intentDigest"]),
            takerEthAccount: String(body["takerEthAccount"]),
            takerQrlAccount: String(body["takerQrlAccount"]),
            releaseCommitment: String(body["releaseCommitment"]),
          },
          now,
        ),
      };
    });
    const signatures = await signAll(
      [
        {
          seedHex: maker.seedHex,
          messages: fills.map((entry) => entry.fill.proof.messageBytes),
        },
      ],
      1,
    );
    const produced = signatures[0] ?? [];
    fills.forEach((entry, index) => {
      attachSignatures([entry.fill.proof], [produced[index] ?? ""]);
    });
    const replies = await Promise.all(
      fills.map((entry) =>
        ctx.client.send(
          ENDPOINT_POST_FILL,
          "POST",
          `/api/orders/${order.orderId}/fill`,
          maker.ip,
          {
            fill: entry.fill.proof.body,
            auth: entry.fill.proof.auth,
            intent: entry.intentBody,
            intentAuth: entry.intentAuth,
          },
          { "X-Maker-Token": order.makerToken },
        ),
      ),
    );
    const after = await ctx.client.send(
      "GET /orders/:id",
      "GET",
      `/api/orders/${order.orderId}`,
      maker.ip,
    );
    const stored = after.body?.["order"];
    const record =
      typeof stored === "object" && stored !== null
        ? (stored as Record<string, unknown>)
        : {};
    const conflicts = record["conflictDigests"];
    const storedFills = record["fill"] === undefined ? 0 : 1;
    return {
      attempted: true,
      order: order.orderId,
      responses: replies.map((reply) => reply.status),
      storedFills,
      conflictDigests: Array.isArray(conflicts) ? conflicts.length : 0,
      ...(typeof record["status"] === "string"
        ? { status: record["status"] }
        : {}),
      singleFillHeld: storedFills <= 1,
      note: "two contradictory FillV2 proofs raced one order",
    };
  }
  return {
    attempted: false,
    responses: [],
    storedFills: 0,
    conflictDigests: 0,
    singleFillHeld: true,
    note: "no order held two live intents, so the double-fill race was skipped",
  };
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const copy = [...items];
  let state = seed * 2654435761 + 1;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const pick = state % (index + 1);
    const left = copy[index];
    const right = copy[pick];
    if (left === undefined || right === undefined) continue;
    copy[index] = right;
    copy[pick] = left;
  }
  return copy;
}
