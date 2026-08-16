import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHealthServer, MakerHealth } from "./health.js";

let server: Server | null = null;

afterEach(async () => {
  if (server === null) return;
  await new Promise<void>((resolve, reject) =>
    server?.close((err) => (err === undefined ? resolve() : reject(err))),
  );
  server = null;
});

describe("market maker health", () => {
  it("moves from starting to healthy after verification and a clean tick", () => {
    let now = 1_800_000_000_000;
    const health = new MakerHealth({
      deploymentFingerprint: "sha256:test",
      assets: ["ETH"],
      draining: false,
      staleAfterMs: 60_000,
      now: () => now,
    });
    assert.equal(health.snapshot().status, "starting");
    health.markRuntimeVerified();
    health.markTickStarted(1);
    now += 1_000;
    health.markTickCompleted(2, 0);
    assert.deepEqual(
      { status: health.snapshot().status, ready: health.snapshot().ready },
      { status: "ok", ready: true },
    );
    assert.equal(health.snapshot().managedOrders, 2);
  });

  it("degrades on tick errors and recovers after a clean tick", () => {
    let now = 1_800_000_000_000;
    const health = new MakerHealth({
      deploymentFingerprint: "sha256:test",
      assets: ["ETH"],
      draining: false,
      staleAfterMs: 60_000,
      now: () => now,
    });
    health.markRuntimeVerified();
    health.markTickStarted(0);
    health.markTickCompleted(0, 2);
    assert.equal(health.snapshot().status, "degraded");
    assert.equal(health.snapshot().consecutiveFailedTicks, 1);
    now += 1_000;
    health.markTickStarted(0);
    health.markTickCompleted(0, 0);
    assert.equal(health.snapshot().status, "ok");
    assert.equal(health.snapshot().consecutiveFailedTicks, 0);
  });

  it("degrades when a running tick stops making progress", () => {
    let now = 1_800_000_000_000;
    const health = new MakerHealth({
      deploymentFingerprint: "sha256:test",
      assets: ["ETH"],
      draining: false,
      staleAfterMs: 60_000,
      now: () => now,
    });
    health.markRuntimeVerified();
    health.markTickStarted(0);
    now += 60_001;
    assert.equal(health.snapshot().status, "degraded");
  });

  it("serves only sanitized health data and uses readiness status codes", async () => {
    const health = new MakerHealth({
      deploymentFingerprint: "sha256:test",
      assets: ["ETH", "USDC"],
      draining: true,
      staleAfterMs: 60_000,
    });
    server = createHealthServer(health);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const starting = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(starting.status, 503);
    health.markRuntimeVerified();
    health.markTickStarted(0);
    health.markTickCompleted(0, 0);
    const ready = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(ready.status, 200);
    const raw = await ready.text();
    assert.doesNotMatch(raw, /private|hexseed|rpc|address|balance|orderId/i);
    assert.match(raw, /"deploymentFingerprint":"sha256:test"/);
    assert.match(raw, /"draining":true/);
    const missing = await fetch(`http://127.0.0.1:${address.port}/other`);
    assert.equal(missing.status, 404);
  });
});
