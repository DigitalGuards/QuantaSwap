// Admission accounting for writes: which share of a bound a request may use,
// and the counter that hands those shares out.
//
// This lives in its own module so the arithmetic can be exercised directly.
// Proving it over HTTP means getting several requests to overlap inside the
// service, which depends on how the machine schedules sockets and is not a
// property of the code under test; the tests that drive a real book therefore
// assert what only HTTP can show and leave the ceilings to this module.

/**
 * Which share of each admission bound a request may use.
 *
 * - `maker` is a write to an order by a caller that presented that order's
 *   maker capability, checked against the stored commitment before the body is
 *   read. It may use the whole bound, so a maker can always withdraw or fill a
 *   stale-priced order while takers rush the book.
 * - `signed-create` is a maker action that carries no capability to check yet,
 *   because the commitment it would be checked against arrives inside the
 *   request. It gets a small sub-reserve of its own, so a create flood cannot
 *   consume the headroom the capability-authenticated routes need.
 * - `taker` is everything else, including the legacy unsigned create. It may
 *   use the bound minus the whole reservation.
 */
export type AdmissionLane = "maker" | "signed-create" | "taker";

export const SIGNED_CREATE_PATH = "/api/orders/signed";
/** The write routes that name one order and can present its capability. */
export const MAKER_ORDER_PATH_RE =
  /^\/api\/orders\/([^/]+)\/(?:cancel|cancel\/signed|fill|hashlock)$/;

/**
 * Decides the lane from the path and the presented capability alone, so the
 * answer is available before the body is read. A request without a valid maker
 * token falls into the taker lane: keying the reserved headroom on the path
 * alone would let anyone reach it by naming a maker route.
 *
 * `matchesCapability` is the store's cheap comparison against the stored
 * commitment. It is passed in so this decision can be exercised without a
 * store, and so the module never reaches into one.
 */
export function admissionLane(
  path: string,
  makerToken: unknown,
  matchesCapability: (orderId: string, token: string) => boolean,
): AdmissionLane {
  if (path === SIGNED_CREATE_PATH) return "signed-create";
  const match = MAKER_ORDER_PATH_RE.exec(path);
  if (match === null) return "taker";
  if (typeof makerToken !== "string") return "taker";
  return matchesCapability(match[1] ?? "", makerToken) ? "maker" : "taker";
}

/** The share of `total` this lane may use, given the reservation inside it. */
export function laneCeiling(
  lane: AdmissionLane,
  total: number,
  reserved: number,
): number {
  if (lane === "maker") return total;
  const shared = total - reserved;
  // Half the reservation is the capability-authenticated floor, so a signed
  // create can use the rest of it and no more.
  return lane === "signed-create" ? shared + Math.floor(reserved / 2) : shared;
}

/**
 * Concurrent writes admitted at once, split into lanes. A release is
 * idempotent, so a caller may return its slot in a `finally` without tracking
 * whether it already did.
 */
export class InflightWriteBound {
  private active = 0;

  constructor(
    private readonly total: number,
    private readonly reserved: number,
  ) {
    if (!Number.isSafeInteger(total) || total < 1) {
      throw new Error("in-flight write bound must be a positive integer");
    }
    if (!Number.isSafeInteger(reserved) || reserved < 0 || reserved >= total) {
      throw new Error("in-flight write reservation must be below the bound");
    }
  }

  /** Writes admitted right now, across every lane. */
  get inFlight(): number {
    return this.active;
  }

  /** The ceiling this lane is held to. */
  ceilingFor(lane: AdmissionLane): number {
    return laneCeiling(lane, this.total, this.reserved);
  }

  /** Takes a slot for this lane, or returns null when its ceiling is reached. */
  acquire(lane: AdmissionLane): (() => void) | null {
    if (this.active >= this.ceilingFor(lane)) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}
