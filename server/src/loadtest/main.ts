import { isRecord, isArray } from "../guards.js";
// Entry point for `npm run loadtest`. Starts a real order-book process per
// scenario against a throwaway data directory, drives synthetic makers,
// takers, readers and stream subscribers over loopback, then verifies the
// invariants and writes a JSON result beside a readable summary.
//
// Usage: npm run loadtest -- --takers 100 --duration 20 --scenarios a,b,c,d,e,f
// The harness lowers its own scheduling priority, so it shares a workstation
// without making it unresponsive.
//
// Three phases per scenario, each with its own metrics sink: preparation signs
// every proof and seeds the book, the measured window sends what was prepared,
// and the audit verifies the invariants. Only the measured window feeds the
// reported latency, throughput and book CPU figures.

import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, setPriority, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readProcessCpu, sleep, startBook, type Book } from "./book.js";
import { BookClient } from "./client.js";
import {
  compareRows,
  feedOrderIds,
  intentCounts,
  ordersWithFillEvents,
  readBook,
  readFeed,
  type ConsistencyReport,
} from "./consistency.js";
import { loadIdentities, MAX_MAKERS, MAX_TAKERS } from "./identity.js";
import { EndpointMetrics, Latency } from "./metrics.js";
import { formatRun, type RunResult, type ScenarioReport } from "./report.js";
import { defaultWorkerCount } from "./sign-pool.js";
import { AUDIT_IP, PROBE_IP, SHARED_IP } from "./addresses.js";
import {
  prepareWorkload,
  probeDoubleFill,
  scenarioBurstSteady,
  scenarioHotRace,
  scenarioMixed,
  scenarioServiceTime,
  scenarioSharedSource,
  scenarioSpread,
  seedOrders,
  type ScenarioContext,
  type ScenarioKey,
  type ScenarioOutcome,
  type SeededOrder,
} from "./scenarios.js";

interface Options {
  takers: number;
  makers: number;
  orders: number;
  hotOrders: number;
  rounds: number;
  durationMs: number;
  concurrency: number;
  signWorkers: number;
  niceness: number;
  scenarios: ScenarioKey[];
  runDir: string | undefined;
  out: string | undefined;
  basePort: number;
}

const SCENARIO_KEYS = ["a", "b", "c", "d", "e", "f"] as const;

function isScenarioKey(value: string): value is ScenarioKey {
  return SCENARIO_KEYS.some((key) => key === value);
}

const SCENARIO_NAMES: Record<ScenarioKey, string> = {
  a: "a: takers race one hot order",
  b: "b: takers spread across the book",
  c: "c: mixed takers, makers, listing pollers and stream subscribers",
  d: "d: burst then steady state",
  e: "e: every client behind one shared source address",
  f: "f: queue-free service time baseline",
};

const SCENARIO_DESCRIPTIONS: Record<ScenarioKey, string> = {
  a: "Every synthetic taker submits a signed FillIntentV2 for the same order at the same moment, repeatedly.",
  b: "Takers are spread over all seeded orders, each round rotating to the next order.",
  c: "Takers submit proposals while makers cancel and repost, readers poll the listing and subscribers hold the SSE stream.",
  d: "One saturating burst of proposals, then a slower steady state at a fraction of the burst concurrency.",
  e: "The spread workload again with one forwarded source address for every client, to show the per-source budgets.",
  f: "One request at a time, so measured latency is pure service time with no queueing. Compare a disk-backed run with a memory-filesystem run to size the persistence cost.",
};

const SERVICE_TIME_SAMPLES = 120;
const MIXED_READERS = 8;
const MIXED_SUBSCRIBERS = 20;

const VALUE_FLAGS = [
  "takers",
  "makers",
  "orders",
  "hot",
  "rounds",
  "duration",
  "concurrency",
  "sign-workers",
  "niceness",
  "scenarios",
  "run-dir",
  "out",
  "base-port",
] as const;

