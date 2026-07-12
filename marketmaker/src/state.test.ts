// Hydration back-compat: fields added after launch must default so
// pre-upgrade in-flight records keep settling after a restart. `asset`
// in particular must default to native ETH, or old swaps would be
// verified against the wrong expected token.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateFile } from "./state.js";

function withStateFile(records: unknown[], run: (state: StateFile) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "mm-state-test-"));
  try {
    const file = join(dir, "state.json");
    writeFileSync(file, JSON.stringify(records), "utf8");
    run(new StateFile(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const preUpgradeRecord = {
  id: "order-1",
  token: "bearer-auth-token",
  direction: "eth->qrl",
  fromAmount: "20000000000000000",
  toAmount: "2000000000000000000",
  preimage: null,
  hashlock: null,
  initiatorTimeout: null,
  responderTimeout: null,
  takerEthAccount: null,
  takerQrlAccount: null,
  lockSentAt: null,
  claimSentAt: null,
  refundSentAt: null,
  createdAt: 1_800_000_000,
};

describe("state hydration", () => {
  it("defaults asset to ETH on pre-stable-pairs records", () => {
    withStateFile([preUpgradeRecord], (state) => {
      const orders = state.all();
      assert.equal(orders.length, 1);
      assert.equal(orders[0]?.asset, "ETH");
      // The sibling back-compat defaults still apply alongside it.
      assert.equal(orders[0]?.level, 0);
      assert.equal(orders[0]?.quotedMidMilli, null);
      assert.equal(orders[0]?.announcedAt, null);
    });
  });

  it("keeps an explicit asset on post-upgrade records", () => {
    withStateFile([{ ...preUpgradeRecord, id: "order-2", asset: "USDC" }], (state) => {
      assert.equal(state.all()[0]?.asset, "USDC");
    });
  });
});
