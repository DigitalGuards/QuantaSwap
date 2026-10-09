import { isRecord } from "./guards.js";
const port = Number(process.env.MM_HEALTH_PORT ?? "8092");

try {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(3_000),
  });
  const body: unknown = await response.json();
  if (!response.ok || !isRecord(body) || body.status !== "ok")
    process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
