// Bounded task pool. The harness shares a workstation, so the number of
// in-flight requests stays capped and one socket per synthetic client is
// never opened. Every scenario reports the cap it ran under.

export async function mapPool<TTask, TResult>(
  tasks: readonly TTask[],
  limit: number,
  run: (task: TTask, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(tasks.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, tasks.length)) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= tasks.length) return;
        const task = tasks[index];
        if (task === undefined) return;
        results[index] = await run(task, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** Runs `count` concurrent loops until the deadline passes. */
export async function runUntil(
  count: number,
  deadlineMs: number,
  iteration: (slot: number, round: number) => Promise<void>,
): Promise<void> {
  await Promise.all(
    Array.from({ length: Math.max(1, count) }, async (_value, slot) => {
      let round = 0;
      while (performance.now() < deadlineMs) {
        await iteration(slot, round);
        round += 1;
      }
    }),
  );
}

export interface DrainSummary {
  sent: number;
  wallMs: number;
  /** True when the pre-signed supply ran out before the deadline. */
  exhausted: boolean;
}

/** Drains a pre-signed queue at a bounded concurrency, stopping at the
 *  deadline or when the queue empties. Signed proofs are finite, so a
 *  scenario reports which of the two limits it hit. */
export async function drainQueue<TTask>(
  queue: readonly TTask[],
  concurrency: number,
  deadlineMs: number,
  pacingMs: number,
  handle: (task: TTask) => Promise<void>,
): Promise<DrainSummary> {
  const startedAt = performance.now();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, async () => {
      for (;;) {
        if (performance.now() >= deadlineMs) return;
        const index = next;
        next += 1;
        const task = queue[index];
        if (task === undefined) return;
        await handle(task);
        if (pacingMs > 0) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, pacingMs);
          });
        }
      }
    }),
  );
  return {
    sent: Math.min(next, queue.length),
    wallMs: performance.now() - startedAt,
    exhausted: next >= queue.length,
  };
}
