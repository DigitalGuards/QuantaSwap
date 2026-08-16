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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtendedSeed, MLDSA87 } from "@theqrl/wallet.js";
import { makeDeploymentIdentity, type DeploymentIdentity } from "./deployment.js";
import {
  ProtocolSigner,
  buildFillIntentV1Payload,
  computeFillIntentDigest,
  computeOrderDigest,
  deriveOrderV1Id,
  officialQrlDigest,
  type MakerOrderAuthV1,
  type ProtocolAuthV1,
} from "./protocol-signing.js";
import { StateFile, StateFilePoisonedError, StateProcessLease } from "./state.js";

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

const EXTENDED_SEED = `0x010000${"07".repeat(48)}`;
const ORDER_NONCE = `0x${"42".repeat(32)}`;
const MAKER_TOKEN = "ab".repeat(32);

function portableOpenRecord(
  orderExpiresAt = preFieldRecord.createdAt + 3600,
): Record<string, unknown> {
  const signer = new ProtocolSigner(EXTENDED_SEED);
  try {
    const signed = signer.signOrderV1(
      {
        direction: "eth->qrl",
        asset: "ETH",
        fromAmount: preFieldRecord.fromAmount,
        toAmount: preFieldRecord.toAmount,
        makerEthAccount: `0x${"1".repeat(40)}`,
        makerQrlAccount: signer.address,
        visibility: "public",
      },
      {
        makerToken: MAKER_TOKEN,
        issuedAt: preFieldRecord.createdAt,
        expiresAt: orderExpiresAt,
        nonce: ORDER_NONCE,
      },
    );
    return {
      ...preFieldRecord,
      id: deriveOrderV1Id(signed.order.makerQrlAccount, signed.auth.nonce),
      token: MAKER_TOKEN,
      asset: "ETH",
      level: 0,
      quotedMidMilli: "100000",
      announcedAt: null,
      deployment: DEPLOYMENT,
      protocol: {
        version: 1,
        orderDigest: computeOrderDigest(signed.order, signed.auth),
        order: signed.order,
        orderAuth: signed.auth,
      },
    };
  } finally {
    signer.close();
  }
}

function portableFillRecord(
  options: { orderExpiresAt?: number; fillRespondBy?: number } = {},
): Record<string, unknown> {
  const signer = new ProtocolSigner(EXTENDED_SEED);
  const extendedSeed = ExtendedSeed.from(EXTENDED_SEED);
  const takerWallet = MLDSA87.newWalletFromExtendedSeed(extendedSeed) as ReturnType<
    typeof MLDSA87.newWalletFromExtendedSeed
  > & { zeroize(): void };
  (extendedSeed as typeof extendedSeed & { zeroize(): void }).zeroize();
  try {
    const open = portableOpenRecord(options.orderExpiresAt);
    const protocol = open.protocol as Record<string, unknown>;
    const orderDigest = protocol.orderDigest as string;
    const intent = {
      orderDigest,
      takerEthAccount: `0x${"2".repeat(40)}`,
      takerQrlAccount: signer.address,
      releaseCommitment: `0x${"3".repeat(64)}`,
    };
    const unsignedIntentAuth = {
      issuedAt: preFieldRecord.createdAt + 10,
      expiresAt: preFieldRecord.createdAt + 110,
      nonce: `0x${"43".repeat(32)}`,
    };
    const intentAuth: ProtocolAuthV1 = {
      version: "1",
      scheme: "qrl-eip712-v4",
      ...unsignedIntentAuth,
      signature: `0x${Buffer.from(
        takerWallet.sign(officialQrlDigest(buildFillIntentV1Payload(intent, unsignedIntentAuth))),
      ).toString("hex")}`,
      publicKey: `0x${Buffer.from(takerWallet.getPK()).toString("hex")}`,
      descriptor: "0x010000",
    };
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
    const fillProof = signer.signFillV1(
      {
        orderDigest,
        intentDigest: selectedIntent.intentDigest,
        takerEthAccount: intent.takerEthAccount,
        takerQrlAccount: intent.takerQrlAccount,
        releaseCommitment: intent.releaseCommitment,
        hashlock,
        initiatorTimeout,
        responderTimeout,
      },
      {
        order: {
          order: protocol.order as ReturnType<ProtocolSigner["signOrderV1"]>["order"],
          auth: orderAuth,
        },
        selectedIntent,
        issuedAt: preFieldRecord.createdAt + 20,
        respondBy: options.fillRespondBy ?? preFieldRecord.createdAt + 320,
        fillNonce: `0x${"44".repeat(32)}`,
      },
    );
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
  } finally {
    takerWallet.zeroize();
    signer.close();
  }
}

