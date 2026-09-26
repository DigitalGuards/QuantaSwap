// Load scenarios for the order book. Each one runs against a freshly started
// book with its own data directory, so per-source daily caps and retained
// state from an earlier scenario never bleed into the next measurement.
//
// Every scenario is two phases. `prepareWorkload` signs all the proofs the run
// will send, which costs tens of milliseconds per ML-DSA-87 signature and must
// never land inside the measured window. The run function then sends what was
// prepared and nothing else.

import { Latency, Tally, type LatencySummary } from "./metrics.js";
import { BookClient, SseSubscriber } from "./client.js";
import { readerIp, subscriberIp } from "./addresses.js";
import { classifyReason, isPreVerificationShed } from "./reasons.js";
import { drainQueue, mapPool } from "./pool.js";
import { sleep } from "./book.js";
import type { Identity } from "./identity.js";
import {
  attachSignatures,
  prepareCancel,
  prepareFill,
  prepareIntent,
  prepareOrder,
  type PreparedCancel,
  type PreparedIntent,
  type PreparedOrder,
} from "./proofs.js";
import { signAll, type SignRequest } from "./sign-pool.js";

export const ENDPOINT_POST_ORDER = "POST /orders/signed";
export const ENDPOINT_POST_INTENT = "POST /orders/:id/intents";
export const ENDPOINT_GET_INTENTS = "GET /orders/:id/intents";
export const ENDPOINT_GET_ORDER = "GET /orders/:id";
export const ENDPOINT_GET_ORDERS = "GET /orders";
export const ENDPOINT_POST_CANCEL = "POST /orders/:id/cancel/signed";
export const ENDPOINT_POST_FILL = "POST /orders/:id/fill";

/** Documented admission ceilings, mirrored here so the harness can assert
 *  against them and fail loudly when a policy number regresses. */
export const DOCUMENTED_LIVE_INTENTS_PER_ORDER = 8;
export const DOCUMENTED_CONCURRENT_TAKES_PER_SOURCE = 4;
/** Signed fill-intent lifetime ceiling from the wire protocol. */
export const SIGNED_INTENT_LIFETIME_S = 120;

export type ScenarioKey = "a" | "b" | "c" | "d" | "e" | "f";

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
  admitted: number;
  refused: number;
  transportErrors: number;
  reasons: Record<string, number>;
  admittedDigests: string[];
  /** Admitted proposals pay signature verification plus a whole-store rewrite
   *  and fsync. */
  admittedLatency: LatencySummary;
  /** Refused after verification: the proof was verified and then the
   *  admission caps rejected it, with no persistence. */
  refusedAfterVerifyLatency: LatencySummary;
  /** Shed by the per-source HTTP limiter before any verification happens. */
  shedBeforeVerifyLatency: LatencySummary;
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
  /** Order creations the harness asked the subscribers to watch for. */
  trackedOrders: number;
  /** Tracked orders at least one subscriber saw. */
  observedOrders: number;
  /** Tracked orders that failed to reach every accepted subscriber,
   *  including the ones no subscriber saw at all. */
  incompleteDeliveries: number;
  publishLatency: LatencySummary;
  fanoutSpread: LatencySummary;
  droppedSubscribers: number;
}

/** One assertion against a documented admission ceiling. */
export interface CapCheck {
  name: string;
  rule: string;
  expected: string;
  observed: number;
  ok: boolean;
}

