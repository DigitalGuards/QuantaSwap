import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { AdmissionBackoff, canRetireExpiredUnfundedQuote, parseAdmissionRecords } from "./admission.js";
import type { ManagedOrder } from "./policy.js";

describe("quote admission backpressure", () => {
  it("retires only pure expired quotes before a mirror read", () => {
    const quote = {
      protocol: { orderAuth: { expiresAt: 1000 }, order: {} },
      preimage: null, hashlock: null, lockSentAt: null, claimSentAt: null, refundSentAt: null,
      initiatorTimeout: null, responderTimeout: null, announcedAt: null,
      takerEthAccount: null, takerQrlAccount: null,
    } as unknown as ManagedOrder;
    assert.equal(canRetireExpiredUnfundedQuote(quote, 999), false);
    assert.equal(canRetireExpiredUnfundedQuote(quote, 1000), true);
    const variants = [
      { ...quote, protocol: undefined },
      ...["selectedIntent", "fillProof", "cancelProof"].map(key => ({
        ...quote, protocol: { ...quote.protocol, [key]: {} },
      })),
      { ...quote, protocol: { ...quote.protocol, fillAcknowledged: true } },
      { ...quote, protocol: { ...quote.protocol, releaseObserved: true } },
      { ...quote, protocol: { ...quote.protocol, order: { prelock: {} } } },
      ...["preimage", "hashlock", "takerEthAccount", "takerQrlAccount"].map(key => ({ ...quote, [key]: "retained" })),
      ...["lockSentAt", "claimSentAt", "refundSentAt", "initiatorTimeout", "responderTimeout", "announcedAt"].map(key => ({ ...quote, [key]: 0 })),
    ];
    for (const variant of variants) {
      assert.equal(canRetireExpiredUnfundedQuote(variant as ManagedOrder, 2000), false);
    }
  });
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
