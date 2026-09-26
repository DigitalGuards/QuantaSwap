// Deployment binding is a hard safety boundary. A state file can carry
// both a live preimage and a hashlock already funded on its original HTLC,
// so startup must never reinterpret it under replacement contracts.

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import type { ManagedOrder } from "./policy.js";
import { canRetireExpiredUnfundedQuote, LOCAL_RETAINED_ORDER_BUDGET } from "./admission.js";
import {
  makeDeploymentIdentity,
  type DeploymentIdentity,
} from "./deployment.js";
import {
  V2_TEST_EXTENDED_SEED,
  protocolV2Identity,
  signProtocolV2Auth,
} from "./protocol-v2-test-helper.js";
import {
  EMPTY_CAPABILITY_COMMITMENT,
  MAKER_CAPABILITY_DOMAIN,
  buildCancelV1Payload,
  buildFillIntentV1Payload,
  buildFillV1Payload,
  buildOrderV1Payload,
  capabilityCommitment,
  computeFillIntentDigest,
  computeOrderDigest,
  deriveOrderV1Id,
  type CanonicalOrderV1Body,
  type MakerOrderAuthV1,
  type ProtocolAuthV1,
} from "./protocol-signing.js";
import {
  LEASE_TTL_MS,
  StateFile,
  StateFilePoisonedError,
  StateLeaseLostError,
  StateLeaseUnverifiableError,
  StateProcessLease,
} from "./state.js";

