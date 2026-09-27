// Human-readable summary tables beside the machine-readable JSON result.

import type { EndpointReport, LatencySummary } from "./metrics.js";
import type {
  CapCheck,
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
  runDir: string;
}

export interface BookProcessUsage {
  userMs: number;
  systemMs: number;
  rssBytes: number;
  wallMs: number;
  /** One core fully busy reads as 100. */
  cpuPercentOfOneCore: number;
}

export interface PreparationReport {
  prepareMs: number;
  signatures: number;
  signedValidityRemainingS: number;
  /** Seeding traffic, kept out of the measured numbers. */
  endpoints: EndpointReport[];
}

export interface HealthProbeReport {
  latency: LatencySummary;
  /** Per-tick scheduling delay against the probe's fixed grid. */
  drift: LatencySummary;
  samples: number;
  /** Grid ticks the probe skipped because a request was still open. */
  missedTicks: number;
  nonOkReplies: number;
}

export interface ScenarioReport {
  name: string;
  description: string;
  sharedSourceAddress: boolean;
  /** The measured window only. Preparation and the audit sit outside it. */
  wallMs: number;
  preparation: PreparationReport;
  endpoints: EndpointReport[];
  /** Invariant-check traffic, recorded separately so it never lands in the
   *  measured latency or throughput figures. */
  auditEndpoints: EndpointReport[];
  throughput: {
    intentsSubmittedPerSecond: number;
    intentsAdmittedPerSecond: number;
  };
  intents?: IntentOutcome;
  fairness?: FairnessReport;
  sse?: SseReport;
  phases?: Record<string, LatencySummary>;
  capChecks: CapCheck[];
  healthProbe?: HealthProbeReport;
  bookProcess?: BookProcessUsage;
  /** Size of the persisted state that one group commit rewrites and fsyncs. */
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
  schemaVersion: 2;
  startedAt: string;
  environment: RunEnvironment;
  config: RunConfig;
  identityDerivationMs: number;
  scenarios: ScenarioReport[];
  /** Empty when every cap assertion and every invariant held. */
  failures: string[];
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
      .map((cell, column) =>
        pad(cell, widths[column] ?? 0, right[column] ?? false),
      )
      .join("  ");
  const alignRight = headers.map((_header, column) => column > 0);
  return [
    line(headers, alignRight),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map((row) => line(row, alignRight)),
  ].join("\n");
}

