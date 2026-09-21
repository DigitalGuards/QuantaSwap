import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { AdmissionBackoff, parseAdmissionRecords } from "./admission.js";

describe("quote admission backpressure", () => {
  it("shares one bounded retry deadline across pending proofs", () => {
    const retry = new AdmissionBackoff();
    let now = 1000;
    assert.equal(retry.canAttempt(now), true);
    for (const delay of [15, 30, 60, 120, 240, 300, 300]) {
      retry.failed(now);
      assert.equal(retry.nextAttemptAt(), now + delay);
      for (let pending = 0; pending < 28; pending++) {
        assert.equal(retry.canAttempt(now + delay - 1), false);
      }
      now += delay;
      assert.equal(retry.canAttempt(now), true);
    }
    retry.succeeded();
    assert.equal(retry.nextAttemptAt(), 0);
    retry.failed(now);
    assert.equal(retry.nextAttemptAt(), now + 15);
  });

  it("rejects malformed or duplicate persisted admission accounting", () => {
    const row = { id: "ab".repeat(32), retainUntil: 1000 };
    assert.deepEqual(parseAdmissionRecords([row]), [row]);
    for (const raw of [null, [row, row], [{ ...row, retainUntil: 1.5 }],
      [{ ...row, retainUntil: 0 }], [{ ...row, extra: true }], [{ ...row, id: "bad" }],
      Array.from({ length: 257 }, () => row)]) {
      assert.throws(() => parseAdmissionRecords(raw), /malformed/);
    }
  });
});