function parseOptions(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument "${token}"`);
    }
    const name = token.slice(2);
    const inline = name.indexOf("=");
    if (inline !== -1) {
      flags.set(name.slice(0, inline), name.slice(inline + 1));
      continue;
    }
    if (!VALUE_FLAGS.some((flag) => flag === name)) {
      throw new Error(`unknown flag --${name}`);
    }
    // Every supported flag takes a value. A bare flag used to fall back to the
    // string "true", which produced a run directory literally called "true".
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${name} requires a value`);
    }
    flags.set(name, value);
    index += 1;
  }
  for (const name of flags.keys()) {
    if (!VALUE_FLAGS.some((flag) => flag === name)) {
      throw new Error(`unknown flag --${name}`);
    }
  }
  const number = (name: string, fallback: number): number => {
    const raw = flags.get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`--${name} must be a positive number`);
    }
    return Math.floor(value);
  };
  const takers = number("takers", 50);
  const makers = number("makers", 8);
  if (takers > MAX_TAKERS) {
    throw new Error(
      `--takers cannot exceed ${String(MAX_TAKERS)}, the addressable documentation hosts`,
    );
  }
  if (makers > MAX_MAKERS) {
    throw new Error(
      `--makers cannot exceed ${String(MAX_MAKERS)}, the addressable documentation hosts`,
    );
  }
  const requested = flags.get("scenarios") ?? SCENARIO_KEYS.join(",");
  const scenarios = requested
    .split(",")
    .map((key) => key.trim().toLowerCase())
    .filter((key) => key.length > 0)
    .map((key) => {
      if (!isScenarioKey(key))
        throw new Error(`unknown scenario "${key}"; pick from a,b,c,d,e,f`);
      return key;
    });
  return {
    takers,
    makers,
    orders: number("orders", 24),
    hotOrders: number("hot", 2),
    rounds: number("rounds", 6),
    durationMs: number("duration", 20) * 1000,
    concurrency: number("concurrency", 64),
    signWorkers: number("sign-workers", defaultWorkerCount()),
    niceness: number("niceness", 15),
    scenarios,
    runDir: flags.get("run-dir"),
    out: flags.get("out"),
    basePort: number("base-port", 18800),
  };
}

export interface ProbeSummary {
  health: Latency;
  drift: Latency;
  samples: number;
  missedTicks: number;
  nonOkReplies: number;
}

interface Probe {
  stop: () => Promise<ProbeSummary>;
}

/** Samples the book's cheapest endpoint on a fixed grid from a separate
 *  process. Round-trip time there is the externally visible cost of the
 *  book's event loop being busy. Samples stream out one line at a time, so
 *  stopping the probe never discards what it already measured. */
function startProbe(port: number, intervalMs: number, niceness: number): Probe {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./probe-worker.js", import.meta.url)),
      String(port),
      String(intervalMs),
      PROBE_IP,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  if (child.pid !== undefined) {
    try {
      setPriority(child.pid, niceness);
    } catch {
      // Best effort, as with the book process.
    }
  }
  const health = new Latency();
  const drift = new Latency();
  let samples = 0;
  let missedTicks = 0;
  let nonOkReplies = 0;
  let pending = "";
  const consume = (chunk: string): void => {
    pending += chunk;
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
      if (line.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed)) continue;
        const record = parsed;
        if (typeof record["latencyMs"] === "number") {
          health.add(record["latencyMs"]);
        }
        if (typeof record["driftMs"] === "number") {
          drift.add(record["driftMs"]);
        }
        if (typeof record["missedTicks"] === "number") {
          missedTicks += record["missedTicks"];
        }
        // A status of 0 means the probe's own 10 s client timeout fired, which
        // is the book failing to answer its cheapest endpoint at all.
        if (record["status"] !== 200) nonOkReplies += 1;
        samples += 1;
      } catch {
        // A truncated final line is dropped; every earlier sample is kept.
      }
    }
  };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    consume(chunk);
  });
  const finished = new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
  });
  return {
    stop: async () => {
      child.kill("SIGTERM");
      // The probe only has one in-flight request to finish, but the book may
      // be slow to answer it, so the grace period covers the request timeout
      // before a forced kill.
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      await finished;
      clearTimeout(timer);
      return { health, drift, samples, missedTicks, nonOkReplies };
    },
  };
}

