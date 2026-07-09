/** Human-readable message from anything a wallet/provider can throw.
 *  Injected providers reject with plain objects ({ code, message, data }),
 *  sometimes nesting the real cause under data; String() on those renders
 *  "[object Object]". */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    const rec = err as { message?: unknown; data?: { message?: unknown } };
    if (typeof rec.data?.message === "string" && rec.data.message) return rec.data.message;
    if (typeof rec.message === "string" && rec.message) return rec.message;
    try {
      return JSON.stringify(err);
    } catch {
      return "Unknown wallet error";
    }
  }
  return String(err);
}
