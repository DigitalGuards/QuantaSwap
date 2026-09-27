// Every call site that settles escrow has to carry the HTLCv3 gas buffer.
// This is a source-level guard because the bug it exists for was invisible in
// behaviour tests: a release sent with a bare estimate still succeeds, still
// emits Refunded, and still leaves the escrow terminal. It just credits the
// payee instead of paying them, and the caller that cleared its record on
// "Refunded" then had no handle on the funds at all.
//
// Measured on the real HTLCv3 artifact on anvil: for claim, refund and
// release, a bare estimate and estimate * 1.3 both defer 100% of the time;
// estimate + 250000 delivers.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** Calldata builders whose transaction moves settled value. */
const SETTLEMENT_BUILDERS = [
  "buildClaimData",
  "buildRefundData",
  "buildReleaseData",
  "buildWithdrawAllData",
  "buildWithdrawData",
  "buildPushCreditData",
];

/** Senders that do not apply the buffer. A settlement builder must never be
 *  handed to one of these. */
const PLAIN_SENDERS = ["sendOnLeg", "sendLeg", "send("];

const CALL_SITES = [
  "components/SwapFlow.tsx",
  "components/PostOrderCard.tsx",
  "components/MyOrderCard.tsx",
  "components/DeferredPayoutPanel.tsx",
  "components/AwaitHashlock.tsx",
  "pages/SwapPage.tsx",
  "pages/PrivateOrderPage.tsx",
  "pages/SwapStatusPage.tsx",
];

describe("settlement call sites", () => {
  it.each(CALL_SITES)("%s sends settlement calldata through a buffered sender", (file) => {
    const source = read(file);
    for (const line of source.split("\n")) {
      const builder = SETTLEMENT_BUILDERS.find((name) => line.includes(`${name}(`));
      if (builder === undefined) continue;
      // Import lines and the builders' own declarations are not call sites.
      if (/^\s*(import|export|\*|\/\/)/.test(line)) continue;
      const plain = PLAIN_SENDERS.find((sender) => line.includes(sender));
      expect(
        plain,
        `${file}: ${builder} is sent through ${String(plain)}, which carries no HTLCv3 gas buffer, so the payout defers into a credit. Use the settlement sender.`,
      ).toBeUndefined();
    }
  });

  it("pins the senders that do and do not buffer", () => {
    const sender = read("lib/legSender.ts");
    // makeLegSender is for locks and approvals: no buffer, by design.
    expect(sender).toMatch(/export const makeLegSender/);
    expect(sender).toMatch(/export const makeSettlementSender/);
    expect(sender).toMatch(/export const makePreflightedClaimSender/);
    // Both buffered senders must reach the shared rule, on every transport.
    const settlement = sender.slice(sender.indexOf("export const makeSettlementSender"));
    expect(settlement).toMatch(/settlementGasLimit\(/);
    expect(settlement).toMatch(/estimateQrlSettlementGas\(/);
  });

  it("keeps release on the settlement path in both order views", () => {
    // The two sites the reviewer found sending release() unbuffered.
    for (const file of ["components/PostOrderCard.tsx", "components/MyOrderCard.tsx"]) {
      const source = read(file);
      const releaseLines = source
        .split("\n")
        .filter((line) => line.includes("buildReleaseData(") && !line.startsWith("import"));
      expect(releaseLines.length, `${file} should still release an escrow`).toBeGreaterThan(0);
      for (const line of releaseLines) expect(line).toContain("settleOnLeg");
    }
  });
});
