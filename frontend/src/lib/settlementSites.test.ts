// @vitest-environment node
// Every call site that settles escrow has to carry the HTLCv3 gas buffer.
// This is a source-level guard because the bug it exists for was invisible in
// behaviour tests: a release sent with a bare estimate still succeeds, still
// emits Refunded, and still leaves the escrow terminal. It just credits the
// payee and leaves them to collect it, and the caller that cleared its record
// on "Refunded" then had no handle on the funds at all.
//
// Measured on the real HTLCv3 artifact on anvil: for claim, refund and
// release, a bare estimate and estimate * 1.3 both defer 100% of the time;
// estimate + 250000 delivers.
//
// The whole source tree is walked, so a new call site is covered the day it is
// written, and whitespace is collapsed first, so a call split over several
// lines is one string and cannot slip through the match.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry)) continue;
    out.push(path);
  }
  return out;
}

const read = (path: string): string => readFileSync(path, "utf8");

/** One logical statement per entry, whitespace collapsed, so a call written
 *  over several lines is matched as one string. */
function statements(source: string): string[] {
  return source
    .split(";")
    .map((chunk) => chunk.replace(/\s+/g, " ").trim())
    .filter((chunk) => chunk !== "");
}

/** Calldata builders whose transaction moves settled value. */
const SETTLEMENT_BUILDERS = [
  "buildClaimData",
  "buildRefundData",
  "buildReleaseData",
  "buildWithdrawAllData",
  "buildWithdrawData",
  "buildPushCreditData",
];

/** Senders that apply no buffer. A settlement builder must never reach one. */
const PLAIN_SENDERS = ["sendOnLeg", "sendLeg", "makeLegSender"];

const FILES = sourceFiles(SRC);

describe("settlement call sites", () => {
  it("walks the whole source tree", () => {
    // A hardcoded file list stops covering the code the day someone adds a
    // component, which is exactly when this guard is needed.
    expect(FILES.length).toBeGreaterThan(30);
    expect(FILES.some((path) => path.endsWith("SwapFlow.tsx"))).toBe(true);
    expect(FILES.some((path) => path.endsWith("PostOrderCard.tsx"))).toBe(true);
    expect(FILES.some((path) => path.endsWith("MyOrderCard.tsx"))).toBe(true);
  });

  it.each(FILES.map((path) => [path.slice(SRC.length), path]))(
    "%s sends settlement calldata through a buffered sender",
    (_label, path) => {
      for (const statement of statements(read(path))) {
        const builder = SETTLEMENT_BUILDERS.find((name) => statement.includes(`${name}(`));
        if (builder === undefined) continue;
        if (/^(import|export (const|function|type)|\/\/)/.test(statement)) continue;
        const plain = PLAIN_SENDERS.find((sender) => statement.includes(`${sender}(`));
        expect(
          plain,
          `${path}: ${builder} is sent through ${String(plain)}, which carries no HTLCv3 gas buffer, so the payout defers into a credit. Use the settlement sender.`,
        ).toBeUndefined();
      }
    },
  );

  it("pins the senders that do and do not buffer", () => {
    const sender = read(join(SRC, "lib/legSender.ts"));
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
      const found = statements(read(join(SRC, file))).filter((statement) =>
        statement.includes("buildReleaseData("),
      );
      expect(found.length, `${file} should still release an escrow`).toBeGreaterThan(0);
      for (const statement of found) expect(statement).toContain("settleOnLeg");
    }
  });
});
