// Main-thread side of the harness signing pool. Workers are capped well below
// the core count so pre-signing never saturates the machine the harness runs
// on, and the pool is shut down before any measured traffic starts.

import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { SignResult, SignTask } from "./sign-worker.js";

export interface SignRequest {
  seedHex: string;
  messages: Uint8Array[];
}

const DEFAULT_MAX_WORKERS = 6;

export function defaultWorkerCount(): number {
  return Math.max(1, Math.min(DEFAULT_MAX_WORKERS, availableParallelism() - 2));
}

/** Signs every request, returning one signature list per request in order. */
export async function signAll(
  requests: readonly SignRequest[],
  workerCount = defaultWorkerCount(),
): Promise<string[][]> {
  const results: string[][] = requests.map(() => []);
  if (requests.length === 0) return results;
  const workers = Array.from(
    { length: Math.min(workerCount, requests.length) },
    () => new Worker(new URL("./sign-worker.js", import.meta.url)),
  );
  let next = 0;
  try {
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((resolve, reject) => {
            const pump = (): void => {
              if (next >= requests.length) {
                resolve();
                return;
              }
              const id = next;
              next += 1;
              const request = requests[id];
              if (request === undefined) {
                resolve();
                return;
              }
              const task: SignTask = {
                id,
                seedHex: request.seedHex,
                messages: request.messages,
              };
              worker.postMessage(task);
            };
            worker.on("message", (result: SignResult) => {
              results[result.id] = result.signatures.map(
                (signature) =>
                  `0x${Buffer.from(signature).toString("hex")}` as const,
              );
              pump();
            });
            worker.once("error", reject);
            pump();
          }),
      ),
    );
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
  return results;
}
