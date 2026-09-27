// Maps the book's rejection messages onto short, stable codes so results stay
// comparable across runs and the summary table stays readable.

const PATTERNS: ReadonlyArray<readonly [string, string]> = [
  ["rate limited, slow down", "http_per_ip_rate_limit"],
  ["too many requests in flight", "book_inflight_gate"],
  ["too many request bodies in flight", "book_body_read_gate"],
  ["request body was too slow", "body_read_timeout"],
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

/**
 * Whether the book answered this refusal before it verified anything. The
 * service says so itself in the `X-Refusal-Stage` response header, on the
 * in-flight gate, the body-read bound, the per-source limiter, the shutdown
 * gate and every refusal the fill-intent route reaches from the stored order
 * and the caller's address. Reading the header keeps the split exact: the same
 * message can be a cheap shed for a new nonce and a fully verified refusal for
 * a proposal the order already retains.
 */
export function isPreVerificationShed(reply: {
  refusalStage?: string;
}): boolean {
  return reply.refusalStage === "pre-verification";
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
