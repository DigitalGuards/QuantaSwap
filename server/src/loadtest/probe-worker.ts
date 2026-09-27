// Standalone responsiveness probe. It runs in its own process so the
// harness's event loop, which drives dozens of concurrent clients, cannot
// inflate the number that is supposed to describe the book's responsiveness.
//
// Samples are streamed one JSON line at a time, so a probe that is killed
// still leaves every sample it took.
//
// argv: <port> <intervalMs> <forwardedFor>

import { probeHealth } from "./book.js";

export interface ProbeSample {
  latencyMs: number;
  status: number;
  /** Fixed-grid ticks skipped because the previous request was still open. */
  missedTicks: number;
  /** Scheduling delay against the fixed grid, clamped at the tick interval so
   *  a long request shows up as missed ticks and never as inflated drift. */
  driftMs: number;
}

const port = Number(process.argv[2]);
const intervalMs = Number(process.argv[3]);
const forwardedFor = process.argv[4] ?? "";
if (!Number.isInteger(port) || !Number.isInteger(intervalMs)) {
  throw new Error("probe requires an integer port and interval");
}

let running = true;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function emit(sample: ProbeSample): void {
  process.stdout.write(`${JSON.stringify(sample)}\n`);
}

process.once("SIGTERM", () => {
  running = false;
});
process.once("SIGINT", () => {
  running = false;
});

// A fixed grid anchored once at startup. A request that outlasts its tick
// consumes the ticks it overran, and those are reported as missed, so a stall
// keeps its full weight and the schedule never quietly shifts.
const startedAt = performance.now();
let tick = 1;
while (running) {
  const target = startedAt + tick * intervalMs;
  const now = performance.now();
  if (now < target) await sleep(target - now);
  if (!running) break;
  const arrivedAt = performance.now();
  // Scheduling lateness only. The request's own duration is reported through
  // the missed ticks below, so drift never absorbs it.
  const driftMs = Math.min(Math.max(0, arrivedAt - target), intervalMs);
  const result = await probeHealth(port, forwardedFor);
  const finishedAt = performance.now();
  // Grid slots whose scheduled moment passed while this request was open. One
  // slow reply from a saturated book consumes many slots, and saying so is how
  // a stall stays visible when the sample count alone would hide it.
  const nextTick = Math.floor((finishedAt - startedAt) / intervalMs) + 1;
  const missedTicks = Math.max(0, nextTick - tick - 1);
  emit({
    latencyMs: result.latencyMs,
    status: result.status,
    missedTicks,
    driftMs,
  });
  tick = Math.max(tick + 1, nextTick);
}
