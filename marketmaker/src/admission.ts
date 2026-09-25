import type { ManagedOrder } from "./policy.js";

// Keep headroom below the book's unchanged 64-row public/maker/source bounds.
export const LOCAL_RETAINED_ORDER_BUDGET = 60;
export const SIGNED_ORDER_RETENTION_GRACE_S = 5 * 60;
export const FILLED_ORDER_LINGER_S = 24 * 3600;
export const DEFAULT_ORDER_LIFETIME_S = 5 * 60;

export interface AdmissionRecord {
  id: string;
  retainUntil: number;
}

/** A pure unfunded quote expires by its own signed deadline, independently
 * of an untrusted mirror's automatic cancellation projection. */
export function canRetireExpiredUnfundedQuote(order: ManagedOrder, now: number): boolean {
  const protocol = order.protocol;
  return protocol !== undefined && protocol.orderAuth.expiresAt <= now &&
    protocol.selectedIntent === undefined && protocol.fillProof === undefined &&
    protocol.cancelProof === undefined && protocol.fillAcknowledged !== true &&
    protocol.releaseObserved !== true &&
    protocol.order.prelock === undefined && order.preimage === null &&
    order.hashlock === null && order.initiatorTimeout === null &&
    order.responderTimeout === null && order.announcedAt === null &&
    order.takerEthAccount === null && order.takerQrlAccount === null &&
    order.lockSentAt === null &&
    order.claimSentAt === null && order.refundSentAt === null;
}

/** Retention is accounting only. It never authorizes settlement or rewrites a proof. */
export function orderRetentionUntil(order: ManagedOrder, now: number): number | null {
  const protocol = order.protocol;
  if (protocol === undefined) return null;
  let until = protocol.orderAuth.expiresAt + SIGNED_ORDER_RETENTION_GRACE_S + 1;
  if (protocol.cancelProof !== undefined) {
    until = Math.max(until, now + SIGNED_ORDER_RETENTION_GRACE_S + 1);
  }
  if (protocol.fillProof !== undefined) {
    until = Math.max(until, protocol.fillProof.fill.initiatorTimeout + FILLED_ORDER_LINGER_S + 1);
  }
  return until;
}

export function parseAdmissionRecords(raw: unknown): AdmissionRecord[] {
  if (!Array.isArray(raw) || raw.length > 256) throw new Error("admission history is malformed");
  const ids = new Set<string>();
  return raw.map((item: unknown) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("admission record is malformed");
    }
    const row = item as Record<string, unknown>;
    if (Object.keys(row).length !== 2 || typeof row.id !== "string" ||
      !/^[0-9a-f]{64}$/.test(row.id) || ids.has(row.id) ||
      typeof row.retainUntil !== "number" || !Number.isSafeInteger(row.retainUntil) ||
      row.retainUntil <= 0) throw new Error("admission record is malformed");
    ids.add(row.id);
    return { id: row.id, retainUntil: row.retainUntil };
  });
}

/** One shared bounded delay prevents every pending quote retrying each tick. */
export class AdmissionBackoff {
  private failures = 0;
  private retryAt = 0;

  canAttempt(now: number): boolean { return now >= this.retryAt; }
  nextAttemptAt(): number { return this.retryAt; }
  failed(now: number): void {
    this.failures = Math.min(this.failures + 1, 6);
    this.retryAt = now + Math.min(300, 15 * 2 ** (this.failures - 1));
  }
  succeeded(): void { this.failures = 0; this.retryAt = 0; }
}
