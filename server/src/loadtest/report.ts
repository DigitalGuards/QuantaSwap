// Human-readable summary tables beside the machine-readable JSON result.

import type { EndpointReport, LatencySummary } from "./metrics.js";
import type {
  DoubleFillProbe,
  FairnessReport,
  IntentOutcome,
  SseReport,
} from "./scenarios.js";
import type { ConsistencyReport } from "./consistency.js";

export interface RunEnvironment {
  node: string;
  platform: string;
  cpuModel: string;
  cpuCores: number;
  memoryGiB: number;
  niceness: number;
}

export interface RunConfig {
  takers: number;
  makers: number;
  orders: number;
  hotOrders: number;
  rounds: number;
  durationMs: number;
  concurrency: number;
  signWorkers: number;
  scenarios: string[];
}

export interface BookProcessUsage {
  userMs: number;
  systemMs: number;
  rssBytes: number;
  wallMs: number;
  /** One core fully busy reads as 100. */
  cpuPercentOfOneCore: number;
}

export interface ScenarioReport {
  name: string;
  description: string;
  sharedSourceAddress: boolean;
  wallMs: number;
  endpoints: EndpointReport[];
  throughput: {
    intentsSubmittedPerSecond: number;
    intentsAcceptedPerSecond: number;
  };
  intents?: IntentOutcome;
  fairness?: FairnessReport;
  sse?: SseReport;
  phases?: Record<string, LatencySummary>;
  /** Externally measured book responsiveness: GET /api/health round trips
   *  sampled on a fixed interval during the scenario. */
  healthProbe: LatencySummary;
  /** Scheduling drift of the harness's own sampling timer, for contrast. */
  harnessTimerDriftMs: LatencySummary;
  bookProcess?: BookProcessUsage;
  /** Size of the persisted state that every mutation rewrites and fsyncs. */
  storage: {
    dataFileBytes: number;
    feedFileBytes: number;
    retainedIntents: number;
  };
  consistency: ConsistencyReport;
  doubleFill: DoubleFillProbe;
  notes: string[];
  bookLogTail: string[];
}

export interface RunResult {
  schemaVersion: 1;
  startedAt: string;
  environment: RunEnvironment;
  config: RunConfig;
  identityDerivationMs: number;
  scenarios: ScenarioReport[];
}

function pad(value: string, width: number, right = false): string {
  if (value.length >= width) return value;
  const filler = " ".repeat(width - value.length);
  return right ? filler + value : value + filler;
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: string[], right: boolean[]): string =>
    cells
      .map((cell, column) => pad(cell, widths[column] ?? 0, right[column] ?? false))
      .join("  ");
  const alignRight = headers.map((_header, column) => column > 0);
  return [
    line(headers, alignRight),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map((row) => line(row, alignRight)),
  ].join("\n");
}

function latencyRow(label: string, summary: LatencySummary): string[] {
  return [
    label,
    String(summary.count),
    summary.p50Ms.toFixed(1),
    summary.p95Ms.toFixed(1),
    summary.p99Ms.toFixed(1),
    summary.maxMs.toFixed(1),
  ];
}

function statusMix(report: EndpointReport): string {
  const parts = Object.entries(report.statuses).map(
    ([status, count]) => `${status}:${String(count)}`,
  );
  for (const [reason, count] of Object.entries(report.errors)) {
    parts.push(`${reason}:${String(count)}`);
  }
  return parts.join(" ") || "-";
}