const DEPLOYMENT = makeDeploymentIdentity({
  ethChainId: "11155111",
  qrlChainId: "1337",
  ethHtlc: `0x${"1".repeat(40)}`,
  qrlHtlc: `Q${"2".repeat(128)}`,
});
const OTHER_DEPLOYMENT = makeDeploymentIdentity({
  ethChainId: "11155111",
  qrlChainId: "1337",
  ethHtlc: `0x${"3".repeat(40)}`,
  qrlHtlc: `Q${"4".repeat(128)}`,
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

const EXTENDED_SEED = V2_TEST_EXTENDED_SEED;
const ORDER_NONCE = `0x${"42".repeat(32)}`;
const MAKER_TOKEN = "ab".repeat(32);
const LEGACY_IDENTITY = protocolV2Identity(EXTENDED_SEED);

function portableOpenRecord(
  orderExpiresAt = preFieldRecord.createdAt + 3600,
  nonce = ORDER_NONCE,
): Record<string, unknown> {
  const order: CanonicalOrderV1Body = {
    direction: "eth->qrl",
    asset: "ETH",
    fromAmount: preFieldRecord.fromAmount,
    toAmount: preFieldRecord.toAmount,
    makerEthAccount: `0x${"1".repeat(40)}`,
    makerQrlAccount: LEGACY_IDENTITY.currentAddress,
    visibility: "public",
  };
  const unsignedAuth = {
    issuedAt: preFieldRecord.createdAt,
    expiresAt: orderExpiresAt,
    nonce,
    makerTokenCommitment: capabilityCommitment(
      MAKER_CAPABILITY_DOMAIN,
      MAKER_TOKEN,
    ),
    shareTokenCommitment: EMPTY_CAPABILITY_COMMITMENT,
  };
  const orderAuth: MakerOrderAuthV1 = {
    ...signProtocolV2Auth(
      buildOrderV1Payload(order, unsignedAuth),
      "qrl-sign-message-v2",
      unsignedAuth,
      EXTENDED_SEED,
    ),
    makerTokenCommitment: unsignedAuth.makerTokenCommitment,
    shareTokenCommitment: unsignedAuth.shareTokenCommitment,
  };
  return {
    ...preFieldRecord,
    id: deriveOrderV1Id(order.makerQrlAccount, orderAuth.nonce),
    token: MAKER_TOKEN,
    asset: "ETH",
    level: 0,
    quotedMidMilli: "100000",
    announcedAt: null,
    deployment: DEPLOYMENT,
    protocol: {
      version: 2,
      orderDigest: computeOrderDigest(order, orderAuth),
      order,
      orderAuth,
    },
  };
}

function portableFillRecord(
  options: { orderExpiresAt?: number; fillRespondBy?: number } = {},
): Record<string, unknown> {
  const open = portableOpenRecord(options.orderExpiresAt);
  const protocol = open.protocol as Record<string, unknown>;
  const orderDigest = protocol.orderDigest as string;
  const intent = {
    orderDigest,
    takerEthAccount: `0x${"2".repeat(40)}`,
    takerQrlAccount: LEGACY_IDENTITY.currentAddress,
    releaseCommitment: `0x${"3".repeat(64)}`,
  };
  const unsignedIntentAuth = {
    issuedAt: preFieldRecord.createdAt + 10,
    expiresAt: preFieldRecord.createdAt + 110,
    nonce: `0x${"43".repeat(32)}`,
  };
  const intentAuth: ProtocolAuthV1 = signProtocolV2Auth(
    buildFillIntentV1Payload(intent, unsignedIntentAuth),
    "qrl-sign-message-v2",
    unsignedIntentAuth,
    EXTENDED_SEED,
  );
  const selectedIntent = {
    intentDigest: computeFillIntentDigest(intent, intentAuth),
    intent,
    auth: intentAuth,
    receivedAt: preFieldRecord.createdAt + 11,
  };
  const preimage = `0x${"4".repeat(64)}`;
  const hashlock = `0x${createHash("sha256")
    .update(Buffer.from(preimage.slice(2), "hex"))
    .digest("hex")}`;
  const initiatorTimeout = preFieldRecord.createdAt + 7200;
  const responderTimeout = preFieldRecord.createdAt + 3600;
  const orderAuth = protocol.orderAuth as MakerOrderAuthV1;
  const fill = {
    orderDigest,
    intentDigest: selectedIntent.intentDigest,
    takerEthAccount: intent.takerEthAccount,
    takerQrlAccount: intent.takerQrlAccount,
    releaseCommitment: intent.releaseCommitment,
    hashlock,
    initiatorTimeout,
    responderTimeout,
  };
  const unsignedFillAuth = {
    issuedAt: preFieldRecord.createdAt + 20,
    expiresAt: options.fillRespondBy ?? preFieldRecord.createdAt + 320,
    nonce: `0x${"44".repeat(32)}`,
  };
  const fillProof = {
    fill,
    auth: signProtocolV2Auth(
      buildFillV1Payload(fill, orderAuth, unsignedFillAuth),
      "qrl-sign-message-v2",
      unsignedFillAuth,
      EXTENDED_SEED,
    ),
  };
  return {
    ...open,
    preimage,
    hashlock,
    initiatorTimeout,
    responderTimeout,
    announcedAt: preFieldRecord.createdAt + 20,
    takerEthAccount: intent.takerEthAccount,
    takerQrlAccount: intent.takerQrlAccount,
    protocol: { ...protocol, selectedIntent, fillProof },
  };
}

function portableCancelRecord(): Record<string, unknown> {
  const open = portableOpenRecord();
  const protocol = open.protocol as Record<string, unknown>;
  const orderAuth = protocol.orderAuth as MakerOrderAuthV1;
  const cancel = { orderDigest: protocol.orderDigest as string, reasonCode: 1 };
  const unsignedCancelAuth = {
    issuedAt: preFieldRecord.createdAt + 20,
    expiresAt: orderAuth.expiresAt,
    nonce: `0x${"45".repeat(32)}`,
  };
  const cancelProof = {
    cancel,
    auth: signProtocolV2Auth(
      buildCancelV1Payload(cancel, orderAuth, unsignedCancelAuth),
      "qrl-sign-message-v2",
      unsignedCancelAuth,
      EXTENDED_SEED,
    ),
  };
  return { ...open, protocol: { ...protocol, cancelProof } };
}

const envelope = (
  orders: unknown[],
  deployment: DeploymentIdentity = DEPLOYMENT,
): Record<string, unknown> => ({ version: 1, deployment, orders });

describe("durable quote retention accounting", () => {
  it("retires a pure quote at its signed expiry while retaining its admission slot", (t) => {
    let now = preFieldRecord.createdAt;
    t.mock.method(Date, "now", () => now * 1000);
    withStateFile(envelope([portableOpenRecord(now + 300)]), (state, file) => {
      now += 300;
      const quote = state.all()[0]!;
      assert.equal(canRetireExpiredUnfundedQuote(quote, now), true);
      state.delete(quote.id);
      const restarted = new StateFile(file, DEPLOYMENT);
      assert.equal(restarted.all().length, 0);
      assert.equal(restarted.retainedAdmissionCount(now), 1);
      assert.equal(restarted.retainedAdmissionCount(now + 300), 1);
      assert.equal(restarted.retainedAdmissionCount(now + 301), 0);
    });
  });
  it("bounds rapid repricing across terminal cleanup and a restart", (t) => {
    let now = preFieldRecord.createdAt;
    t.mock.method(Date, "now", () => now * 1000);
    withStateFile(envelope([]), (state, file) => {
      for (let quote = 0; quote < LOCAL_RETAINED_ORDER_BUDGET; quote++) {
        assert.ok(state.retainedAdmissionCount(now) < LOCAL_RETAINED_ORDER_BUDGET);
        const nonce = `0x${quote.toString(16).padStart(64, "0")}`;
        const row = portableOpenRecord(now + 300, nonce) as unknown as ManagedOrder;
        state.upsert(row);
        state.delete(row.id);
      }
      assert.equal(state.all().length, 0);
      assert.equal(state.retainedAdmissionCount(now), 60);
      const restarted = new StateFile(file, DEPLOYMENT);
      assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 2);
      assert.equal(restarted.retainedAdmissionCount(now), 60);
      now += 600;
      assert.equal(restarted.retainedAdmissionCount(now), 60);
      now += 1;
      assert.equal(restarted.retainedAdmissionCount(now), 0);
      const row = portableOpenRecord(now + 300) as unknown as ManagedOrder;
      restarted.upsert(row);
      assert.equal(JSON.parse(readFileSync(file, "utf8")).admissions.length, 1);
    });
  });

  it("keeps exact pending proofs and reserves a single slot on every retry", (t) => {
    const now = preFieldRecord.createdAt;
    t.mock.method(Date, "now", () => now * 1000);
    const original = portableOpenRecord(now + 300);
    withStateFile(envelope([original]), (state, file) => {
      const row = state.all()[0]!;
      for (let retry = 0; retry < 10; retry++) state.upsert(row);
      const restarted = new StateFile(file, DEPLOYMENT);
      assert.equal(restarted.retainedAdmissionCount(now), 1);
      assert.deepEqual(restarted.all()[0]!.protocol, row.protocol);
      assert.equal(restarted.all()[0]!.token, row.token);
      assert.equal(restarted.all()[0]!.id, row.id);
    });
  });

  it("keeps filled recovery state active past short quote expiry", (t) => {
    let now = preFieldRecord.createdAt;
    t.mock.method(Date, "now", () => now * 1000);
    const original = portableFillRecord({ orderExpiresAt: now + 300, fillRespondBy: now + 290 });
    withStateFile(envelope([original]), (state, file) => {
      const row = state.all()[0]!;
      state.upsert(row);
      now += 601;
      const restarted = new StateFile(file, DEPLOYMENT);
      assert.equal(restarted.retainedAdmissionCount(now), 1);
      assert.deepEqual(restarted.all()[0], row);
      restarted.delete(row.id);
      const terminal = new StateFile(file, DEPLOYMENT);
      assert.equal(terminal.retainedAdmissionCount(row.initiatorTimeout! + 86400), 1);
      assert.equal(terminal.retainedAdmissionCount(row.initiatorTimeout! + 86401), 0);
    });
  });

  it("refuses corrupted admission history without rewriting recovery state", () => {
    assertRefusedWithoutMutation({ ...envelope([]), admissions: [{ id: "bad", retainUntil: 2 }] }, /admission/);
    assertRefusedWithoutMutation({ ...envelope([]), version: 2 }, /admission/);
  });
});

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
    assert.equal(
      readFileSync(file, "utf8"),
      before,
      "recovery state must remain byte-for-byte intact",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("deployment-bound state hydration", () => {
  it("keeps field-level upgrade defaults inside a correctly bound deployment", () => {
    withStateFile(
      envelope([{ ...preFieldRecord, deployment: DEPLOYMENT }]),
      (state) => {
        const orders = state.all();
        assert.equal(orders.length, 1);
        assert.equal(orders[0]?.asset, "ETH");
        assert.equal(orders[0]?.level, 0);
        assert.equal(orders[0]?.quotedMidMilli, null);
        assert.equal(orders[0]?.announcedAt, null);
        assert.equal(orders[0]?.sponsorSentAt, null);
        assert.deepEqual(orders[0]?.deployment, DEPLOYMENT);
      },
    );
  });

  it("keeps an explicit asset on a bound record", () => {
    withStateFile(
      envelope([
        {
          ...preFieldRecord,
          id: "order-2",
          asset: "USDC",
          deployment: DEPLOYMENT,
        },
      ]),
      (state) => assert.equal(state.all()[0]?.asset, "USDC"),
    );
  });

  it("hydrates a V2 proof inside its bound Q128 deployment envelope", () => {
    const record = portableOpenRecord();
    withStateFile(envelope([record]), (state) => {
      const order = state.all()[0];
      assert.ok(order?.protocol);
      assert.match(order.deployment.qrlHtlc, /^Q[0-9a-fA-F]{128}$/);
      assert.match(order.protocol.order.makerQrlAccount, /^Q[0-9a-f]{128}$/);
      assert.equal(
        order.protocol.order.makerQrlAccount,
        LEGACY_IDENTITY.currentAddress,
      );
      assert.equal(
        order.id,
        deriveOrderV1Id(order.protocol.order.makerQrlAccount, ORDER_NONCE),
      );
      assert.equal(order.token, MAKER_TOKEN);
      assert.equal(order.protocol.orderAuth.nonce, ORDER_NONCE);
      assert.equal(order.protocol.fillAcknowledged, false);
      assert.equal(order.protocol.releaseObserved, false);
      assert.equal(
        order.protocol.orderDigest,
        computeOrderDigest(order.protocol.order, order.protocol.orderAuth),
      );
    });
  });

  it("preserves a V1 protocol record and refuses to reinterpret it on v3", () => {
    const record = portableOpenRecord();
    const protocol = record.protocol as Record<string, unknown>;
    const auth = protocol.orderAuth as Record<string, unknown>;
    assertRefusedWithoutMutation(
      envelope([{ ...record, protocol: { ...protocol, version: 1 } }]),
      /version.*left untouched/s,
    );
    assertRefusedWithoutMutation(
      envelope([
        {
          ...record,
          protocol: { ...protocol, orderAuth: { ...auth, version: "1" } },
        },
      ]),
      /version.*left untouched/s,
    );
  });

  it("cryptographically hydrates a selected intent and exact signed fill", () => {
    const record = portableFillRecord();
    withStateFile(envelope([record]), (state) => {
      const order = state.all()[0];
      assert.ok(order?.protocol?.selectedIntent);
      assert.ok(order.protocol.fillProof);
      assert.equal(order.protocol.fillProof.fill.hashlock, order.hashlock);
      assert.equal(
        order.protocol.fillProof.fill.intentDigest,
        order.protocol.selectedIntent.intentDigest,
      );
      assert.equal(order.protocol.fillAcknowledged, false);
      assert.equal(order.protocol.releaseObserved, false);
    });
  });

  it("persists an authenticated fill acknowledgment and sticky release observation", () => {
    const record = portableFillRecord();
    withStateFile(envelope([record]), (state, file) => {
      const order = state.all()[0];
      assert.ok(order?.protocol?.fillProof);
      order.protocol.fillAcknowledged = true;
      order.protocol.releaseObserved = true;
      state.upsert(order);

      const reloaded = new StateFile(file, DEPLOYMENT).all()[0];
      assert.equal(reloaded?.protocol?.fillAcknowledged, true);
      assert.equal(reloaded?.protocol?.releaseObserved, true);
    });
  });

  it("refuses a recovered FillV1 response deadline past its OrderV1 expiry", () => {
    assertRefusedWithoutMutation(
      envelope([
        portableFillRecord({
          orderExpiresAt: preFieldRecord.createdAt + 200,
          fillRespondBy: preFieldRecord.createdAt + 320,
        }),
      ]),
      /maker authorization is malformed.*left untouched/s,
    );
  });

  it("cryptographically hydrates an exact signed cancellation for retry", () => {
    const record = portableCancelRecord();
    withStateFile(envelope([record]), (state) => {
      const proof = state.all()[0]?.protocol?.cancelProof;
      assert.ok(proof);
      assert.equal(proof.cancel.reasonCode, 1);
      assert.equal(proof.auth.nonce, `0x${"45".repeat(32)}`);
    });
  });

  it("refuses malformed non-null portable proof state without mutating recovery data", () => {
    const record = portableOpenRecord();
    const protocol = record.protocol as Record<string, unknown>;
    const orderAuth = protocol.orderAuth as Record<string, unknown>;
    const fillRecord = portableFillRecord();
    const fillProtocol = fillRecord.protocol as Record<string, unknown>;
    const signature = orderAuth.signature as string;
    const replacement = signature.endsWith("00") ? "01" : "00";
    assertRefusedWithoutMutation(
      envelope([{ ...record, token: "cd".repeat(32) }]),
      /maker capability does not match its signed commitment.*left untouched/s,
    );
    assertRefusedWithoutMutation(
      envelope([
        {
          ...record,
          protocol: { ...protocol, orderDigest: `0x${"f".repeat(64)}` },
        },
      ]),
      /protocol state.*orderDigest is malformed.*left untouched/s,
    );
    assertRefusedWithoutMutation(
      envelope([{ ...record, protocol: { ...protocol, fillProof: {} } }]),
      /fillProof has no selected intent.*left untouched/s,
    );
    assertRefusedWithoutMutation(
      envelope([
        { ...record, protocol: { ...protocol, fillAcknowledged: true } },
      ]),
      /fillAcknowledged has no fill proof.*left untouched/s,
    );
    assertRefusedWithoutMutation(
      envelope([
        {
          ...fillRecord,
          protocol: {
            ...fillProtocol,
            fillAcknowledged: false,
            releaseObserved: true,
          },
        },
      ]),
      /releaseObserved has no acknowledged fill proof.*left untouched/s,
    );
    assertRefusedWithoutMutation(
      envelope([
        {
          ...record,
          protocol: {
            ...protocol,
            orderAuth: {
              ...orderAuth,
              signature: `${signature.slice(0, -2)}${replacement}`,
            },
          },
        },
      ]),
      /orderAuth signature is malformed.*left untouched/s,
    );
  });

  it("migrates only an empty legacy array to the bound envelope", () => {
    withStateFile([], (state, file) => {
      assert.deepEqual(state.all(), []);
      const persisted = JSON.parse(readFileSync(file, "utf8")) as Record<
        string,
        unknown
      >;
      assert.equal(persisted.version, 2);
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
      envelope(
        [{ ...preFieldRecord, deployment: OTHER_DEPLOYMENT }],
        OTHER_DEPLOYMENT,
      ),
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
    withStateFile(
      envelope([{ ...preFieldRecord, deployment: DEPLOYMENT }]),
      (state, file) => {
        const order = state.all()[0];
        assert.ok(order);
        const before = readFileSync(file, "utf8");
        assert.throws(
          () => state.upsert({ ...order, deployment: OTHER_DEPLOYMENT }),
          /belongs to another deployment.*left untouched/s,
        );
        assert.equal(readFileSync(file, "utf8"), before);
      },
    );
  });

  it("rolls the in-memory map back when an atomic persistence step fails", () => {
    const root = mkdtempSync(join(tmpdir(), "mm-state-rollback-test-"));
    try {
      const stateDir = join(root, "state");
      mkdirSync(stateDir);
      const file = join(stateDir, "state.json");
      writeFileSync(
        file,
        JSON.stringify(
          envelope([{ ...preFieldRecord, deployment: DEPLOYMENT }]),
        ),
        "utf8",
      );
      const state = new StateFile(file, DEPLOYMENT);
      rmSync(stateDir, { recursive: true, force: true });
      writeFileSync(stateDir, "blocks directory recreation", "utf8");

      assert.throws(() => state.delete(preFieldRecord.id));
      assert.equal(state.all().length, 1);
      assert.equal(state.all()[0]?.id, preFieldRecord.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("poisons every further operation after a post-rename directory sync failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-poison-test-"));
    try {
      const file = join(dir, "state.json");
      writeFileSync(
        file,
        JSON.stringify(
          envelope([{ ...preFieldRecord, deployment: DEPLOYMENT }]),
        ),
        "utf8",
      );
      const state = new StateFile(file, DEPLOYMENT, () => {
        throw new Error("injected directory sync failure");
      });
      assert.throws(
        () => state.delete(preFieldRecord.id),
        StateFilePoisonedError,
      );
      const persisted = JSON.parse(readFileSync(file, "utf8")) as {
        orders: unknown[];
      };
      assert.deepEqual(persisted.orders, []);
      assert.throws(() => state.all(), StateFilePoisonedError);
      assert.throws(
        () => state.delete(preFieldRecord.id),
        StateFilePoisonedError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

// Two containers sharing one state volume see different PID namespaces, so
// the lease tests drive that value through the acquisition seam.
const LOCAL_NS = "pid:[4026531836]";
const FOREIGN_NS = "pid:[4026539999]";

interface LockRecord {
  version: number;
  pid: number;
  processStart: string;
  bootId: string;
  pidNamespace?: string;
  identityDigest: string;
  leaseId: string;
}

const readLock = (file: string): LockRecord =>
  JSON.parse(readFileSync(`${file}.lock`, "utf8")) as LockRecord;

const writeLock = (file: string, overrides: Partial<LockRecord>): void => {
  const record: LockRecord = {
    version: 2,
    pid: process.pid,
    processStart: "0",
    bootId: "other-boot",
    identityDigest: "other-identity",
    leaseId: "other-lease",
    ...overrides,
  };
  writeFileSync(`${file}.lock`, JSON.stringify(record), { mode: 0o600 });
};

/** Backdates the lease heartbeat and returns the timestamp it was set to. */
const ageLock = (file: string, byMs: number): number => {
  const stamp = new Date(Date.now() - byMs);
  utimesSync(`${file}.lock`, stamp, stamp);
  return stamp.getTime();
};

async function waitFor(
  ready: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error("the awaited lease condition never held");
    }
    await setTimeoutPromise(2);
  }
}

describe("exclusive state process lease", () => {
  const identity = {
    deploymentFingerprint: DEPLOYMENT.configFingerprint,
    ethAccount: `0x${"1".repeat(40)}`,
    qrlAccount: `Q${"2".repeat(128)}`,
  };

  it("deterministically refuses a live second instance and releases cleanly", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-lease-test-"));
    const file = join(dir, "state.json");
    try {
      const first = StateProcessLease.acquire(file, identity);
      assert.throws(
        () => StateProcessLease.acquire(file, identity),
        /held by live process.*refusing a second market maker instance/,
      );
      first.close();
      const replacement = StateProcessLease.acquire(file, identity);
      replacement.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers an incomplete stale lease without weakening live exclusion", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-lease-stale-test-"));
    const file = join(dir, "state.json");
    try {
      writeFileSync(`${file}.lock`, "incomplete crash record", { mode: 0o600 });
      const lease = StateProcessLease.acquire(file, identity);
      assert.throws(
        () => StateProcessLease.acquire(file, identity),
        /held by live process/,
      );
      lease.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses automatic recovery when the recovery guard itself is stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-lease-guard-test-"));
    const file = join(dir, "state.json");
    try {
      writeFileSync(
        `${file}.lock.recovery`,
        JSON.stringify({
          version: 1,
          pid: process.pid,
          processStart: "stale-process",
          bootId: "stale-boot",
          identityDigest: "stale-identity",
          leaseId: "stale-lease",
        }),
        { mode: 0o600 },
      );
      assert.throws(
        () => StateProcessLease.acquire(file, identity),
        /recovery guard .* is stale.*Refusing unsafe automatic removal; confirm no market maker process runs/,
      );
      assert.equal(existsSync(`${file}.lock`), false);
      assert.equal(existsSync(`${file}.lock.recovery`), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rechecks a stale observation and preserves an intervening live lease", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-lease-race-test-"));
    const file = join(dir, "state.json");
    const winners: StateProcessLease[] = [];
    try {
      writeFileSync(`${file}.lock`, "incomplete crash record", { mode: 0o600 });
      let winnerContents = "";
      assert.throws(
        () =>
          StateProcessLease.acquire(file, identity, {
            afterStaleObservation: () => {
              winners.push(StateProcessLease.acquire(file, identity));
              winnerContents = readFileSync(`${file}.lock`, "utf8");
            },
          }),
        /held by live process.*refusing a second market maker instance/,
      );

      const winner = winners[0];
      assert.ok(winner);
      assert.equal(readFileSync(`${file}.lock`, "utf8"), winnerContents);
      assert.equal(existsSync(`${file}.lock.recovery`), false);
      assert.throws(
        () => StateProcessLease.acquire(file, identity),
        /held by live process/,
      );

      winner.close();
      winners.pop();
      const replacement = StateProcessLease.acquire(file, identity);
      replacement.close();
    } finally {
      winners[0]?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records the writing process's PID namespace", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-lease-ns-record-test-"));
    const file = join(dir, "state.json");
    try {
      const lease = StateProcessLease.acquire(file, identity, {
        pidNamespace: LOCAL_NS,
      });
      const record = readLock(file);
      assert.equal(record.version, 2);
      assert.equal(record.pidNamespace, LOCAL_NS);
      lease.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a live holder in another PID namespace", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-lease-foreign-test-"));
    const file = join(dir, "state.json");
    try {
      const holder = StateProcessLease.acquire(file, identity, {
        pidNamespace: LOCAL_NS,
      });
      const held = readLock(file);
      assert.throws(
        () =>
          StateProcessLease.acquire(file, identity, {
            pidNamespace: FOREIGN_NS,
          }),
        /another PID namespace.*refusing a second market maker instance/,
      );
      // The refusal left the holder's record exactly as it was.
      assert.deepEqual(readLock(file), held);
      holder.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes over a foreign namespace lease whose heartbeat expired", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-lease-expired-test-"));
    const file = join(dir, "state.json");
    try {
      writeLock(file, { pidNamespace: FOREIGN_NS, leaseId: "crashed" });
      ageLock(file, LEASE_TTL_MS + 5_000);
      const lease = StateProcessLease.acquire(file, identity, {
        pidNamespace: LOCAL_NS,
      });
      assert.notEqual(readLock(file).leaseId, "crashed");
      assert.throws(
        () =>
          StateProcessLease.acquire(file, identity, {
            pidNamespace: FOREIGN_NS,
          }),
        /another PID namespace/,
      );
      lease.close();
      assert.equal(existsSync(`${file}.lock`), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("judges a record from another host boot by its heartbeat too", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-lease-boot-test-"));
    const file = join(dir, "state.json");
    try {
      // Same namespace id, other boot id: another machine on this volume.
      writeLock(file, { pidNamespace: LOCAL_NS, leaseId: "other-host" });
      assert.throws(
        () =>
          StateProcessLease.acquire(file, identity, {
            pidNamespace: LOCAL_NS,
          }),
        /another host boot/,
      );
      ageLock(file, LEASE_TTL_MS + 5_000);
      const lease = StateProcessLease.acquire(file, identity, {
        pidNamespace: LOCAL_NS,
      });
      lease.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honours an injected heartbeat lifetime for a foreign namespace", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-lease-ttl-test-"));
    const file = join(dir, "state.json");
    try {
      writeLock(file, { pidNamespace: FOREIGN_NS, leaseId: "crashed" });
      ageLock(file, 20_000);
      assert.throws(
        () =>
          StateProcessLease.acquire(file, identity, {
            pidNamespace: LOCAL_NS,
            ttlMs: 30_000,
          }),
        /another PID namespace/,
      );
      const lease = StateProcessLease.acquire(file, identity, {
        pidNamespace: LOCAL_NS,
        ttlMs: 10_000,
      });
      lease.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps PID semantics for a v1 record with no PID namespace", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-lease-v1-test-"));
    const file = join(dir, "state.json");
    try {
      const holder = StateProcessLease.acquire(file, identity, {
        pidNamespace: LOCAL_NS,
      });
      const { pidNamespace: _dropped, ...v1 } = readLock(file);
      writeFileSync(
        `${file}.lock`,
        JSON.stringify({ ...v1, version: 1 }),
        { mode: 0o600 },
      );
      // A v1 record is read as this namespace's own, so its live PID still
      // refuses a starter that observes from anywhere.
      assert.throws(
        () =>
          StateProcessLease.acquire(file, identity, {
            pidNamespace: FOREIGN_NS,
          }),
        /held by live process.*refusing a second market maker instance/,
      );
      holder.close();

      // A dead PID in a v1 record is stale immediately, with no TTL wait.
      writeFileSync(
        `${file}.lock`,
        JSON.stringify({ ...v1, version: 1, processStart: "0" }),
        { mode: 0o600 },
      );
      const replacement = StateProcessLease.acquire(file, identity, {
        pidNamespace: FOREIGN_NS,
      });
      assert.equal(readLock(file).version, 2);
      replacement.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshes the heartbeat while owned and reports a loss once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-lease-beat-test-"));
    const file = join(dir, "state.json");
    let lease: StateProcessLease | undefined;
    try {
      lease = StateProcessLease.acquire(file, identity, {
        pidNamespace: LOCAL_NS,
      });
      const aged = ageLock(file, 60_000);
      let lost = 0;
      lease.startHeartbeat(() => {
        lost += 1;
      }, 2);
      await waitFor(() => statSync(`${file}.lock`).mtimeMs > aged);
      assert.equal(lost, 0);
      lease.assertOwned();

      // Another container replaced the lease under us.
      writeLock(file, { pidNamespace: FOREIGN_NS, leaseId: "successor" });
      await waitFor(() => lost === 1);
      await setTimeoutPromise(30);
      assert.equal(lost, 1);
      assert.throws(() => lease?.assertOwned(), StateLeaseLostError);
      // A displaced holder never deletes the successor's lease file.
      lease.close();
      assert.equal(readLock(file).leaseId, "successor");
    } finally {
      lease?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a loss when the lease file is removed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-lease-removed-test-"));
    const file = join(dir, "state.json");
    let lease: StateProcessLease | undefined;
    try {
      lease = StateProcessLease.acquire(file, identity, {
        pidNamespace: LOCAL_NS,
      });
      let lost = 0;
      lease.startHeartbeat(() => {
        lost += 1;
      }, 2);
      rmSync(`${file}.lock`);
      await waitFor(() => lost === 1);
      await setTimeoutPromise(30);
      assert.equal(lost, 1);
    } finally {
      lease?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a heartbeat from the future as stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-lease-skew-test-"));
    const file = join(dir, "state.json");
    try {
      writeLock(file, { pidNamespace: FOREIGN_NS, leaseId: "fast-clock" });
      // Inside the tolerated skew the holder still counts as live.
      ageLock(file, -10_000);
      assert.throws(
        () =>
          StateProcessLease.acquire(file, identity, {
            pidNamespace: LOCAL_NS,
          }),
        /-10\.0 s ago/,
      );
      ageLock(file, -120_000);
      const lease = StateProcessLease.acquire(file, identity, {
        pidNamespace: LOCAL_NS,
      });
      lease.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never applies PID semantics to an unknown namespace", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-lease-unknown-test-"));
    const file = join(dir, "state.json");
    try {
      // This process cannot read its own namespace, so it records the marker.
      const lease = StateProcessLease.acquire(file, identity, {
        pidNamespace: null,
      });
      assert.equal(readLock(file).pidNamespace, "unknown");
      lease.close();

      // A live PID under the marker is still judged by the heartbeat alone.
      writeLock(file, {
        pidNamespace: "unknown",
        processStart: "0",
        leaseId: "unknown-holder",
      });
      assert.throws(
        () =>
          StateProcessLease.acquire(file, identity, {
            pidNamespace: "unknown",
          }),
        /another PID namespace/,
      );
      ageLock(file, LEASE_TTL_MS + 5_000);
      const replacement = StateProcessLease.acquire(file, identity, {
        pidNamespace: "unknown",
      });
      replacement.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes staging files left behind past the heartbeat lifetime", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-lease-staged-test-"));
    const file = join(dir, "state.json");
    try {
      const orphan = `${file}.lock.next.999.abandoned`;
      const fresh = `${file}.lock.next.998.inflight`;
      writeFileSync(orphan, "abandoned staging file", { mode: 0o600 });
      writeFileSync(fresh, "another starter's staging file", { mode: 0o600 });
      const old = new Date(Date.now() - (LEASE_TTL_MS + 5_000));
      utimesSync(orphan, old, old);

      const lease = StateProcessLease.acquire(file, identity, {
        pidNamespace: LOCAL_NS,
      });
      assert.equal(existsSync(orphan), false);
      assert.equal(existsSync(fresh), true);
      lease.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a loss when beats keep failing before a peer could take over", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-lease-blind-test-"));
    const file = join(dir, "state.json");
    let lease: StateProcessLease | undefined;
    try {
      lease = StateProcessLease.acquire(file, identity, {
        pidNamespace: LOCAL_NS,
        ttlMs: 200,
      });
      let lost = 0;
      lease.startHeartbeat(() => {
        lost += 1;
      }, 10);
      // A lease file this process can no longer read, with its own lease id
      // still plausibly on it. Reading a directory fails for any user.
      rmSync(`${file}.lock`);
      mkdirSync(`${file}.lock`);
      const start = Date.now();
      await waitFor(() => lost === 1);
      // 200 ms lifetime and 10 ms beats budget 18 failures, and the loss must
      // land before the lifetime a peer would count down.
      assert.ok(Date.now() - start < 200, "loss must precede a peer takeover");
      await setTimeoutPromise(60);
      assert.equal(lost, 1);
    } finally {
      lease?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-reads the lease file on every ownership check", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-lease-recheck-test-"));
    const file = join(dir, "state.json");
    try {
      const lease = StateProcessLease.acquire(file, identity, {
        pidNamespace: LOCAL_NS,
      });
      const held = readFileSync(`${file}.lock`, "utf8");
      lease.assertOwned();
      // No heartbeat runs here, so only a fresh read can catch this.
      writeLock(file, { pidNamespace: FOREIGN_NS, leaseId: "successor" });
      assert.throws(() => lease.assertOwned(), StateLeaseLostError);
      // A proven loss latches, so a record that comes back does not revive it.
      writeFileSync(`${file}.lock`, held, { mode: 0o600 });
      assert.throws(() => lease.assertOwned(), StateLeaseLostError);
      lease.close();
      assert.equal(existsSync(`${file}.lock`), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a heartbeat interval with no detection margin", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-lease-margin-test-"));
    const file = join(dir, "state.json");
    try {
      const lease = StateProcessLease.acquire(file, identity, {
        pidNamespace: LOCAL_NS,
        ttlMs: 100,
      });
      assert.throws(
        () => lease.startHeartbeat(() => undefined, 40),
        /no detection margin/,
      );
      lease.startHeartbeat(() => undefined, 30);
      lease.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores PID semantics for every record when this namespace is unknown", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-lease-blindns-test-"));
    const file = join(dir, "state.json");
    let holder: StateProcessLease | undefined;
    try {
      holder = StateProcessLease.acquire(file, identity, {
        pidNamespace: LOCAL_NS,
      });
      const { pidNamespace: _dropped, ...v1 } = readLock(file);
      writeFileSync(`${file}.lock`, JSON.stringify({ ...v1, version: 1 }), {
        mode: 0o600,
      });
      // A starter that knows its namespace still reads the live PID.
      assert.throws(
        () =>
          StateProcessLease.acquire(file, identity, {
            pidNamespace: LOCAL_NS,
          }),
        /held by live process/,
      );
      // A starter that cannot read its own namespace uses the heartbeat for
      // this v1 record too, so a fresh one still refuses.
      assert.throws(
        () =>
          StateProcessLease.acquire(file, identity, { pidNamespace: null }),
        /another PID namespace/,
      );
      ageLock(file, LEASE_TTL_MS + 5_000);
      const replacement = StateProcessLease.acquire(file, identity, {
        pidNamespace: null,
      });
      replacement.close();
    } finally {
      holder?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dispatches the lost-lease callback after the failing write returns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-lease-async-test-"));
    const file = join(dir, "state.json");
    let lease: StateProcessLease | undefined;
    try {
      lease = StateProcessLease.acquire(file, identity, {
        pidNamespace: LOCAL_NS,
      });
      const events: string[] = [];
      lease.startHeartbeat((reason) => {
        events.push(`lost: ${reason}`);
      }, 30_000);
      writeLock(file, { pidNamespace: FOREIGN_NS, leaseId: "successor" });
      assert.throws(() => lease?.assertOwned(), StateLeaseLostError);
      events.push("the refused write unwound");
      await setTimeoutPromise(20);
      assert.deepEqual(events, [
        "the refused write unwound",
        "lost: the lease file now carries another holder's lease id",
      ]);
    } finally {
      lease?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defers a write it cannot verify and resumes once the file reads again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-lease-transient-test-"));
    const file = join(dir, "state.json");
    let lease: StateProcessLease | undefined;
    try {
      const contents = JSON.stringify(
        envelope([{ ...preFieldRecord, deployment: DEPLOYMENT }]),
      );
      writeFileSync(file, contents, "utf8");
      lease = StateProcessLease.acquire(file, identity, {
        pidNamespace: LOCAL_NS,
      });
      const owner = lease;
      const held = readFileSync(`${file}.lock`, "utf8");
      const state = new StateFile(file, DEPLOYMENT, undefined, () =>
        owner.assertOwned(),
      );
      let lost = 0;
      // A long interval, so only the write path observes the failure.
      lease.startHeartbeat(() => {
        lost += 1;
      }, 30_000);

      // A lock path this process cannot read, for one write only.
      rmSync(`${file}.lock`);
      mkdirSync(`${file}.lock`);
      assert.throws(
        () => state.delete(preFieldRecord.id),
        StateLeaseUnverifiableError,
      );
      assert.equal(readFileSync(file, "utf8"), contents);
      assert.equal(state.all().length, 1);

      rmSync(`${file}.lock`, { recursive: true });
      writeFileSync(`${file}.lock`, held, { mode: 0o600 });
      state.delete(preFieldRecord.id);
      assert.equal(state.all().length, 0);
      await setTimeoutPromise(20);
      // A transient failure never latches a loss, so the maker keeps running.
      assert.equal(lost, 0);
      lease.assertOwned();
    } finally {
      lease?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an ownership check it cannot verify", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-lease-unreadable-test-"));
    const file = join(dir, "state.json");
    try {
      const lease = StateProcessLease.acquire(file, identity, {
        pidNamespace: LOCAL_NS,
      });
      rmSync(`${file}.lock`);
      assert.throws(() => lease.assertOwned(), StateLeaseLostError);
      lease.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a state write after the lease is lost", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-state-lease-write-test-"));
    const file = join(dir, "state.json");
    let lease: StateProcessLease | undefined;
    try {
      const contents = JSON.stringify(
        envelope([{ ...preFieldRecord, deployment: DEPLOYMENT }]),
      );
      writeFileSync(file, contents, "utf8");
      lease = StateProcessLease.acquire(file, identity, {
        pidNamespace: LOCAL_NS,
      });
      const owner = lease;
      const state = new StateFile(file, DEPLOYMENT, undefined, () =>
        owner.assertOwned(),
      );
      let lost = 0;
      lease.startHeartbeat(() => {
        lost += 1;
      }, 2);
      writeLock(file, { pidNamespace: FOREIGN_NS, leaseId: "successor" });
      await waitFor(() => lost === 1);

      assert.throws(
        () => state.delete(preFieldRecord.id),
        StateLeaseLostError,
      );
      assert.equal(readFileSync(file, "utf8"), contents);
      // The refused write rolled back, so the order is still managed here.
      assert.equal(state.all().length, 1);
    } finally {
      lease?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