interface BookLifecycle {
  port: number;
  dataFile: string;
  federationDataFile: string;
  niceness: number;
  log: string[];
}

async function auditScenario(
  client: BookClient,
  orders: readonly SeededOrder[],
  admittedIntents: number,
  /** Highest live proposal count seen before the double-fill probe closed an
   *  order, so the ceiling check reads the state the load actually produced. */
  maxLiveIntentsOnOneOrder: number,
  book: Book,
  bookOptions: BookLifecycle,
): Promise<ConsistencyReport> {
  const rowsBefore = await readBook(client);
  const feed = await readFeed(client);
  const logIds = feedOrderIds(feed.logEvents);
  const snapshotIds = feedOrderIds(feed.snapshotEvents);
  const missingFromLog = rowsBefore
    .filter((row) => !logIds.has(row.id))
    .map((row) => row.id);
  const missingFromSnapshot = rowsBefore
    .filter((row) => !snapshotIds.has(row.id))
    .map((row) => row.id);

  // An equivocated order emits two fill-v2 events by design, so the store is
  // the only authority on how many fills it kept. Each order that saw a fill
  // event is fetched and must expose exactly one fill body and one digest.
  const filledOrders = new Set([
    ...ordersWithFillEvents(feed.logEvents),
    ...ordersWithFillEvents(feed.snapshotEvents),
  ]);
  const multipleStoredFills: string[] = [];
  for (const orderId of filledOrders) {
    const reply = await client.send(
      "GET /orders/:id",
      "GET",
      `/api/orders/${orderId}`,
      AUDIT_IP,
    );
    const order = reply.body?.["order"];
    if (!isRecord(order)) continue;
    const record = order;
    const fill = record["fill"];
    const digest = record["fillDigest"];
    const storedFills = isRecord(fill) ? 1 : 0;
    if (storedFills !== 1 || typeof digest !== "string") {
      multipleStoredFills.push(orderId);
    }
  }

  const intentsBefore = await intentCounts(client, orders);

  await book.stop();
  const reopened = await startBook(bookOptions);
  const rowsAfter = await readBook(client);
  const intentsAfter = await intentCounts(client, orders);
  await reopened.stop();

  const differences = compareRows(rowsBefore, rowsAfter);
  const intentCountsIdentical =
    JSON.stringify(intentsBefore) === JSON.stringify(intentsAfter);

  return {
    bookRows: rowsBefore.length,
    feed: feed.totals,
    admittedIntents,
    intentLogEventsMatchAdmitted:
      feed.totals.logReadFromStart &&
      feed.totals.logIntentEvents === admittedIntents,
    ordersMissingFromLog: missingFromLog,
    ordersMissingFromSnapshot: missingFromSnapshot,
    ordersWithMultipleStoredFills: multipleStoredFills,
    maxLiveIntentsOnOneOrder,
    restart: {
      performed: true,
      reloadedRows: rowsAfter.length,
      rowsIdentical: differences.length === 0,
      intentCountsIdentical,
      differences,
    },
  };
}

function readStorage(
  dataFile: string,
  federationDataFile: string,
): { dataFileBytes: number; feedFileBytes: number; retainedIntents: number } {
  const size = (path: string): number => {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  };
  let retainedIntents = 0;
  try {
    const parsed: unknown = JSON.parse(readFileSync(dataFile, "utf8"));
    if (isArray(parsed)) {
      for (const entry of parsed) {
        if (!isRecord(entry)) continue;
        const intents = entry["fillIntents"];
        if (isArray(intents)) retainedIntents += intents.length;
      }
    }
  } catch {
    // A missing or unreadable file reports zero and the run continues.
  }
  return {
    dataFileBytes: size(dataFile),
    feedFileBytes: size(federationDataFile),
    retainedIntents,
  };
}

