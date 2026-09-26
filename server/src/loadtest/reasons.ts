// Maps the book's rejection messages onto short, stable codes so results stay
// comparable across runs and the summary table stays readable.

const PATTERNS: ReadonlyArray<readonly [string, string]> = [
  ["rate limited, slow down", "http_per_ip_rate_limit"],
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
