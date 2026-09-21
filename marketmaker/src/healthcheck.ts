const port = Number(process.env.MM_HEALTH_PORT ?? "8092");

try {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(3_000),
  });
  const body = (await response.json()) as { status?: unknown };
  if (!response.ok || body.status !== "ok") process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
