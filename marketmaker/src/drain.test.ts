import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { cancelOpenListing } from "./drain.js";

describe("operator drain", () => {
  it("cancels an open listing", async () => {
    let calls = 0;
    const cancelled = await cancelOpenListing(
      true,
      "open",
      async () => {
        calls += 1;
      },
      () => false,
    );
    assert.equal(cancelled, true);
    assert.equal(calls, 1);
  });

  it("leaves accepted and locking swaps under normal management", async () => {
    for (const status of ["accepted", "locking"] as const) {
      const cancelled = await cancelOpenListing(
        true,
        status,
        async () => assert.fail("active swap must not be cancelled by drain"),
        () => false,
      );
      assert.equal(cancelled, false);
    }
  });

  it("treats an already-gone listing as drained but propagates other failures", async () => {
    const gone = new Error("gone");
    assert.equal(
      await cancelOpenListing(
        true,
        "open",
        async () => {
          throw gone;
        },
        (err) => err === gone,
      ),
      true,
    );
    await assert.rejects(
      cancelOpenListing(
        true,
        "open",
        async () => {
          throw new Error("network down");
        },
        () => false,
      ),
      /network down/,
    );
  });
});
