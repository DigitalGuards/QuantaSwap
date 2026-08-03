// Deployment binding is a hard safety boundary. A state file can carry
// both a live preimage and a hashlock already funded on its original HTLC,
// so startup must never reinterpret it under replacement contracts.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDeploymentIdentity, type DeploymentIdentity } from "./deployment.js";
import { StateFile } from "./state.js";

const DEPLOYMENT = makeDeploymentIdentity({
  ethChainId: "11155111",
  qrlChainId: "1337",
  ethHtlc: `0x${"1".repeat(40)}`,
  qrlHtlc: `Q${"2".repeat(40)}`,
});
const OTHER_DEPLOYMENT = makeDeploymentIdentity({
  ethChainId: "11155111",
  qrlChainId: "1337",
  ethHtlc: `0x${"3".repeat(40)}`,
  qrlHtlc: `Q${"4".repeat(40)}`,
});

const preFieldRecord = {
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

const envelope = (
  orders: unknown[],
  deployment: DeploymentIdentity = DEPLOYMENT,
): Record<string, unknown> => ({ version: 1, deployment, orders });

function withStateFile(
  contents: unknown,
  run: (state: StateFile, file: string) => void,
  deployment: DeploymentIdentity = DEPLOYMENT,
): void {
  const dir = mkdtempSync(join(tmpdir(), "mm-state-test-"));
  try {
    const file = join(dir, "state.json");
    writeFileSync(file, JSON.stringify(contents), "utf8");
    run(new StateFile(file, deployment), file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertRefusedWithoutMutation(
  contents: unknown,
  pattern: RegExp,
  deployment: DeploymentIdentity = DEPLOYMENT,
): void {
  const dir = mkdtempSync(join(tmpdir(), "mm-state-test-"));
  try {
    const file = join(dir, "state.json");
    const before = JSON.stringify(contents);
    writeFileSync(file, before, "utf8");
    assert.throws(() => new StateFile(file, deployment), pattern);
    assert.equal(readFileSync(file, "utf8"), before, "recovery state must remain byte-for-byte intact");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("deployment-bound state hydration", () => {
  it("keeps field-level upgrade defaults inside a correctly bound deployment", () => {
    withStateFile(envelope([{ ...preFieldRecord, deployment: DEPLOYMENT }]), (state) => {
      const orders = state.all();
      assert.equal(orders.length, 1);
      assert.equal(orders[0]?.asset, "ETH");
      assert.equal(orders[0]?.level, 0);
      assert.equal(orders[0]?.quotedMidMilli, null);
      assert.equal(orders[0]?.announcedAt, null);
      assert.deepEqual(orders[0]?.deployment, DEPLOYMENT);
    });
  });

  it("keeps an explicit asset on a bound record", () => {
    withStateFile(
      envelope([{ ...preFieldRecord, id: "order-2", asset: "USDC", deployment: DEPLOYMENT }]),
      (state) => assert.equal(state.all()[0]?.asset, "USDC"),
    );
  });

  it("migrates only an empty legacy array to the bound envelope", () => {
    withStateFile([], (state, file) => {
      assert.deepEqual(state.all(), []);
      const persisted = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      assert.equal(persisted.version, 1);
      assert.deepEqual(persisted.deployment, DEPLOYMENT);
      assert.deepEqual(persisted.orders, []);
    });
  });

  it("refuses non-empty legacy state and preserves it for manual recovery", () => {
    assertRefusedWithoutMutation(
      [preFieldRecord],
      /non-empty legacy state has no deployment identity.*left untouched/s,
    );
  });

  it("refuses a state envelope from another HTLC pair without mutating it", () => {
    assertRefusedWithoutMutation(
      envelope([{ ...preFieldRecord, deployment: OTHER_DEPLOYMENT }], OTHER_DEPLOYMENT),
      /deployment fingerprint.*does not match configured.*left untouched/s,
    );
  });

  it("refuses an order whose identity differs from its state envelope", () => {
    assertRefusedWithoutMutation(
      envelope([{ ...preFieldRecord, deployment: OTHER_DEPLOYMENT }]),
      /belongs to another deployment.*left untouched/s,
    );
  });

  it("refuses a bound record with an unknown asset", () => {
    assertRefusedWithoutMutation(
      envelope([{ ...preFieldRecord, asset: "DOGE", deployment: DEPLOYMENT }]),
      /unknown asset.*left untouched/s,
    );
  });

  it("refuses cross-deployment upserts", () => {
    withStateFile(envelope([{ ...preFieldRecord, deployment: DEPLOYMENT }]), (state, file) => {
      const order = state.all()[0];
      assert.ok(order);
      const before = readFileSync(file, "utf8");
      assert.throws(
        () => state.upsert({ ...order, deployment: OTHER_DEPLOYMENT }),
        /belongs to another deployment.*left untouched/s,
      );
      assert.equal(readFileSync(file, "utf8"), before);
    });
  });

  it("refuses to start on malformed JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-test-"));
    try {
      const file = join(dir, "state.json");
      writeFileSync(file, "{not json", "utf8");
      assert.throws(() => new StateFile(file, DEPLOYMENT));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