async function runMeasuredBody(
  key: ScenarioKey,
  ctx: ScenarioContext,
  orders: readonly SeededOrder[],
  plan: Awaited<ReturnType<typeof prepareWorkload>>,
): Promise<ScenarioOutcome> {
  switch (key) {
    case "a":
      return scenarioHotRace(ctx, plan);
    case "c":
      return scenarioMixed(ctx, orders, plan, {
        readers: MIXED_READERS,
        subscribers: MIXED_SUBSCRIBERS,
      });
    case "d":
      return scenarioBurstSteady(ctx, orders, plan);
    case "e":
      return scenarioSharedSource(ctx, orders, plan);
    case "f":
      return scenarioServiceTime(ctx, orders, plan, SERVICE_TIME_SAMPLES);
    default:
      return scenarioSpread(ctx, orders, plan);
  }
}

async function runScenario(
  key: ScenarioKey,
  options: Options,
  runDir: string,
  port: number,
  identities: ReturnType<typeof loadIdentities>,
): Promise<ScenarioReport> {
  const scenarioDir = join(runDir, `scenario-${key}`);
  mkdirSync(scenarioDir, { recursive: true, mode: 0o700 });
  const log: string[] = [];
  const bookOptions: BookLifecycle = {
    port,
    dataFile: join(scenarioDir, "orders.json"),
    federationDataFile: join(scenarioDir, "orders.json.federation"),
    niceness: options.niceness,
    log,
  };
  const prepareMetrics = new EndpointMetrics();
  const measureMetrics = new EndpointMetrics();
  const auditMetrics = new EndpointMetrics();
  const client = new BookClient({
    port,
    metrics: prepareMetrics,
    maxSockets: options.concurrency + 8,
    requestTimeoutMs: 30_000,
  });
  const book = await startBook(bookOptions);
  const context: ScenarioContext = {
    client,
    makers: identities.makers,
    takers: identities.takers,
    concurrency: options.concurrency,
    durationMs: options.durationMs,
    signWorkers: options.signWorkers,
    ...(key === "e" ? { sharedIp: SHARED_IP } : {}),
    log: (message) => log.push(`harness: ${message}`),
  };

  let orders: SeededOrder[] = [];
  let outcome: ScenarioOutcome = { capChecks: [], notes: [] };
  let wallMs = 0;
  let prepareMs = 0;
  let signatures = 0;
  let signedValidityRemainingS = 0;
  let probeSummary: ProbeSummary | undefined;
  // Held in a box so the cleanup in `finally` still sees it after the happy
  // path has cleared it.
  const probeRef: { current: Probe | undefined } = { current: undefined };
  let measuredEndpoints = measureMetrics.report(0);
  let usage: ScenarioReport["bookProcess"];

  try {
    // Phase one: preparation. Seeding and every ML-DSA-87 signature happen
    // here, outside the measured window and before the probe starts.
    orders = await seedOrders(context, options.orders, options.hotOrders, 3600);
    if (orders.length === 0) throw new Error("no orders were seeded");
    log.push(`harness: seeded ${String(orders.length)} signed public orders`);
    const plan = await prepareWorkload(context, key, orders, {
      rounds: options.rounds,
      serviceSamples: SERVICE_TIME_SAMPLES,
      makerCycles: Math.min(12, orders.length),
    });
    prepareMs = plan.prepareMs;
    signatures = plan.signatures;
    signedValidityRemainingS = plan.signedValidityRemainingS;

    // Phase two: the measured window. Nothing is signed and nothing is seeded
    // from here until wallMs is taken.
    client.useMetrics(measureMetrics);
    const running = startProbe(port, 100, options.niceness);
    probeRef.current = running;
    const cpuBefore = readProcessCpu(book.pid);
    const startedAt = performance.now();
    outcome = await runMeasuredBody(key, context, orders, plan);
    wallMs = performance.now() - startedAt;
    const cpuAfter = readProcessCpu(book.pid);
    measuredEndpoints = measureMetrics.report(wallMs);
    probeSummary = await running.stop();
    probeRef.current = undefined;
    if (cpuBefore !== undefined && cpuAfter !== undefined) {
      const busyMs =
        cpuAfter.userMs -
        cpuBefore.userMs +
        (cpuAfter.systemMs - cpuBefore.systemMs);
      usage = {
        userMs: cpuAfter.userMs - cpuBefore.userMs,
        systemMs: cpuAfter.systemMs - cpuBefore.systemMs,
        rssBytes: cpuAfter.rssBytes,
        wallMs,
        cpuPercentOfOneCore: wallMs === 0 ? 0 : (busyMs / wallMs) * 100,
      };
    }
  } finally {
    // A throw inside the measured block must not leave the book or the probe
    // running, or the next scenario silently measures an orphan.
    const orphan = probeRef.current;
    if (orphan !== undefined) {
      probeSummary = await orphan.stop();
      probeRef.current = undefined;
    }
    if (book.exited) log.push("harness: book process exited during the run");
  }

  // Phase three: the audit. Its traffic lands in its own metrics sink.
  client.useMetrics(auditMetrics);
  let doubleFill;
  let consistency;
  try {
    // The live-proposal ceiling is read first: the double-fill probe moves an
    // order to locking, which empties its proposal list.
    const liveBefore = await intentCounts(client, orders);
    const maxLive = Object.values(liveBefore).reduce(
      (highest, count) => Math.max(highest, count),
      0,
    );
    doubleFill = await probeDoubleFill(context, orders);
    consistency = await auditScenario(
      client,
      orders,
      outcome.intents?.admitted ?? 0,
      maxLive,
      book,
      bookOptions,
    );
  } finally {
    await book.stop();
    client.destroy();
  }

  return {
    name: SCENARIO_NAMES[key],
    description: SCENARIO_DESCRIPTIONS[key],
    sharedSourceAddress: key === "e",
    wallMs,
    preparation: {
      prepareMs,
      signatures,
      signedValidityRemainingS,
      endpoints: prepareMetrics.report(prepareMs),
    },
    endpoints: measuredEndpoints,
    auditEndpoints: auditMetrics.report(0),
    throughput: {
      intentsSubmittedPerSecond:
        wallMs <= 0
          ? 0
          : Math.round(
              ((outcome.intents?.submitted ?? 0) / wallMs) * 1000 * 10,
            ) / 10,
      intentsAdmittedPerSecond:
        wallMs <= 0
          ? 0
          : Math.round(
              ((outcome.intents?.admitted ?? 0) / wallMs) * 1000 * 10,
            ) / 10,
    },
    ...(outcome.intents === undefined ? {} : { intents: outcome.intents }),
    ...(outcome.fairness === undefined ? {} : { fairness: outcome.fairness }),
    ...(outcome.sse === undefined ? {} : { sse: outcome.sse }),
    ...(outcome.phases === undefined ? {} : { phases: outcome.phases }),
    capChecks: outcome.capChecks,
    ...(probeSummary === undefined
      ? {}
      : {
          healthProbe: {
            latency: probeSummary.health.summary(),
            drift: probeSummary.drift.summary(),
            samples: probeSummary.samples,
            missedTicks: probeSummary.missedTicks,
            nonOkReplies: probeSummary.nonOkReplies,
          },
        }),
    ...(usage === undefined ? {} : { bookProcess: usage }),
    storage: readStorage(bookOptions.dataFile, bookOptions.federationDataFile),
    consistency:
      consistency ??
      (() => {
        throw new Error("the audit did not complete");
      })(),
    doubleFill:
      doubleFill ??
      (() => {
        throw new Error("the double-fill probe did not complete");
      })(),
    notes: outcome.notes,
    bookLogTail: log.slice(-12),
  };
}

