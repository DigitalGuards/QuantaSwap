// Narrow CORS policy for browser-facing mirrors. Public snapshots, streams,
// and federation feeds contain only public signed data and may use wildcard
// reads. Mutations and capability-gated reads require an exact configured
// origin. Cookies and credentialed CORS are never enabled.

export type CorsMode = "public-read" | "configured-origin";

export function corsHeaders(
  origin: string | undefined,
  mode: CorsMode,
  allowedOrigins: readonly string[],
): Record<string, string> {
  if (mode === "public-read") return { "Access-Control-Allow-Origin": "*" };
  if (origin === undefined || !allowedOrigins.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    // A browser cannot read either header off a cross-origin response without
    // this. The mutating routes answer 503 with Retry-After when the book
    // sheds, and X-Refusal-Stage says the refusal was produced before any
    // verification, which is what makes it safe to retry.
    "Access-Control-Expose-Headers": "Retry-After, X-Refusal-Stage",
    Vary: "Origin",
  };
}

export function preflightHeaders(
  origin: string | undefined,
  requestedMethod: string | undefined,
  requestedHeaders: string | undefined,
  allowedOrigins: readonly string[],
): Record<string, string> | null {
  if (
    origin === undefined ||
    !allowedOrigins.includes(origin) ||
    requestedMethod === undefined ||
    !["GET", "POST"].includes(requestedMethod.toUpperCase())
  ) {
    return null;
  }
  const allowedHeaderNames = new Set(["content-type", "x-share-token", "x-maker-token"]);
  const headers = (requestedHeaders ?? "")
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter((header) => header !== "");
  if (headers.some((header) => !allowedHeaderNames.has(header))) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Share-Token, X-Maker-Token",
    "Access-Control-Max-Age": "600",
    Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
  };
}
