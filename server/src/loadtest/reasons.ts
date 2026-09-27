// Maps the book's rejection messages onto short, stable codes so results stay
// comparable across runs and the summary table stays readable.

const PATTERNS: ReadonlyArray<readonly [string, string]> = [
  ["rate limited, slow down", "http_per_ip_rate_limit"],
  ["too many requests in flight", "book_inflight_gate"],
  ["too many pending fill intents", "order_live_intent_cap"],
  ["too many retained fill intents", "order_retained_intent_cap"],
  ["already have fill requests in progress", "source_concurrent_cap"],
  ["daily fill intent limit reached", "source_daily_cap"],
  ["already have a pending fill request", "account_pending_intent"],
  ["nonce conflicts with another signed intent", "intent_nonce_conflict"],
  ["order is no longer open", "order_not_open"],
  ["order not found", "order_not_found"],
  ["order book is full", "book_open_capacity"],
  ["portable public-order capacity is full", "portable_capacity"],
  ["retained-state capacity is full", "retained_capacity"],
  ["too many open orders", "source_open_order_cap"],
  ["too many retained order artifacts", "source_retained_order_cap"],
  ["dated in the future", "clock_skew"],
  ["too little time left to swap safely", "insufficient_runway"],
  ["too many stream connections", "stream_capacity"],
  ["signature is invalid", "invalid_signature"],
  ["storage is unavailable", "storage_failure"],
  ["shutting down", "shutting_down"],
];

/** Reasons the book answers before the router reaches signature verification.
 *  The in-flight gate, the per-source HTTP limiter and the shutdown gate sit in
 *  front of every handler, and the fill-intent route sheds the refusals it can
 *  reach from the order row and the caller's address before it verifies, so all
 *  of these replies cost almost nothing to produce. A proposal whose nonce the
 *  order already retains skips that gate and is verified, so the state and
 *  capacity codes below are a shed for every new nonce and, for a replayed one,
 *  a full verification counted in the wrong bucket. */
const PRE_VERIFICATION_CODES = new Set([
  "book_inflight_gate",
  "http_per_ip_rate_limit",
  "shutting_down",
  "order_live_intent_cap",
  "source_concurrent_cap",
  "source_daily_cap",
  "order_not_open",
  "insufficient_runway",
]);

export function isPreVerificationShed(reason: string): boolean {
  return PRE_VERIFICATION_CODES.has(reason);
}

export function classifyReason(
  status: number,
  body: Record<string, unknown> | undefined,
  transportError?: string,
): string {
  if (transportError !== undefined) return `transport:${transportError}`;
  const message = body?.["error"];
  if (typeof message !== "string") return `status_${String(status)}`;
  for (const [needle, code] of PATTERNS) {
    if (message.includes(needle)) return code;
  }
  return `other:${message.slice(0, 48)}`;
}
