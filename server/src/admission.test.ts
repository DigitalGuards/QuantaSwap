// The admission ceilings, exercised directly.
//
// These properties used to be asserted by racing requests at a running book,
// which made them depend on how the machine happened to schedule sockets: the
// book answers a small write in about a millisecond, so two of them overlap
// only if their bytes arrive inside the same event-loop turn. Under a loaded or
// single-core runner they often do not, the bound is never contended, and a
// test that demands a refusal fails while the code is correct. Here the state
// is set by the test and every assertion is about that state.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  admissionLane,
  InflightWriteBound,
  laneCeiling,
  type AdmissionLane,
} from "./admission.js";

/** Never matches, which is what an unknown order or a wrong token gives. */
const noCapability = (): boolean => false;
/** Matches one order id and one token, like the store's comparison. */
const capabilityFor =
  (orderId: string, token: string) =>
  (candidateId: string, candidateToken: string): boolean =>
    candidateId === orderId && candidateToken === token;

const ORDER = "a".repeat(16);
const TOKEN = "b".repeat(64);

describe("write admission lanes", () => {
  it("puts a maker write behind the capability it presents", () => {
    const matches = capabilityFor(ORDER, TOKEN);
    for (const action of ["cancel", "cancel/signed", "fill", "hashlock"]) {
      const path = `/api/orders/${ORDER}/${action}`;
      assert.equal(admissionLane(path, TOKEN, matches), "maker");
      // A maker path is not a maker: without the token, with a wrong one, and
      // with a header that is not a string at all, the request is a taker.
      assert.equal(admissionLane(path, undefined, matches), "taker");
      assert.equal(admissionLane(path, "c".repeat(64), matches), "taker");
      assert.equal(admissionLane(path, ["x"], matches), "taker");
      assert.equal(admissionLane(path, TOKEN, noCapability), "taker");
      // The token belongs to one order only.
      assert.equal(
        admissionLane(
          `/api/orders/${"d".repeat(16)}/${action}`,
          TOKEN,
          matches,
        ),
        "taker",
      );
    }
  });

  it("gives the signed create its own lane and leaves every other write a taker", () => {
    const matches = capabilityFor(ORDER, TOKEN);
    assert.equal(
      admissionLane("/api/orders/signed", TOKEN, matches),
      "signed-create",
    );
    // Presenting a token changes nothing here: the commitment it would be
    // checked against arrives inside the request.
    assert.equal(
      admissionLane("/api/orders/signed", undefined, matches),
      "signed-create",
    );
    for (const path of [
      "/api/orders",
      "/api/orders/take",
      `/api/orders/${ORDER}`,
      `/api/orders/${ORDER}/intents`,
      `/api/orders/${ORDER}/accept`,
      `/api/orders/${ORDER}/release`,
      `/api/orders/${ORDER}/heartbeat`,
      `/api/orders/${ORDER}/cancel/extra`,
    ]) {
      assert.equal(admissionLane(path, TOKEN, matches), "taker");
    }
  });

  it("splits a bound into a taker share, a create share and the whole bound", () => {
    // The shipped defaults.
    assert.equal(laneCeiling("taker", 32, 8), 24);
    assert.equal(laneCeiling("signed-create", 32, 8), 28);
    assert.equal(laneCeiling("maker", 32, 8), 32);
    // No reservation makes every lane the same.
    for (const lane of [
      "taker",
      "signed-create",
      "maker",
    ] satisfies AdmissionLane[]) {
      assert.equal(laneCeiling(lane, 4, 0), 4);
    }
    // An odd reservation gives the capability-authenticated routes the larger
    // half, because rounding down is what the create lane gets.
    assert.equal(laneCeiling("taker", 4, 3), 1);
    assert.equal(laneCeiling("signed-create", 4, 3), 2);
    assert.equal(laneCeiling("maker", 4, 3), 4);
    // A reservation of one keeps a floor that only a capability can reach.
    assert.equal(laneCeiling("taker", 2, 1), 1);
    assert.equal(laneCeiling("signed-create", 2, 1), 1);
    assert.equal(laneCeiling("maker", 2, 1), 2);
  });
});

describe("in-flight write bound", () => {
  it("refuses a lane at its ceiling and keeps the reservation for the others", () => {
    const bound = new InflightWriteBound(32, 8);
    const takers = Array.from({ length: 24 }, () => bound.acquire("taker"));
    assert.ok(takers.every((release) => release !== null));
    assert.equal(bound.inFlight, 24);
    // The taker lane is full. No volume of taker traffic can go past it.
    assert.equal(bound.acquire("taker"), null);
    assert.equal(bound.acquire("taker"), null);
    // The signed create reaches into half the reservation and no further.
    const creates = Array.from({ length: 4 }, () =>
      bound.acquire("signed-create"),
    );
    assert.ok(creates.every((release) => release !== null));
    assert.equal(bound.acquire("signed-create"), null);
    assert.equal(bound.acquire("taker"), null);
    assert.equal(bound.inFlight, 28);
    // A capability-authenticated write still gets in, which is the whole point
    // of the reservation.
    const makers = Array.from({ length: 4 }, () => bound.acquire("maker"));
    assert.ok(makers.every((release) => release !== null));
    assert.equal(bound.inFlight, 32);
    assert.equal(bound.acquire("maker"), null);

    for (const release of [...takers, ...creates, ...makers]) release?.();
    assert.equal(bound.inFlight, 0);
    assert.ok(bound.acquire("taker"));
  });

  it("keeps a maker slot free while the taker lane is saturated", () => {
    // The smallest bound that distinguishes the lanes: one taker slot, and one
    // more that only a capability can reach.
    const bound = new InflightWriteBound(2, 1);
    const taker = bound.acquire("taker");
    assert.ok(taker);
    assert.equal(bound.acquire("taker"), null);
    assert.equal(bound.acquire("signed-create"), null);
    const maker = bound.acquire("maker");
    assert.ok(maker);
    assert.equal(bound.acquire("maker"), null);
    taker();
    maker();
    assert.equal(bound.inFlight, 0);
  });

  it("returns a slot once however often it is released", () => {
    const bound = new InflightWriteBound(2, 0);
    const release = bound.acquire("taker");
    assert.ok(release);
    assert.equal(bound.inFlight, 1);
    release();
    release();
    release();
    assert.equal(bound.inFlight, 0);
    // A finally that runs after an error and again on a later path cannot
    // hand back a slot the request never held.
    const first = bound.acquire("taker");
    const second = bound.acquire("taker");
    assert.ok(first);
    assert.ok(second);
    assert.equal(bound.acquire("taker"), null);
    first();
    first();
    assert.equal(bound.inFlight, 1);
    second();
    assert.equal(bound.inFlight, 0);
  });

  it("refuses a bound that leaves a lane nothing", () => {
    assert.throws(() => new InflightWriteBound(0, 0), /positive integer/);
    assert.throws(() => new InflightWriteBound(4, 4), /below the bound/);
    assert.throws(() => new InflightWriteBound(4, 5), /below the bound/);
    assert.throws(() => new InflightWriteBound(4, -1), /below the bound/);
  });
});
