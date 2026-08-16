import { describe, expect, it, vi } from "vitest";
import type { OrderView } from "@/lib/orderbook";
import type { FillIntentView } from "@/lib/orderbookClient";
import {
  selectEarliestFillIntent,
  verifyTakerFill,
  withOrderSelectionLock,
} from "./signedOrderFlow";

const order = {
  id: "11".repeat(32),
  status: "open",
} as OrderView;

const candidate = (
  receivedAt: number,
  digest: string,
  issuedAt = receivedAt,
): FillIntentView =>
  ({
    intent: { orderDigest: digest },
    auth: { issuedAt },
    receivedAt,
    intentDigest: digest,
  }) as FillIntentView;

describe("signed order UI flow", () => {
  it("selects by signed time after issuance across mirror-local receive times", () => {
    const late = candidate(1, "0x03", 20);
    const tieB = candidate(30, "0x02", 10);
    const tieA = candidate(40, "0x01", 10);
    const future = candidate(0, "0x00", 31);
    const selected = selectEarliestFillIntent(order, [late, tieB, tieA, future], {
      now: 30,
      verify: (() => true) as never,
      digest: ((intent: { orderDigest: string }) => intent.orderDigest) as never,
    });
    expect(selected).toBe(tieA);
  });

  it("blocks funding after respondBy", () => {
    const recovery = {
      orderDigest: "0x01",
      intentDigest: "0x02",
      intent: { intent: {}, auth: {} },
    } as never;
    const filled = {
      ...order,
      status: "locking",
      orderDigest: "0x01",
      makerAuth: {},
      fill: {},
      fillAuth: { expiresAt: 50 },
      selectedIntent: { ...candidate(1, "0x02") },
    } as OrderView;
    expect(() => verifyTakerFill(filled, recovery, { now: 50 })).toThrow(
      "response deadline passed",
    );
  });

  it("uses a stable per-order Web Lock name", async () => {
    const callback = vi.fn(async () => "selected");
    const request = vi.fn(async (_name: string, run: () => Promise<string>) => run());
    await expect(
      withOrderSelectionLock("abc", callback, { request: request as never }),
    ).resolves.toBe("selected");
    expect(request).toHaveBeenCalledWith("quantaswap-fill-abc", callback);
  });

  it("fails closed when cross-tab selection locking is unavailable", async () => {
    const callback = vi.fn(async () => "unsafe");
    await expect(withOrderSelectionLock("abc", callback, null)).rejects.toThrow(
      /Web Locks are unavailable/,
    );
    expect(callback).not.toHaveBeenCalled();
  });
});