function portableCancelRecord(): Record<string, unknown> {
  const signer = new ProtocolSigner(EXTENDED_SEED);
  try {
    const open = portableOpenRecord();
    const protocol = open.protocol as Record<string, unknown>;
    const orderAuth = protocol.orderAuth as MakerOrderAuthV1;
    const cancelProof = signer.signCancelV1(
      { orderDigest: protocol.orderDigest as string, reasonCode: 1 },
      {
        orderNonce: orderAuth.nonce,
        issuedAt: preFieldRecord.createdAt + 20,
        expiresAt: orderAuth.expiresAt,
        cancelNonce: `0x${"45".repeat(32)}`,
      },
    );
    return { ...open, protocol: { ...protocol, cancelProof } };
  } finally {
    signer.close();
  }
}

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

  it("hydrates a pending signed order with its exact committed maker capability", () => {
    const record = portableOpenRecord();
    withStateFile(envelope([record]), (state) => {
      const order = state.all()[0];
      assert.ok(order?.protocol);
      assert.equal(order.id, deriveOrderV1Id(order.protocol.order.makerQrlAccount, ORDER_NONCE));
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

  it("refuses to sign a FillV1 response deadline past its OrderV1 expiry", () => {
    assert.throws(
      () => portableFillRecord({
        orderExpiresAt: preFieldRecord.createdAt + 200,
        fillRespondBy: preFieldRecord.createdAt + 320,
      }),
      /fill authorization is outside its order or intent window/,
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
      envelope([{ ...record, protocol: { ...protocol, orderDigest: `0x${"f".repeat(64)}` } }]),
      /protocol state.*orderDigest is malformed.*left untouched/s,
    );
    assertRefusedWithoutMutation(
      envelope([{ ...record, protocol: { ...protocol, fillProof: {} } }]),
      /fillProof has no selected intent.*left untouched/s,
    );
    assertRefusedWithoutMutation(
      envelope([{ ...record, protocol: { ...protocol, fillAcknowledged: true } }]),
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
            orderAuth: { ...orderAuth, signature: `${signature.slice(0, -2)}${replacement}` },
          },
        },
      ]),
      /orderAuth signature is malformed.*left untouched/s,
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

  it("rolls the in-memory map back when an atomic persistence step fails", () => {
    const root = mkdtempSync(join(tmpdir(), "mm-state-rollback-test-"));
    try {
      const stateDir = join(root, "state");
      mkdirSync(stateDir);
      const file = join(stateDir, "state.json");
      writeFileSync(
        file,
        JSON.stringify(envelope([{ ...preFieldRecord, deployment: DEPLOYMENT }])),
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
        JSON.stringify(envelope([{ ...preFieldRecord, deployment: DEPLOYMENT }])),
        "utf8",
      );
      const state = new StateFile(file, DEPLOYMENT, () => {
        throw new Error("injected directory sync failure");
      });
      assert.throws(() => state.delete(preFieldRecord.id), StateFilePoisonedError);
      const persisted = JSON.parse(readFileSync(file, "utf8")) as { orders: unknown[] };
      assert.deepEqual(persisted.orders, []);
      assert.throws(() => state.all(), StateFilePoisonedError);
      assert.throws(() => state.delete(preFieldRecord.id), StateFilePoisonedError);
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

describe("exclusive state process lease", () => {
  const identity = {
    deploymentFingerprint: DEPLOYMENT.configFingerprint,
    ethAccount: `0x${"1".repeat(40)}`,
    qrlAccount: `Q${"2".repeat(40)}`,
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
      assert.throws(() => StateProcessLease.acquire(file, identity), /held by live process/);
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
        /recovery guard .* is stale; refusing unsafe automatic removal/,
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
      assert.throws(() => StateProcessLease.acquire(file, identity), /held by live process/);

      winner.close();
      winners.pop();
      const replacement = StateProcessLease.acquire(file, identity);
      replacement.close();
    } finally {
      winners[0]?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