export function formatRun(result: RunResult): string {
  const out: string[] = [];
  out.push("QuantaSwap order book load test");
  out.push(
    `  host class: ${result.environment.cpuModel}, ${String(result.environment.cpuCores)} logical cores, ${result.environment.memoryGiB.toFixed(0)} GiB RAM, node ${result.environment.node}, niceness ${String(result.environment.niceness)}`,
  );
  out.push(
    `  takers ${String(result.config.takers)}, makers ${String(result.config.makers)}, seeded orders ${String(result.config.orders)} (${String(result.config.hotOrders)} hot), rounds ${String(result.config.rounds)}, duration ${String(Math.round(result.config.durationMs / 1000))} s, in-flight cap ${String(result.config.concurrency)}`,
  );
  out.push(
    `  identity derivation ${String(result.identityDerivationMs)} ms, signing workers ${String(result.config.signWorkers)}`,
  );

  for (const scenario of result.scenarios) {
    out.push("");
    out.push(`== ${scenario.name} ==`);
    out.push(`   ${scenario.description}`);
    out.push(
      `   wall ${(scenario.wallMs / 1000).toFixed(1)} s, source addresses: ${scenario.sharedSourceAddress ? "one shared" : "one per client"}`,
    );
    out.push("");
    out.push(
      table(
        ["endpoint", "n", "p50", "p95", "p99", "max", "req/s", "statuses"],
        scenario.endpoints.map((endpoint) => [
          ...latencyRow(endpoint.endpoint, endpoint),
          endpoint.requestsPerSecond.toFixed(1),
          statusMix(endpoint),
        ]),
      ),
    );
    out.push("");
    const probes: string[][] = [
      latencyRow("GET /api/health probe", scenario.healthProbe),
      latencyRow("harness timer drift", scenario.harnessTimerDriftMs),
    ];
    out.push(table(["probe", "n", "p50", "p95", "p99", "max"], probes));
    if (scenario.phases !== undefined) {
      out.push("");
      out.push(
        table(
          ["phase", "n", "p50", "p95", "p99", "max"],
          Object.entries(scenario.phases).map(([name, summary]) =>
            latencyRow(name, summary),
          ),
        ),
      );
    }
    if (scenario.bookProcess !== undefined) {
      out.push("");
      out.push(
        `   book process: ${scenario.bookProcess.cpuPercentOfOneCore.toFixed(0)}% of one core (user ${String(scenario.bookProcess.userMs)} ms, system ${String(scenario.bookProcess.systemMs)} ms over ${String(Math.round(scenario.bookProcess.wallMs))} ms), RSS ${(scenario.bookProcess.rssBytes / 1024 / 1024).toFixed(0)} MiB`,
      );
    }
    if (scenario.intents !== undefined) {
      out.push("");
      out.push(
        `   fill intents: ${String(scenario.intents.submitted)} submitted, ${String(scenario.intents.accepted)} accepted, ${String(scenario.intents.rejected)} rejected, ${String(scenario.intents.transportErrors)} transport errors`,
      );
      out.push(
        `   intent throughput: ${scenario.throughput.intentsSubmittedPerSecond.toFixed(1)} submitted/s, ${scenario.throughput.intentsAcceptedPerSecond.toFixed(1)} accepted/s`,
      );
      out.push(
        table(
          ["intent path", "n", "p50", "p95", "p99", "max"],
          [
            latencyRow("admitted (verify + persist)", scenario.intents.acceptedLatency),
            latencyRow("rejected (verify only)", scenario.intents.rejectedLatency),
          ],
        )
          .split("\n")
          .map((line) => `   ${line}`)
          .join("\n"),
      );
      const reasons = Object.entries(scenario.intents.reasons);
      if (reasons.length > 0) {
        out.push(
          table(
            ["rejection reason", "count"],
            reasons.map(([reason, count]) => [reason, String(count)]),
          )
            .split("\n")
            .map((line) => `   ${line}`)
            .join("\n"),
        );
      }
    }
    if (scenario.fairness !== undefined) {
      const fairness = scenario.fairness;
      out.push("");
      out.push(
        `   fairness: documented ordering holds: ${String(fairness.orderingMatchesDocumentedRule)} over ${String(fairness.inspectedIntents)} live intents on ${String(fairness.inspectedOrders)} orders`,
      );
      out.push(
        `   distinct winning takers ${String(fairness.distinctWinners)}, most wins by one taker ${String(fairness.maxWinsByOneTaker)}, takers with no admitted intent ${String(fairness.takersWithZeroWins)}`,
      );
      if (fairness.winnersPerRound.length > 0) {
        out.push(
          `   admitted per race round: ${fairness.winnersPerRound.join(", ")}`,
        );
      }
    }
    if (scenario.sse !== undefined) {
      const sse = scenario.sse;
      out.push("");
      out.push(
        `   SSE: ${String(sse.accepted)} of ${String(sse.subscribers)} subscribers accepted, ${String(sse.rejected)} rejected, ${String(sse.droppedSubscribers)} dropped mid-run, ${String(sse.observedOrders)} tracked orders observed, ${String(sse.incompleteDeliveries)} not delivered to every subscriber`,
      );
      out.push(
        table(
          ["sse measure", "n", "p50", "p95", "p99", "max"],
          [
            latencyRow("publish latency (request start to first frame)", sse.publishLatency),
            latencyRow("fan-out spread (first to last subscriber)", sse.fanoutSpread),
          ],
        )
          .split("\n")
          .map((line) => `   ${line}`)
          .join("\n"),
      );
    }
    out.push("");
    out.push(
      `   persisted state at the end of the run: store ${(scenario.storage.dataFileBytes / 1024 / 1024).toFixed(2)} MiB, federation feed ${(scenario.storage.feedFileBytes / 1024 / 1024).toFixed(2)} MiB, ${String(scenario.storage.retainedIntents)} retained intents. Every mutation rewrites and fsyncs the whole store file.`,
    );
    const consistency = scenario.consistency;
    out.push("");
    out.push(
      `   consistency: ${String(consistency.bookRows)} open rows, feed ${String(consistency.feed.events)} events (${String(consistency.feed.orderEvents)} order, ${String(consistency.feed.intentEvents)} intent, ${String(consistency.feed.fillEvents)} fill, ${String(consistency.feed.cancelEvents)} cancel)`,
    );
    out.push(
      `   accepted intents ${String(consistency.acceptedIntents)} match feed intent events: ${String(consistency.intentEventsMatchAccepted)}; orders missing from feed: ${String(consistency.ordersMissingFromFeed.length)}; orders with more than one stored fill: ${String(consistency.ordersWithMultipleFills.length)}`,
    );
    out.push(
      `   restart reload: ${String(consistency.restart.reloadedRows)} rows, identical: ${String(consistency.restart.rowsIdentical)}, retained intents identical: ${String(consistency.restart.intentCountsIdentical)}`,
    );
    for (const difference of consistency.restart.differences.slice(0, 5)) {
      out.push(`     difference: ${difference}`);
    }
    out.push(
      `   double fill race: ${scenario.doubleFill.attempted ? `responses ${scenario.doubleFill.responses.join("/")}, stored fills ${String(scenario.doubleFill.storedFills)}, conflict proofs ${String(scenario.doubleFill.conflictDigests)}, status ${scenario.doubleFill.status ?? "unknown"}` : scenario.doubleFill.note}`,
    );
    for (const note of scenario.notes) out.push(`   note: ${note}`);
    for (const line of scenario.bookLogTail) out.push(`   book: ${line}`);
  }
  return out.join("\n");
}
