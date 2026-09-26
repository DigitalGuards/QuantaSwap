// Entry point for `npm run loadtest`. Starts a real order-book process per
// scenario against a throwaway data directory, drives synthetic makers,
// takers, readers and stream subscribers over loopback, then verifies the
// invariants and writes a JSON result beside a readable summary.
//
// Usage: npm run loadtest -- --takers 100 --duration 20 --scenarios a,b,c,d,e
// The harness lowers its own scheduling priority, so it shares a workstation
// without making it unresponsive.

import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cpus, setPriority, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  readProcessCpu,
  sleep,
  startBook,
  waitForHealth,
  type Book,
} from "./book.js";
import { BookClient } from "./client.js";
import {
  compareRows,
  feedOrderIds,
  fillsPerOrder,
  intentCounts,
  readBook,
  readFeed,
  type ConsistencyReport,
} from "./consistency.js";
import { loadIdentities } from "./identity.js";
import { EndpointMetrics, Latency } from "./metrics.js";
import { formatRun, type RunResult, type ScenarioReport } from "./report.js";
import { defaultWorkerCount } from "./sign-pool.js";
import { AUDIT_IP, PROBE_IP, SHARED_IP } from "./addresses.js";
import {
  probeDoubleFill,
  scenarioBurstSteady,
  scenarioHotRace,
  scenarioMixed,
  scenarioServiceTime,
  scenarioSpread,
  seedOrders,
  type ScenarioContext,
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
  scenarios: string[];
  runDir: string | undefined;
  out: string | undefined;
  basePort: number;
}

