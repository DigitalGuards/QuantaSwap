import { describe, expect, it } from "vitest";
import { NATIVE_TOKEN, SwapStatus, type LegState, type SwapStatusValue } from "./htlc";
import { deriveVerdict, HASHLOCK_RE } from "./swapStatus";

const leg = (status: SwapStatusValue): LegState => ({
  status,
  initiator: "0x1111111111111111111111111111111111111111",
  recipient: "0x2222222222222222222222222222222222222222",
  token: NATIVE_TOKEN,
  amount: 10n ** 18n,
  timeout: 2_000_000_000,
  preimage: `0x${"0".repeat(64)}`,
});

describe("deriveVerdict", () => {
  it("celebrates a fully claimed swap", () => {
    const v = deriveVerdict(leg(SwapStatus.Claimed), leg(SwapStatus.Claimed));
    expect(v.tone).toBe("success");
    expect(v.headline).toMatch(/complete/i);
  });

  it("marks a revealed secret with one claim outstanding", () => {
    const v = deriveVerdict(leg(SwapStatus.Claimed), leg(SwapStatus.Open));
    expect(v.tone).toBe("pending");
    expect(v.headline).toMatch(/secret revealed/i);
  });

  it("is symmetric across legs", () => {
    expect(deriveVerdict(leg(SwapStatus.Open), leg(SwapStatus.Claimed))).toEqual(
      deriveVerdict(leg(SwapStatus.Claimed), leg(SwapStatus.Open)),
    );
  });

  it("flags a claim/refund split", () => {
    const v = deriveVerdict(leg(SwapStatus.Claimed), leg(SwapStatus.Refunded));
    expect(v.tone).toBe("warn");
  });

  it("waits while both legs are escrowed", () => {
    const v = deriveVerdict(leg(SwapStatus.Open), leg(SwapStatus.Open));
    expect(v.tone).toBe("pending");
    expect(v.headline).toMatch(/both legs/i);
  });

  it("waits for the counterparty when one leg is escrowed", () => {
    const v = deriveVerdict(leg(SwapStatus.Open), leg(SwapStatus.None));
    expect(v.tone).toBe("pending");
    expect(v.detail).toMatch(/counterparty/i);
  });

  it("warns on refund with an escrow still open", () => {
    const v = deriveVerdict(leg(SwapStatus.Refunded), leg(SwapStatus.Open));
    expect(v.tone).toBe("warn");
  });

  it("reports expiry for refunded swaps", () => {
    expect(deriveVerdict(leg(SwapStatus.Refunded), leg(SwapStatus.Refunded)).headline).toMatch(
      /expired/i,
    );
    expect(deriveVerdict(leg(SwapStatus.Refunded), leg(SwapStatus.None)).tone).toBe("neutral");
  });

  it("reports an unknown hash cleanly", () => {
    const v = deriveVerdict(leg(SwapStatus.None), leg(SwapStatus.None));
    expect(v.tone).toBe("neutral");
    expect(v.headline).toMatch(/no swap found/i);
  });

  it("degrades to a partial verdict when an RPC is down", () => {
    expect(deriveVerdict(null, leg(SwapStatus.Claimed)).headline).toMatch(/incomplete/i);
    expect(deriveVerdict(null, leg(SwapStatus.Claimed)).detail).toMatch(/QRL v2/);
    expect(deriveVerdict(leg(SwapStatus.Open), null).detail).toMatch(/Sepolia/);
    expect(deriveVerdict(null, null).detail).toMatch(/either chain/i);
  });
});

describe("HASHLOCK_RE", () => {
  it("accepts a 32-byte hex hash and rejects everything else", () => {
    expect(HASHLOCK_RE.test(`0x${"ab".repeat(32)}`)).toBe(true);
    expect(HASHLOCK_RE.test(`0x${"ab".repeat(31)}`)).toBe(false);
    expect(HASHLOCK_RE.test(`${"ab".repeat(32)}`)).toBe(false);
    expect(HASHLOCK_RE.test(`0x${"zz".repeat(32)}`)).toBe(false);
  });
});