export interface ScenarioOutcome {
  intents?: IntentOutcome;
  fairness?: FairnessReport;
  sse?: SseReport;
  phases?: Record<string, LatencySummary>;
  capChecks: CapCheck[];
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
 *  rows every taker will fight over. Runs before the measured window. */
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

// --- preparation -----------------------------------------------------------

export interface MakerCycle {
  target: SeededOrder;
  cancel: PreparedCancel;
  repost: PreparedOrder;
}

export interface PreparedWorkload {
  rounds: number;
  /** Pre-signed proposals, indexed by taker then round. */
  perTaker: PreparedIntent[][];
  /** The order every taker races in the hot-order scenario. */
  hot: SeededOrder;
  /** Cancel plus repost pairs driving the maker traffic in the mixed run. */
  makerCycles: MakerCycle[];
  /** A second proposal per taker aimed at the same order as its first, used
   *  by the sequential scenario to time a refusal that still pays full
   *  signature verification. Empty for every other scenario. */
  refusalPass: PreparedIntent[];
  /** Seconds of signed proposal validity left when preparation finished. */
  signedValidityRemainingS: number;
  prepareMs: number;
  signatures: number;
}

type OrderPicker = (takerIndex: number, round: number) => SeededOrder;

function pickerFor(
  key: ScenarioKey,
  orders: readonly SeededOrder[],
  hot: SeededOrder,
): OrderPicker {
  const at = (index: number): SeededOrder => {
    const order = orders[index % orders.length];
    if (order === undefined) throw new Error("order selection failed");
    return order;
  };
  switch (key) {
    case "a":
      return () => hot;
    case "d":
      return (takerIndex, round) => at(takerIndex * 7 + round);
    case "f":
      return (takerIndex, round) => at(takerIndex + round * 3);
    default:
      return (takerIndex, round) => at(takerIndex + round);
  }
}

function roundsFor(
  key: ScenarioKey,
  rounds: number,
  takers: number,
  serviceSamples: number,
): number {
  if (key !== "f") return rounds;
  return Math.max(1, Math.ceil(serviceSamples / Math.max(1, takers)));
}

/** Signs every proof a scenario will send. Nothing here is measured. */
export async function prepareWorkload(
  ctx: ScenarioContext,
  key: ScenarioKey,
  orders: readonly SeededOrder[],
  options: { rounds: number; serviceSamples: number; makerCycles: number },
): Promise<PreparedWorkload> {
  if (orders.length === 0) throw new Error("preparation needs seeded orders");
  const hot = orders.find((order) => order.hot) ?? orders[0];
  if (hot === undefined) throw new Error("preparation needs a hot order");
  const startedAt = performance.now();
  const rounds = roundsFor(
    key,
    options.rounds,
    ctx.takers.length,
    options.serviceSamples,
  );
  const pick = pickerFor(key, orders, hot);
  const issuedAt = Math.floor(Date.now() / 1000);
  const perTaker: PreparedIntent[][] = ctx.takers.map((taker) =>
    Array.from({ length: rounds }, (_v, round) =>
      prepareIntent(
        taker,
        pick(taker.index, round),
        issuedAt,
        SIGNED_INTENT_LIFETIME_S,
      ),
    ),
  );

  // The sequential scenario also needs proposals that are certain to be
  // refused after verification: a second proposal from the same taker for the
  // same order, which the one-pending-proposal-per-account rule rejects once
  // the first is admitted.
  const refusalPass: PreparedIntent[] =
    key === "f"
      ? ctx.takers.map((taker) =>
          prepareIntent(
            taker,
            pick(taker.index, 0),
            issuedAt,
            SIGNED_INTENT_LIFETIME_S,
          ),
        )
      : [];

  const cycleTargets = key === "c" ? orders.slice(0, options.makerCycles) : [];
  const cancels = cycleTargets.map((order) =>
    prepareCancel(makerAt(ctx, order.makerIndex), order, issuedAt),
  );
  const reposts = cycleTargets.map((order, index) =>
    prepareOrder(makerAt(ctx, order.makerIndex), 1000 + index, issuedAt, 3600),
  );

  const requests: SignRequest[] = [
    ...ctx.takers.map((taker, index) => ({
      seedHex: taker.seedHex,
      messages: [
        ...(perTaker[index] ?? []).map((intent) => intent.proof.messageBytes),
        ...(refusalPass[index] === undefined
          ? []
          : [refusalPass[index].proof.messageBytes]),
      ],
    })),
    ...cancels.map((cancel, index) => ({
      seedHex: makerAt(ctx, cycleTargets[index]?.makerIndex ?? 0).seedHex,
      messages: [cancel.proof.messageBytes],
    })),
    ...reposts.map((order) => ({
      seedHex: makerAt(ctx, order.makerIndex).seedHex,
      messages: [order.proof.messageBytes],
    })),
  ];
  const signatures = await signAll(requests, ctx.signWorkers);
  perTaker.forEach((intents, index) => {
    const produced = signatures[index] ?? [];
    attachSignatures(
      intents.map((intent) => intent.proof),
      produced.slice(0, intents.length),
    );
    const refusal = refusalPass[index];
    if (refusal !== undefined) {
      attachSignatures([refusal.proof], produced.slice(intents.length));
    }
  });
  const takerCount = ctx.takers.length;
  cancels.forEach((cancel, index) => {
    attachSignatures(
      [cancel.proof],
      [signatures[takerCount + index]?.[0] ?? ""],
    );
  });
  reposts.forEach((order, index) => {
    attachSignatures(
      [order.proof],
      [signatures[takerCount + cancels.length + index]?.[0] ?? ""],
    );
  });

  const makerCycles: MakerCycle[] = cycleTargets.flatMap((target, index) => {
    const cancel = cancels[index];
    const repost = reposts[index];
    if (cancel === undefined || repost === undefined) return [];
    return [{ target, cancel, repost }];
  });

  const signedValidityRemainingS =
    issuedAt + SIGNED_INTENT_LIFETIME_S - Math.floor(Date.now() / 1000);
  const total = requests.reduce(
    (count, request) => count + request.messages.length,
    0,
  );
  ctx.log(
    `prepared ${String(total)} signatures in ${(performance.now() - startedAt).toFixed(0)} ms, ${String(signedValidityRemainingS)} s of signed proposal validity left`,
  );
  if (signedValidityRemainingS * 1000 < ctx.durationMs + 20_000) {
    ctx.log(
      "warning: preparation consumed most of the signed proposal lifetime; lower --takers or --rounds",
    );
  }
  return {
    rounds,
    perTaker,
    hot,
    makerCycles,
    refusalPass,
    signedValidityRemainingS,
    prepareMs: performance.now() - startedAt,
    signatures: total,
  };
}

// --- intent submission -----------------------------------------------------

interface IntentCollector {
  submitted: number;
  admitted: number;
  refused: number;
  transportErrors: number;
  reasons: Tally;
  admittedDigests: string[];
  winsByTaker: Map<number, number>;
  admittedLatency: Latency;
  refusedAfterVerifyLatency: Latency;
  shedBeforeVerifyLatency: Latency;
}

function newCollector(): IntentCollector {
  return {
    submitted: 0,
    admitted: 0,
    refused: 0,
    transportErrors: 0,
    reasons: new Tally(),
    admittedDigests: [],
    winsByTaker: new Map(),
    admittedLatency: new Latency(),
    refusedAfterVerifyLatency: new Latency(),
    shedBeforeVerifyLatency: new Latency(),
  };
}

function finishCollector(collector: IntentCollector): IntentOutcome {
  return {
    submitted: collector.submitted,
    admitted: collector.admitted,
    refused: collector.refused,
    transportErrors: collector.transportErrors,
    reasons: collector.reasons.toObject(),
    admittedDigests: collector.admittedDigests,
    admittedLatency: collector.admittedLatency.summary(),
    refusedAfterVerifyLatency: collector.refusedAfterVerifyLatency.summary(),
    shedBeforeVerifyLatency: collector.shedBeforeVerifyLatency.summary(),
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
    collector.admitted += 1;
    collector.admittedLatency.add(reply.latencyMs);
    collector.winsByTaker.set(
      intent.takerIndex,
      (collector.winsByTaker.get(intent.takerIndex) ?? 0) + 1,
    );
    const returned = reply.body?.["intent"];
    const digest =
      typeof returned === "object" && returned !== null
        ? (returned as Record<string, unknown>)["intentDigest"]
        : undefined;
    if (typeof digest === "string") collector.admittedDigests.push(digest);
    return;
  }
  if (reply.transportError !== undefined) {
    collector.transportErrors += 1;
    collector.reasons.add(`transport:${reply.transportError}`);
    return;
  }
  collector.refused += 1;
  const reason = classifyReason(reply.status, reply.body);
  collector.reasons.add(reason);
  // The per-source HTTP limiter answers before the router reaches signature
  // verification, so those replies cost the book almost nothing. Keeping them
  // in their own bucket stops them from flattering the verified-and-refused
  // figure.
  if (isPreVerificationShed(reason)) {
    collector.shedBeforeVerifyLatency.add(reply.latencyMs);
  } else {
    collector.refusedAfterVerifyLatency.add(reply.latencyMs);
  }
}

function flatQueue(
  perTaker: readonly PreparedIntent[][],
  rounds: number,
): PreparedIntent[] {
  const queue: PreparedIntent[] = [];
  for (let round = 0; round < rounds; round += 1) {
    for (const intents of perTaker) {
      const intent = intents[round];
      if (intent !== undefined) queue.push(intent);
    }
  }
  return queue;
}

// --- cap assertions --------------------------------------------------------

function capCheck(
  name: string,
  rule: string,
  observed: number,
  predicate: (value: number) => boolean,
  expected: string,
): CapCheck {
  return { name, rule, expected, observed, ok: predicate(observed) };
}

function hotOrderCapChecks(takers: number, admitted: number): CapCheck[] {
  const expected = Math.min(takers, DOCUMENTED_LIVE_INTENTS_PER_ORDER);
  return [
    capCheck(
      "hot order admissions",
      "MAX_FILL_INTENTS_PER_ORDER",
      admitted,
      (value) => value === expected,
      `exactly ${String(expected)}`,
    ),
  ];
}

function spreadCapChecks(
  takers: number,
  orderCount: number,
  admitted: number,
): CapCheck[] {
  const perOrderCeiling = DOCUMENTED_LIVE_INTENTS_PER_ORDER * orderCount;
  const perSourceCeiling = DOCUMENTED_CONCURRENT_TAKES_PER_SOURCE * takers;
  return [
    capCheck(
      "admissions against the per-order ceiling",
      "MAX_FILL_INTENTS_PER_ORDER x seeded orders",
      admitted,
      (value) => value <= perOrderCeiling,
      `at most ${String(perOrderCeiling)}`,
    ),
    capCheck(
      "admissions against the per-source ceiling",
      "MAX_CONCURRENT_TAKES_PER_IP x takers",
      admitted,
      (value) => value <= perSourceCeiling,
      `at most ${String(perSourceCeiling)}`,
    ),
  ];
}

function sharedSourceCapChecks(takers: number, admitted: number): CapCheck[] {
  const expected = Math.min(takers, DOCUMENTED_CONCURRENT_TAKES_PER_SOURCE);
  return [
    capCheck(
      "shared source admissions",
      "MAX_CONCURRENT_TAKES_PER_IP",
      admitted,
      (value) => value === expected,
      `exactly ${String(expected)}`,
    ),
  ];
}

// --- scenario a: race on one hot order -------------------------------------

export async function scenarioHotRace(
  ctx: ScenarioContext,
  plan: PreparedWorkload,
): Promise<ScenarioOutcome> {
  const hot = plan.hot;
  const collector = newCollector();
  const winnersPerRound: number[] = [];
  const deadline = performance.now() + ctx.durationMs;

  for (let round = 0; round < plan.rounds; round += 1) {
    if (performance.now() >= deadline) break;
    const batch = shuffle(
      plan.perTaker
        .map((intents) => intents[round])
        .filter((intent): intent is PreparedIntent => intent !== undefined),
      round,
    );
    const before = collector.admitted;
    await mapPool(batch, ctx.concurrency, (intent) =>
      submitIntent(ctx, intent, collector),
    );
    winnersPerRound.push(collector.admitted - before);
    // Live proposals hold their slot until signed expiry, so a later round can
    // only win capacity the protocol frees. The pause keeps rounds distinct
    // without waiting out the full signed lifetime.
    if (round + 1 < plan.rounds) await sleep(250);
  }

  const fairness = await inspectFairness(ctx, [hot], collector, winnersPerRound);
  return {
    intents: finishCollector(collector),
    fairness,
    capChecks: hotOrderCapChecks(ctx.takers.length, collector.admitted),
    notes: [
      `all takers raced order ${hot.orderId.slice(0, 12)} for ${String(winnersPerRound.length)} rounds`,
    ],
  };
}

// --- scenario b: spread across the book ------------------------------------

export async function scenarioSpread(
  ctx: ScenarioContext,
  orders: readonly SeededOrder[],
  plan: PreparedWorkload,
): Promise<ScenarioOutcome> {
  const collector = newCollector();
  const deadline = performance.now() + ctx.durationMs;
  const queue = flatQueue(plan.perTaker, plan.rounds);
  const drained = await drainQueue(queue, ctx.concurrency, deadline, 0, (intent) =>
    submitIntent(ctx, intent, collector),
  );

  const fairness = await inspectFairness(ctx, orders, collector, []);
  return {
    intents: finishCollector(collector),
    fairness,
    capChecks: spreadCapChecks(
      ctx.takers.length,
      orders.length,
      collector.admitted,
    ),
    notes: [
      `${String(drained.sent)} of ${String(queue.length)} pre-signed proposals submitted across ${String(orders.length)} orders in ${drained.wallMs.toFixed(0)} ms`,
      drained.exhausted
        ? "the run ended when the pre-signed supply drained, before the duration elapsed"
        : "the run ended at the configured duration with pre-signed proposals left over",
    ],
  };
}

// --- scenario c: mixed traffic ---------------------------------------------

export interface MixedOptions {
  readers: number;
  subscribers: number;
}

export async function scenarioMixed(
  ctx: ScenarioContext,
  orders: readonly SeededOrder[],
  plan: PreparedWorkload,
  options: MixedOptions,
): Promise<ScenarioOutcome> {
  const subscribers: SseSubscriber[] = [];
  const publishLatency = new Latency();
  const fanoutSpread = new Latency();
  // First sighting of each tracked order per subscriber. Every book frame
  // carries the whole listing, so only the first frame that mentions an order
  // measures its delivery; later frames would just re-report it.
  const firstSeen = new Map<string, Map<number, number>>();
  const requestStarts = new Map<string, number>();
  const trackedIds = new Set(plan.makerCycles.map((cycle) => cycle.repost.orderId));

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
  const queue = flatQueue(plan.perTaker, plan.rounds);
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
    for (const cycle of plan.makerCycles) {
      if (performance.now() >= deadline) break;
      const maker = makerAt(ctx, cycle.target.makerIndex);
      await ctx.client.send(
        ENDPOINT_POST_CANCEL,
        "POST",
        `/api/orders/${cycle.target.orderId}/cancel/signed`,
        ipFor(ctx, maker),
        { cancel: cycle.cancel.proof.body, auth: cycle.cancel.proof.auth },
        { "X-Maker-Token": cycle.target.makerToken },
      );
      requestStarts.set(cycle.repost.orderId, performance.now());
      const posted = await ctx.client.send(
        ENDPOINT_POST_ORDER,
        "POST",
        "/api/orders/signed",
        ipFor(ctx, maker),
        {
          order: cycle.repost.proof.body,
          auth: cycle.repost.proof.auth,
          makerToken: cycle.repost.makerToken,
        },
      );
      if (posted.status !== 201) {
        requestStarts.delete(cycle.repost.orderId);
        trackedIds.delete(cycle.repost.orderId);
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

  // A frame that reached nobody has no entry in firstSeen, so completeness is
  // counted over every id still tracked, including the invisible ones.
  let incompleteDeliveries = 0;
  let observedOrders = 0;
  for (const id of trackedIds) {
    if (requestStarts.get(id) === undefined) continue;
    const perSubscriber = firstSeen.get(id);
    if (perSubscriber === undefined || perSubscriber.size === 0) {
      incompleteDeliveries += 1;
      continue;
    }
    observedOrders += 1;
    if (perSubscriber.size < acceptedSubscribers) incompleteDeliveries += 1;
    const sorted = [...perSubscriber.values()].sort(
      (left, right) => left - right,
    );
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const startedAt = requestStarts.get(id);
    if (first === undefined || last === undefined || startedAt === undefined) {
      continue;
    }
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
      trackedOrders: [...trackedIds].filter(
        (id) => requestStarts.get(id) !== undefined,
      ).length,
      observedOrders,
      incompleteDeliveries,
      publishLatency: publishLatency.summary(),
      fanoutSpread: fanoutSpread.summary(),
      droppedSubscribers: dropped,
    },
    capChecks: spreadCapChecks(
      ctx.takers.length,
      orders.length,
      collector.admitted,
    ),
    notes: [
      `${String(options.readers)} listing pollers, ${String(acceptedSubscribers)} live SSE subscribers, ${String(plan.makerCycles.length)} maker cancel plus repost cycles`,
      `${String(drained.sent)} of ${String(queue.length)} pre-signed proposals submitted in ${drained.wallMs.toFixed(0)} ms`,
    ],
  };
}

// --- scenario d: burst then steady state -----------------------------------

export async function scenarioBurstSteady(
  ctx: ScenarioContext,
  orders: readonly SeededOrder[],
  plan: PreparedWorkload,
): Promise<ScenarioOutcome> {
  const collector = newCollector();
  const burst = new Latency();
  const steady = new Latency();

  const burstBatch = plan.perTaker
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
  for (let round = 1; round < plan.rounds; round += 1) {
    for (const intents of plan.perTaker) {
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
    capChecks: spreadCapChecks(
      ctx.takers.length,
      orders.length,
      collector.admitted,
    ),
    notes: [
      `burst of ${String(burstBatch.length)} proposals finished in ${burstMs.toFixed(0)} ms at in-flight cap ${String(ctx.concurrency)}`,
      `steady state sent ${String(drained.sent)} of ${String(steadyQueue.length)} proposals at cap ${String(steadyConcurrency)} over ${drained.wallMs.toFixed(0)} ms`,
    ],
  };
}

// --- scenario e: one shared source address ---------------------------------

export async function scenarioSharedSource(
  ctx: ScenarioContext,
  orders: readonly SeededOrder[],
  plan: PreparedWorkload,
): Promise<ScenarioOutcome> {
  const outcome = await scenarioSpread(ctx, orders, plan);
  return {
    ...outcome,
    capChecks: sharedSourceCapChecks(
      ctx.takers.length,
      outcome.intents?.admitted ?? 0,
    ),
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
  plan: PreparedWorkload,
  samples: number,
): Promise<ScenarioOutcome> {
  const collector = newCollector();
  const readLatency = new Latency();
  const deadline = performance.now() + ctx.durationMs;
  const bounded = flatQueue(plan.perTaker, plan.rounds).slice(0, samples);
  // Every mutation rewrites the whole store, and each retained proposal adds
  // roughly 15 KB of hex-encoded ML-DSA-87 material, so service time is
  // recorded in submission order: the first and last slices show whether the
  // cost grows with the persisted state.
  const admittedInOrder: number[] = [];
  const before = collector.admitted;
  await drainQueue(bounded, 1, deadline, 0, async (intent) => {
    const at = performance.now();
    await submitIntent(ctx, intent, collector);
    if (collector.admitted > before + admittedInOrder.length) {
      admittedInOrder.push(performance.now() - at);
    }
  });
  const slice = (values: readonly number[]): LatencySummary => {
    const latency = new Latency();
    for (const value of values) latency.add(value);
    return latency.summary();
  };
  const window = Math.max(1, Math.floor(admittedInOrder.length / 4));

  // Second sequential pass: the same taker proposes for the same order again,
  // which the one-pending-proposal-per-account rule refuses only after full
  // signature verification. With no queue that latency is the verification
  // cost on its own, so the gap to the admitted figure is the price of
  // persistence.
  const refusedInOrder: number[] = [];
  const refusalPass = plan.refusalPass.slice(0, samples);
  await drainQueue(refusalPass, 1, deadline, 0, async (intent) => {
    const seen = collector.refusedAfterVerifyLatency.count;
    const at = performance.now();
    await submitIntent(ctx, intent, collector);
    if (collector.refusedAfterVerifyLatency.count > seen) {
      refusedInOrder.push(performance.now() - at);
    }
  });

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
      "sequential admitted": slice(admittedInOrder),
      "sequential refused after verify": slice(refusedInOrder),
      "sequential listing read": readLatency.summary(),
      "first admitted quarter": slice(admittedInOrder.slice(0, window)),
      "last admitted quarter": slice(admittedInOrder.slice(-window)),
    },
    capChecks: spreadCapChecks(
      ctx.takers.length,
      orders.length,
      collector.admitted,
    ),
    notes: [
      `strictly sequential: ${String(bounded.length)} admitted-path submissions, ${String(refusalPass.length)} refused-path submissions and ${String(readLatency.count)} listing reads, all with no concurrent load`,
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
  /** Semantic digests of the two proofs the harness raced. */
  racedDigests: string[];
  /** The fill digest the store kept, from the served order row. */
  storedFillDigest?: string;
  /** Conflict digests the order retained as equivocation evidence. */
  retainedConflicts: string[];
  status?: string;
  /** True when the store kept exactly one of the two raced proofs, that proof
   *  is one the harness sent, and the losing proof is retained as conflict
   *  evidence. Anything else means two fills were accepted or the loser was
   *  dropped. */
  exactlyOneFillSelected: boolean;
  note: string;
}

/** Fires two contradictory FillV2 proofs at one order at the same instant.
 *  The documented outcome is exactly one stored fill plus the losing proof
 *  retained as equivocation evidence.
 *
 *  Maker traffic always uses the per-maker forwarded address, including in the
 *  shared-source scenario, because this probe verifies terminal-state
 *  correctness and must not be refused by the shared source's mutation budget. */
export async function probeDoubleFill(
  ctx: ScenarioContext,
  orders: readonly SeededOrder[],
): Promise<DoubleFillProbe> {
  for (const order of orders) {
    const maker = makerAt(ctx, order.makerIndex);
    const listed = await ctx.client.send(
      ENDPOINT_GET_INTENTS,
      "GET",
      `/api/orders/${order.orderId}/intents`,
      maker.ip,
      undefined,
      { "X-Maker-Token": order.makerToken },
    );
    if (listed.status !== 200) continue;
    const raw = listed.body?.["intents"];
    if (!Array.isArray(raw) || raw.length < 2) continue;
    const now = Math.floor(Date.now() / 1000);
    // A FillV2 must be issued inside its proposal's signed window, so only
    // proposals that are still live can be raced.
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
    const racedDigests = fills.map((entry) => entry.fill.fillDigest);
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
      ENDPOINT_GET_ORDER,
      "GET",
      `/api/orders/${order.orderId}`,
      maker.ip,
    );
    const stored = after.body?.["order"];
    const record =
      typeof stored === "object" && stored !== null
        ? (stored as Record<string, unknown>)
        : {};
    const storedFillDigest =
      typeof record["fillDigest"] === "string"
        ? record["fillDigest"]
        : undefined;
    const rawConflicts = record["conflictDigests"];
    const retainedConflicts = Array.isArray(rawConflicts)
      ? rawConflicts.filter((value): value is string => typeof value === "string")
      : [];
    const winners = racedDigests.filter(
      (digest) => digest === storedFillDigest,
    );
    const losers = racedDigests.filter((digest) => digest !== storedFillDigest);
    const exactlyOneFillSelected =
      storedFillDigest !== undefined &&
      winners.length === 1 &&
      losers.every((digest) => retainedConflicts.includes(digest));
    return {
      attempted: true,
      order: order.orderId,
      responses: replies.map((reply) => reply.status),
      racedDigests,
      ...(storedFillDigest === undefined ? {} : { storedFillDigest }),
      retainedConflicts,
      ...(typeof record["status"] === "string"
        ? { status: record["status"] }
        : {}),
      exactlyOneFillSelected,
      note: "two contradictory FillV2 proofs raced one order",
    };
  }
  return {
    attempted: false,
    responses: [],
    racedDigests: [],
    retainedConflicts: [],
    exactlyOneFillSelected: false,
    note: "no order held two live proposals, so the double-fill race was skipped",
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