/** Every failed cap assertion and every failed invariant, as one list. */
function failures(scenarios: readonly ScenarioReport[]): string[] {
  const found: string[] = [];
  for (const scenario of scenarios) {
    const label = scenario.name.slice(0, 1);
    for (const check of scenario.capChecks) {
      if (check.ok) continue;
      found.push(
        `scenario ${label}: ${check.name} expected ${check.expected} by ${check.rule} and observed ${String(check.observed)}`,
      );
    }
    const consistency = scenario.consistency;
    if (!consistency.restart.rowsIdentical) {
      found.push(`scenario ${label}: the restart reloaded different rows`);
    }
    if (!consistency.restart.intentCountsIdentical) {
      found.push(
        `scenario ${label}: retained proposal counts changed across the restart`,
      );
    }
    if (!consistency.intentLogEventsMatchAdmitted) {
      found.push(
        `scenario ${label}: ${String(consistency.feed.logIntentEvents)} fill-intent log events against ${String(consistency.admittedIntents)} admitted proposals (log read from start: ${String(consistency.feed.logReadFromStart)})`,
      );
    }
    if (consistency.ordersMissingFromLog.length > 0) {
      found.push(
        `scenario ${label}: ${String(consistency.ordersMissingFromLog.length)} open rows missing from the append-only log`,
      );
    }
    if (consistency.ordersMissingFromSnapshot.length > 0) {
      found.push(
        `scenario ${label}: ${String(consistency.ordersMissingFromSnapshot.length)} open rows missing from the reset snapshot`,
      );
    }
    if (consistency.ordersWithMultipleStoredFills.length > 0) {
      found.push(
        `scenario ${label}: ${String(consistency.ordersWithMultipleStoredFills.length)} orders did not hold exactly one stored fill`,
      );
    }
    if (consistency.maxLiveIntentsOnOneOrder > 8) {
      found.push(
        `scenario ${label}: one order held ${String(consistency.maxLiveIntentsOnOneOrder)} live proposals against the documented ceiling of 8`,
      );
    }
    if (
      scenario.doubleFill.attempted &&
      !scenario.doubleFill.exactlyOneFillSelected
    ) {
      found.push(
        `scenario ${label}: the double-fill race did not leave exactly one selected fill with the loser retained`,
      );
    }
    if (
      scenario.intents !== undefined &&
      scenario.intents.transportErrors > 0
    ) {
      found.push(
        `scenario ${label}: ${String(scenario.intents.transportErrors)} transport errors`,
      );
    }
  }
  return found;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  try {
    setPriority(0, options.niceness);
  } catch {
    process.stderr.write(
      "warning: could not lower harness scheduling priority\n",
    );
  }
  const runDir =
    options.runDir ?? mkdtempSync(join(tmpdir(), "quantaswap-loadtest-"));
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const identities = loadIdentities(
    join(runDir, "identities.json"),
    options.makers,
    options.takers,
  );
  process.stdout.write(
    `run directory ${runDir} (kept after the run; delete it yourself)\nidentities ${identities.fromCache ? "reused from cache" : `derived in ${String(identities.derivationMs)} ms`}\n`,
  );

  const scenarios: ScenarioReport[] = [];
  for (const [index, key] of options.scenarios.entries()) {
    process.stdout.write(`running scenario ${key} ...\n`);
    scenarios.push(
      await runScenario(
        key,
        options,
        runDir,
        options.basePort + index,
        identities,
      ),
    );
    // One scenario at a time, with a pause so the machine is never left with
    // two books and two client pools competing for the same cores.
    await sleep(1000);
  }

  const cpuModel = cpus()[0]?.model ?? "unknown";
  const found = failures(scenarios);
  const result: RunResult = {
    schemaVersion: 2,
    startedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      cpuModel,
      cpuCores: cpus().length,
      memoryGiB: totalmem() / 1024 ** 3,
      niceness: options.niceness,
    },
    config: {
      takers: options.takers,
      makers: options.makers,
      orders: options.orders,
      hotOrders: options.hotOrders,
      rounds: options.rounds,
      durationMs: options.durationMs,
      concurrency: options.concurrency,
      signWorkers: options.signWorkers,
      scenarios: options.scenarios,
      runDir,
    },
    identityDerivationMs: identities.derivationMs,
    scenarios,
    failures: found,
  };
  const outFile =
    options.out ?? join(runDir, `result-takers-${String(options.takers)}.json`);
  writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(`\n${formatRun(result)}\n\nJSON result: ${outFile}\n`);
  if (found.length > 0) {
    process.stderr.write(
      `\n${String(found.length)} assertion failures:\n${found.map((line) => `  ${line}`).join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}

await main();