function indent(block: string): string {
  return block
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n");
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
    `  identity derivation ${String(result.identityDerivationMs)} ms, signing workers ${String(result.config.signWorkers)}, run directory ${result.config.runDir}`,
  );

  for (const scenario of result.scenarios) {
    out.push("");
    out.push(`== ${scenario.name} ==`);
    out.push(`   ${scenario.description}`);
    out.push(
      `   measured window ${(scenario.wallMs / 1000).toFixed(1)} s, source addresses: ${scenario.sharedSourceAddress ? "one shared" : "one per client"}`,
    );
    out.push(
      `   preparation outside the window: ${scenario.preparation.signatures} signatures in ${(scenario.preparation.prepareMs / 1000).toFixed(1)} s, ${String(scenario.preparation.signedValidityRemainingS)} s of signed proposal validity left at the start`,
    );
    out.push("");
    out.push(
      table(
        ["measured endpoint", "n", "p50", "p95", "p99", "max", "req/s", "statuses"],
        scenario.endpoints.map((endpoint) => [
          ...latencyRow(endpoint.endpoint, endpoint),
          endpoint.requestsPerSecond.toFixed(1),
          statusMix(endpoint),
        ]),
      ),
    );
    if (scenario.healthProbe !== undefined) {
      const probe = scenario.healthProbe;
      out.push("");
      out.push(
        indent(
          table(
            ["external probe", "n", "p50", "p95", "p99", "max"],
            [
              latencyRow("GET /api/health round trip", probe.latency),
              latencyRow("probe grid drift", probe.drift),
            ],
          ),
        ),
      );
      out.push(
        `   probe samples ${String(probe.samples)}, grid ticks missed while a reply was outstanding ${String(probe.missedTicks)}, replies other than 200 (including its own 10 s timeout) ${String(probe.nonOkReplies)}`,
      );
    } else {
      out.push("");
      out.push("   external probe: no samples were recorded for this scenario");
    }
    if (scenario.bookProcess !== undefined) {
      out.push("");
      out.push(
        `   book process during the window: ${scenario.bookProcess.cpuPercentOfOneCore.toFixed(0)}% of one core (user ${String(scenario.bookProcess.userMs)} ms, system ${String(scenario.bookProcess.systemMs)} ms over ${String(Math.round(scenario.bookProcess.wallMs))} ms), RSS ${(scenario.bookProcess.rssBytes / 1024 / 1024).toFixed(0)} MiB`,
      );
    }
    if (scenario.phases !== undefined) {
      out.push("");
      out.push(
        indent(
          table(
            ["phase", "n", "p50", "p95", "p99", "max"],
            Object.entries(scenario.phases).map(([name, summary]) =>
              latencyRow(name, summary),
            ),
          ),
        ),
      );
    }
    if (scenario.intents !== undefined) {
      const intents = scenario.intents;
      out.push("");
      out.push(
        `   fill intents: ${String(intents.submitted)} submitted, ${String(intents.admitted)} admitted, ${String(intents.refused)} refused, ${String(intents.transportErrors)} transport errors`,
      );
      out.push(
        `   intent throughput: ${scenario.throughput.intentsSubmittedPerSecond.toFixed(1)} submitted/s, ${scenario.throughput.intentsAdmittedPerSecond.toFixed(1)} admitted/s`,
      );
      out.push(
        indent(
          table(
            ["intent path", "n", "p50", "p95", "p99", "max"],
            [
              latencyRow("admitted: verify plus persist", intents.admittedLatency),
              latencyRow(
                "refused after verification",
                intents.refusedAfterVerifyLatency,
              ),
              latencyRow(
                "shed by the limiter before verification",
                intents.shedBeforeVerifyLatency,
              ),
            ],
          ),
        ),
      );
      const reasons = Object.entries(intents.reasons);
      if (reasons.length > 0) {
        out.push(
          indent(
            table(
              ["refusal reason", "count"],
              reasons.map(([reason, count]) => [reason, String(count)]),
            ),
          ),
        );
      }
    }
    if (scenario.capChecks.length > 0) {
      out.push("");
      out.push(
        indent(
          table(
            ["documented cap assertion", "expected", "observed", "result"],
            scenario.capChecks.map((check) => [
              `${check.name} (${check.rule})`,
              check.expected,
              String(check.observed),
              check.ok ? "hold" : "FAIL",
            ]),
          ),
        ),
      );
    }
    if (scenario.fairness !== undefined) {
      const fairness = scenario.fairness;
      out.push("");
      out.push(
        `   fairness: documented ordering holds: ${String(fairness.orderingMatchesDocumentedRule)} over ${String(fairness.inspectedIntents)} live proposals on ${String(fairness.inspectedOrders)} orders`,
      );
      out.push(
        `   distinct winning takers ${String(fairness.distinctWinners)}, most wins by one taker ${String(fairness.maxWinsByOneTaker)}, takers with no admitted proposal ${String(fairness.takersWithZeroWins)}`,
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
        `   SSE: ${String(sse.accepted)} of ${String(sse.subscribers)} subscribers accepted, ${String(sse.rejected)} rejected, ${String(sse.droppedSubscribers)} dropped mid-run`,
      );
      out.push(
        `   tracked orders ${String(sse.trackedOrders)}, observed by at least one subscriber ${String(sse.observedOrders)}, missing from at least one subscriber ${String(sse.incompleteDeliveries)}`,
      );
      out.push(
        indent(
          table(
            ["sse measure", "n", "p50", "p95", "p99", "max"],
            [
              latencyRow(
                "publish latency (request start to first frame)",
                sse.publishLatency,
              ),
              latencyRow(
                "fan-out spread (first to last subscriber)",
                sse.fanoutSpread,
              ),
            ],
          ),
        ),
      );
    }
    const consistency = scenario.consistency;
    out.push("");
    out.push(
      `   persisted state at the end of the run: store ${(scenario.storage.dataFileBytes / 1024 / 1024).toFixed(2)} MiB, federation feed ${(scenario.storage.feedFileBytes / 1024 / 1024).toFixed(2)} MiB, ${String(scenario.storage.retainedIntents)} retained proposals. One group commit rewrites and fsyncs the whole store file for every mutation it carries.`,
    );
    out.push("");
    out.push(
      `   append-only log paged from the oldest retained sequence: ${String(consistency.feed.logReadFromStart)}, ${String(consistency.feed.logPages)} pages, ${String(consistency.feed.logEvents)} events (${String(consistency.feed.logOrderEvents)} order, ${String(consistency.feed.logIntentEvents)} intent, ${String(consistency.feed.logFillEvents)} fill, ${String(consistency.feed.logCancelEvents)} cancel), sequences ${String(consistency.feed.oldestSequence)} to ${String(consistency.feed.latestSequence)}`,
    );
    out.push(
      `   reset snapshot (store view): ${String(consistency.feed.snapshotRows)} rows, ${String(consistency.feed.snapshotFillEvents)} fill events`,
    );
    out.push(
      `   admitted proposals ${String(consistency.admittedIntents)} match fill-intent log events: ${String(consistency.intentLogEventsMatchAdmitted)}`,
    );
    out.push(
      `   open rows missing from the log: ${String(consistency.ordersMissingFromLog.length)}, missing from the snapshot: ${String(consistency.ordersMissingFromSnapshot.length)}`,
    );
    out.push(
      `   orders without exactly one stored fill: ${String(consistency.ordersWithMultipleStoredFills.length)}, highest live proposal count on one order: ${String(consistency.maxLiveIntentsOnOneOrder)} against the documented 8`,
    );
    out.push(
      `   restart reload: ${String(consistency.restart.reloadedRows)} rows, identical: ${String(consistency.restart.rowsIdentical)}, retained proposals identical: ${String(consistency.restart.intentCountsIdentical)}`,
    );
    for (const difference of consistency.restart.differences.slice(0, 5)) {
      out.push(`     difference: ${difference}`);
    }
    const race = scenario.doubleFill;
    out.push(
      race.attempted
        ? `   double fill race: responses ${race.responses.join("/")}, raced ${race.racedDigests.map((digest) => digest.slice(2, 10)).join(" and ")}, store kept ${race.storedFillDigest?.slice(2, 10) ?? "nothing"}, retained conflicts ${race.retainedConflicts.map((digest) => digest.slice(2, 10)).join(",") || "none"}, status ${race.status ?? "unknown"}, exactly one selected: ${String(race.exactlyOneFillSelected)}`
        : `   double fill race: ${race.note}`,
    );
    for (const note of scenario.notes) out.push(`   note: ${note}`);
    for (const line of scenario.bookLogTail) out.push(`   book: ${line}`);
  }

  out.push("");
  if (result.failures.length === 0) {
    out.push(
      "All documented cap assertions and all invariant checks held in every scenario.",
    );
  } else {
    out.push(`${String(result.failures.length)} assertion failures:`);
    for (const failure of result.failures) out.push(`  ${failure}`);
  }
  return out.join("\n");
}
