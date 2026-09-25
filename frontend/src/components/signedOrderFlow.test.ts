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
  const select = (candidates: FillIntentView[], now: number) =>
    selectEarliestFillIntent(order, candidates, {
      now,
      verify: (() => true) as never,
      digest: ((intent: { orderDigest: string }) => intent.orderDigest) as never,
    });

  it("selects the proposal that reached the book first", () => {
    const first = candidate(12, "0x03", 11);
    const second = candidate(20, "0x01", 19);
    const future = candidate(0, "0x00", 31);
    expect(select([second, future, first], 30)).toBe(first);
  });

  it("gives a backdated issuance no priority over an earlier arrival", () => {
    const honest = candidate(10, "0x02", 8);
    const backdated = candidate(25, "0x01", -90);
    expect(select([backdated, honest], 30)).toBe(honest);
  });

  it("falls back to issuance when a book under-reports arrival", () => {
    const early = candidate(0, "0x02", 10);
    const late = candidate(0, "0x01", 20);
    expect(select([late, early], 30)).toBe(early);
  });

  it("breaks full ties by the semantic digest", () => {
    const high = candidate(10, "0x02", 10);
    const low = candidate(10, "0x01", 10);
    expect(select([high, low], 30)).toBe(low);
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
