// Standalone responsiveness probe. It runs in its own process so the
// harness's event loop, which drives dozens of concurrent clients, cannot
// inflate the number that is supposed to describe the book's responsiveness.
//
// argv: <port> <intervalMs> <forwardedFor>

import { probeHealth } from "./book.js";

export interface ProbeSample {
  latencyMs: number;
  status: number;
  /** Scheduling delay of this probe's own timer, in its own process. */
  driftMs: number;
}

const port = Number(process.argv[2]);
const intervalMs = Number(process.argv[3]);
const forwardedFor = process.argv[4] ?? "";
if (!Number.isInteger(port) || !Number.isInteger(intervalMs)) {
  throw new Error("probe requires an integer port and interval");
}

const samples: ProbeSample[] = [];
let running = true;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function emit(): void {
  process.stdout.write(`${JSON.stringify({ samples })}\n`);
}

process.once("SIGTERM", () => {
  running = false;
});

let expected = performance.now() + intervalMs;
while (running) {
  await sleep(Math.max(0, expected - performance.now()));
  if (!running) break;
  const driftMs = performance.now() - expected;
  const result = await probeHealth(port, forwardedFor);
  // Re-anchor after the probe completes, so the drift figure stays a pure
  // per-tick scheduling delay and never absorbs the request's own duration.
  expected = performance.now() + intervalMs;
  samples.push({
    latencyMs: result.latencyMs,
    status: result.status,
    driftMs,
  });
}
emit();
