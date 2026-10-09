// A take waits between passes, and nothing else holds the event loop while
// it waits. These two tests pin that: the wait's timer must keep the
// process alive, and a real child process must reach settlement across
// several passes and exit cleanly. A live run exited right after proposing
// because the wait used an unref'd timer, which the injected sleeps in the
// other suites cannot catch.

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { describe, it } from "node:test";
import { defaultSleep } from "./taker.js";

const timeouts = (): number =>
  process.getActiveResourcesInfo().filter((resource) => resource === "Timeout")
    .length;

describe("the wait between passes keeps the process alive", () => {
  it("registers a timer that holds the event loop", async () => {
    const before = timeouts();
    const pending = defaultSleep(25);
    assert.equal(
      timeouts(),
      before + 1,
      "the wait must create a referenced timer, so Node cannot exit mid-swap",
    );
    await pending;
    assert.equal(timeouts(), before);
  });
});

describe("a real process settles a swap across several passes", () => {
  it("runs to a claim and exits cleanly", async () => {
    const child = new URL("./taker-survival-child.js", import.meta.url);
    const { stdout } = await new Promise<{ stdout: string }>(
      (resolve, reject) => {
        execFile(
          process.execPath,
          [child.pathname],
          { timeout: 60_000 },
          (error, stdout, stderr) => {
            if (error !== null) {
              reject(
                new Error(
                  `child failed: ${error.message}\n${stdout}\n${stderr}`,
                ),
              );
              return;
            }
            resolve({ stdout });
          },
        );
      },
    );
    assert.match(stdout, /SETTLED:claimed/);
    assert.match(stdout, /CLAIMED:true/);
    const passes = /PASSES:(\d+)/.exec(stdout);
    assert.notEqual(passes, null);
    assert.ok(
      Number(passes?.[1] ?? 0) >= 3,
      `the swap must take several passes, saw ${passes?.[1] ?? "none"}`,
    );
  });
});