const SCENARIO_KEYS = ["a", "b", "c", "d", "e", "f"] as const;
type ScenarioKey = (typeof SCENARIO_KEYS)[number];

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
  c: "Takers submit intents while makers cancel and repost, readers poll the listing and subscribers hold the SSE stream.",
  d: "One saturating burst of intents, then a slower steady state at a fraction of the burst concurrency.",
  e: "The spread workload again with one forwarded source address for every client, to show the per-source budgets.",
  f: "One request at a time, so measured latency is pure service time with no queueing. Compare a disk-backed run with a memory-filesystem run to size the persistence cost.",
};

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
    if (!VALUE_FLAGS.includes(name as (typeof VALUE_FLAGS)[number])) {
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
    if (!VALUE_FLAGS.includes(name as (typeof VALUE_FLAGS)[number])) {
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
  const requested = flags.get("scenarios") ?? SCENARIO_KEYS.join(",");
  const scenarios = requested
    .split(",")
    .map((key) => key.trim().toLowerCase())
    .filter((key) => key.length > 0);
  for (const key of scenarios) {
    if (!SCENARIO_KEYS.includes(key as ScenarioKey)) {
      throw new Error(`unknown scenario "${key}"; pick from a,b,c,d,e,f`);
    }
  }
  return {
    takers,
    makers: number("makers", 8),
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

interface Probe {
  stop: () => Promise<{ health: Latency; drift: Latency }>;
}

/** Samples the book's cheapest endpoint on a fixed interval from a separate
 *  process. Round-trip time there is the externally visible cost of the
 *  book's event loop being busy, and the probe's own timer drift shows
 *  whether the measurement itself was starved. */
function startProbe(port: number, intervalMs: number, niceness: number): Probe {
  const child = spawn(
    process.execPath,
    [
      new URL("./probe-worker.js", import.meta.url).pathname,
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
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const finished = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  return {
    stop: async () => {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await finished;
      clearTimeout(timer);
      const health = new Latency();
      const drift = new Latency();
      try {
        const parsed: unknown = JSON.parse(output.trim() || "{}");
        const samples =
          typeof parsed === "object" && parsed !== null
            ? (parsed as { samples?: unknown }).samples
            : undefined;
        if (Array.isArray(samples)) {
          for (const sample of samples) {
            if (typeof sample !== "object" || sample === null) continue;
            const record = sample as Record<string, unknown>;
            if (typeof record["latencyMs"] === "number") {
              health.add(record["latencyMs"]);
            }
            if (typeof record["driftMs"] === "number") {
              drift.add(record["driftMs"]);
            }
          }
        }
      } catch {
        // An unparsable probe leaves empty summaries, and the scenario still
        // reports everything else.
      }
      return { health, drift };
    },
  };
}

async function auditScenario(
  client: BookClient,
  orders: readonly SeededOrder[],
  acceptedIntents: number,
  book: Book,
  bookOptions: { port: number; dataFile: string; federationDataFile: string; niceness: number; log: string[] },
): Promise<ConsistencyReport> {
  const rowsBefore = await readBook(client);
  const feed = await readFeed(client);
  const feedIds = feedOrderIds(feed.events);
  const missing = rowsBefore
    .filter((row) => !feedIds.has(row.id))
    .map((row) => row.id);
  const fills = fillsPerOrder(feed.events);
  const doubleFilled: string[] = [];
  for (const [orderId] of fills) {
    const reply = await client.send(
      "GET /orders/:id",
      "GET",
      `/api/orders/${orderId}`,
      AUDIT_IP,
    );
    const order = reply.body?.["order"];
    if (typeof order !== "object" || order === null) continue;
    const record = order as Record<string, unknown>;
    // The store holds exactly one selected fill; extra contradictory proofs
    // become retained equivocation evidence.
    const fill = record["fill"];
    if (Array.isArray(fill)) doubleFilled.push(orderId);
  }
  const intentsBefore = await intentCounts(client, orders);

  await book.stop();
  const reopened = await startBook(bookOptions);
  await waitForHealth(bookOptions.port, 20_000);
  const rowsAfter = await readBook(client);
  const intentsAfter = await intentCounts(client, orders);
  await reopened.stop();

  const differences = compareRows(rowsBefore, rowsAfter);
  const intentCountsIdentical =
    JSON.stringify(intentsBefore) === JSON.stringify(intentsAfter);

  return {
    bookRows: rowsBefore.length,
    feed: feed.totals,
    acceptedIntents,
    intentEventsMatchAccepted: feed.totals.intentEvents === acceptedIntents,
    ordersMissingFromFeed: missing,
    ordersWithMultipleFills: doubleFilled,
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
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (typeof entry !== "object" || entry === null) continue;
        const intents = (entry as Record<string, unknown>)["fillIntents"];
        if (Array.isArray(intents)) retainedIntents += intents.length;
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
  const bookOptions = {
    port,
    dataFile: join(scenarioDir, "orders.json"),
    federationDataFile: join(scenarioDir, "orders.json.federation"),
    niceness: options.niceness,
    log,
  };
  const metrics = new EndpointMetrics();
  const client = new BookClient({
    port,
    metrics,
    maxSockets: options.concurrency + 8,
    requestTimeoutMs: 30_000,
  });
  const book = await startBook(bookOptions);
  const cpuBefore = readProcessCpu(book.pid);
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
  let outcome: ScenarioOutcome = { notes: [] };
  let wallMs = 0;
  let probeResult = { health: new Latency(), drift: new Latency() };
  try {
    // Seeding runs before the measurement window, from the maker addresses.
    orders = await seedOrders(
      context,
      options.orders,
      options.hotOrders,
      3600,
    );
    if (orders.length === 0) throw new Error("no orders were seeded");
    log.push(`harness: seeded ${String(orders.length)} signed public orders`);

    const probe = startProbe(port, 100, options.niceness);
    const startedAt = performance.now();
    outcome =
      key === "a"
        ? await scenarioHotRace(context, orders, options.rounds)
        : key === "c"
          ? await scenarioMixed(context, orders, options.rounds, {
              readers: 8,
              subscribers: 20,
              makerCycles: Math.min(12, orders.length),
            })
          : key === "d"
            ? await scenarioBurstSteady(context, orders, options.rounds)
            : key === "f"
              ? await scenarioServiceTime(context, orders, 120)
              : await scenarioSpread(context, orders, options.rounds);
    wallMs = performance.now() - startedAt;
    probeResult = await probe.stop();
  } finally {
    if (book.exited) log.push("harness: book process exited during the run");
  }

  const cpuAfter = readProcessCpu(book.pid);
  const doubleFill = await probeDoubleFill(context, orders);
  const consistency = await auditScenario(
    client,
    orders,
    outcome.intents?.accepted ?? 0,
    book,
    bookOptions,
  );
  client.destroy();

  const usage =
    cpuBefore !== undefined && cpuAfter !== undefined
      ? {
          userMs: cpuAfter.userMs - cpuBefore.userMs,
          systemMs: cpuAfter.systemMs - cpuBefore.systemMs,
          rssBytes: cpuAfter.rssBytes,
          wallMs,
          cpuPercentOfOneCore:
            wallMs === 0
              ? 0
              : ((cpuAfter.userMs -
                  cpuBefore.userMs +
                  cpuAfter.systemMs -
                  cpuBefore.systemMs) /
                  wallMs) *
                100,
        }
      : undefined;

  return {
    name: SCENARIO_NAMES[key],
    description: SCENARIO_DESCRIPTIONS[key],
    sharedSourceAddress: key === "e",
    wallMs,
    endpoints: metrics.report(wallMs),
    throughput: {
      intentsSubmittedPerSecond:
        wallMs <= 0
          ? 0
          : Math.round(((outcome.intents?.submitted ?? 0) / wallMs) * 1000 * 10) /
            10,
      intentsAcceptedPerSecond:
        wallMs <= 0
          ? 0
          : Math.round(((outcome.intents?.accepted ?? 0) / wallMs) * 1000 * 10) /
            10,
    },
    ...(outcome.intents === undefined ? {} : { intents: outcome.intents }),
    ...(outcome.fairness === undefined ? {} : { fairness: outcome.fairness }),
    ...(outcome.sse === undefined ? {} : { sse: outcome.sse }),
    ...(outcome.phases === undefined ? {} : { phases: outcome.phases }),
    healthProbe: probeResult.health.summary(),
    harnessTimerDriftMs: probeResult.drift.summary(),
    ...(usage === undefined ? {} : { bookProcess: usage }),
    storage: readStorage(bookOptions.dataFile, bookOptions.federationDataFile),
    consistency,
    doubleFill,
    notes: outcome.notes,
    bookLogTail: log.slice(-12),
  };
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
    `run directory ${runDir}\nidentities ${identities.fromCache ? "reused from cache" : `derived in ${String(identities.derivationMs)} ms`}\n`,
  );

  const scenarios: ScenarioReport[] = [];
  for (const [index, key] of options.scenarios.entries()) {
    process.stdout.write(`running scenario ${key} ...\n`);
    scenarios.push(
      await runScenario(
        key as ScenarioKey,
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
  const result: RunResult = {
    schemaVersion: 1,
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
    },
    identityDerivationMs: identities.derivationMs,
    scenarios,
  };
  const outFile =
    options.out ?? join(runDir, `result-takers-${String(options.takers)}.json`);
  writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(`\n${formatRun(result)}\n\nJSON result: ${outFile}\n`);
}

await main();
