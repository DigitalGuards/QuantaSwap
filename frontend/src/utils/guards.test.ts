import { describe, expect, expectTypeOf, it } from "vitest";
import { isArray, isRecord } from "./guards";
import { isProviderDetail } from "@/lib/providerGuards";

describe("untrusted container guards", () => {
  it("keeps array elements unknown until individually checked", () => {
    const value: unknown = ["account", null, 3];
    expect(isArray(value)).toBe(true);
    if (isArray(value)) expectTypeOf(value).toEqualTypeOf<unknown[]>();
    expect(isRecord(value)).toBe(false);
    expect(isArray({ length: 1, 0: "account" })).toBe(false);
    expect(isRecord(null)).toBe(false);
  });

  it("validates announcement metadata and optional provider capabilities", () => {
    const info = { uuid: "wallet", name: "Wallet", rdns: "wallet.test", icon: "" };
    const provider = { request: () => Promise.resolve<unknown>([]) };
    expect(isProviderDetail({ info, provider })).toBe(true);
    for (const value of [
      null,
      {},
      { info },
      { info: { ...info, icon: [] }, provider },
      { info, provider: { ...provider, on: "invalid" } },
    ]) {
      expect(isProviderDetail(value)).toBe(false);
    }
  });
});
