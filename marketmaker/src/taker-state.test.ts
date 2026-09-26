// Durability rules for in-flight takes: recovery material survives a
// crash, a file this build cannot authenticate stops the run, and no write
// happens without the process lease.

import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { makeDeploymentIdentity } from "./deployment.js";
import { protocolV2Config } from "./protocol-v2-config.js";
import {
  ProtocolSigner,
  computeFillDigest,
  computeFillIntentDigest,
  computeOrderDigest,
  deriveOrderV1Id,
  type SignedOrderV1,
} from "./protocol-signing.js";
import { V2_TEST_EXTENDED_SEED } from "./protocol-v2-test-helper.js";
import {
  MAX_RETAINED_INTENTS,
  TakerStateFile,
  newTakerSwapRecord,
  type TakerSwapRecord,
} from "./taker-state.js";

const maker = new ProtocolSigner(V2_TEST_EXTENDED_SEED);
const taker = new ProtocolSigner(`0x010000${"09".repeat(48)}`);
after(() => {
  maker.close();
  taker.close();
});

const NOW = 1_800_000_000;
const MAKER_ETH = `0x${"a".repeat(40)}`;
const TAKER_ETH = `0x${"c".repeat(40)}`;
const DEPLOYMENT = makeDeploymentIdentity(protocolV2Config);
const OTHER_DEPLOYMENT = makeDeploymentIdentity({
  ...protocolV2Config,
  ethHtlc: `0x${"5".repeat(40)}`,
});

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "quantaswap-taker-")), "state.json");
}

function signOrder(): SignedOrderV1 {
  return maker.signOrderV1(
    {
      direction: "eth->qrl",
      asset: "ETH",
      fromAmount: (2n * 10n ** 16n).toString(),
      toAmount: (2n * 10n ** 18n).toString(),
      makerEthAccount: MAKER_ETH,
      makerQrlAccount: maker.address,
    },
    {
      makerToken: randomBytes(32).toString("hex"),
      issuedAt: NOW - 60,
      expiresAt: NOW + 3540,
    },
  );
}

function recordFor(order: SignedOrderV1): TakerSwapRecord {
  const orderDigest = computeOrderDigest(order.order, order.auth);
  return newTakerSwapRecord({
    verified: {
      id: deriveOrderV1Id(order.order.makerQrlAccount, order.auth.nonce),
      signed: order,
      orderDigest,
      asset: "ETH",
      direction: "eth->qrl",
    },
    deployment: DEPLOYMENT,
    takerEthAccount: TAKER_ETH,
    takerQrlAccount: taker.address,
    nowS: NOW,
  });
}

function withIntent(record: TakerSwapRecord, order: SignedOrderV1, issuedAt = NOW) {
  const releaseSecret = `0x${randomBytes(32).toString("hex")}`;
  const signed = taker.signFillIntentV1({
    order,
    orderDigest: record.orderDigest,
    takerEthAccount: TAKER_ETH,
    releaseSecret,
    issuedAt,
  });
  return {
    ...record,
    intents: [
      ...record.intents,
      {
        intentDigest: computeFillIntentDigest(signed.intent, signed.auth),
        intent: signed.intent,
        auth: signed.auth,
        releaseSecret,
        submittedAt: issuedAt,
        releasedAt: null,
      },
    ],
  };
}

function withFill(
  record: TakerSwapRecord,
  order: SignedOrderV1,
  issuedAt = NOW + 5,
): TakerSwapRecord {
  const selected = record.intents[record.intents.length - 1];
  assert.notEqual(selected, undefined);
  if (selected === undefined) return record;
  const fill = maker.signFillV1(
    {
      orderDigest: record.orderDigest,
      intentDigest: selected.intentDigest,
      takerEthAccount: selected.intent.takerEthAccount,
      takerQrlAccount: selected.intent.takerQrlAccount,
      releaseCommitment: selected.intent.releaseCommitment,
      hashlock: `0x${"12".repeat(32)}`,
      initiatorTimeout: issuedAt + 7200,
      responderTimeout: issuedAt + 3600,
    },
    {
      order,
      selectedIntent: {
        intentDigest: selected.intentDigest,
        intent: selected.intent,
        auth: selected.auth,
      },
      issuedAt,
      respondBy: issuedAt + 300,
    },
  );
  return {
    ...record,
    selectedIntentDigest: selected.intentDigest,
    fill,
    fillDigest: computeFillDigest(fill.fill, order.auth, fill.auth),
    fillAcknowledged: true,
  };
}

function reopen(file: string, identity?: { ethAccount: string; qrlAccount: string }) {
  return new TakerStateFile(file, DEPLOYMENT, undefined, identity);
}

describe("taker state durability", () => {
  it("round trips a record with its proposal and secret", () => {
    const file = tempFile();
    const order = signOrder();
    const record = withIntent(recordFor(order), order);
    new TakerStateFile(file, DEPLOYMENT).upsert(record);
    const reopened = new TakerStateFile(file, DEPLOYMENT);
    const recovered = reopened.get(record.orderId);
    assert.notEqual(recovered, null);
    assert.equal(recovered?.intents.length, 1);
    assert.equal(
      recovered?.intents[0]?.releaseSecret,
      record.intents[0]?.releaseSecret,
    );
    assert.equal(recovered?.orderDigest, record.orderDigest);
  });

  it("writes the state file with owner-only permissions", () => {
    const file = tempFile();
    const order = signOrder();
    new TakerStateFile(file, DEPLOYMENT).upsert(recordFor(order));
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  it("starts empty on a first run and keeps a deleted record gone", () => {
    const file = tempFile();
    const order = signOrder();
    const state = new TakerStateFile(file, DEPLOYMENT);
    assert.deepEqual(state.all(), []);
    const record = state.upsert(recordFor(order));
    state.delete(record.orderId);
    assert.deepEqual(new TakerStateFile(file, DEPLOYMENT).all(), []);
  });

  it("refuses a state file bound to another deployment", () => {
    const file = tempFile();
    new TakerStateFile(file, DEPLOYMENT).upsert(recordFor(signOrder()));
    assert.throws(
      () => new TakerStateFile(file, OTHER_DEPLOYMENT),
      /does not match configured/,
    );
  });

  it("refuses a record whose order terms were edited on disk", () => {
    const file = tempFile();
    const order = signOrder();
    new TakerStateFile(file, DEPLOYMENT).upsert(recordFor(order));
    const envelope = JSON.parse(readFileSync(file, "utf8")) as {
      swaps: { order: { toAmount: string } }[];
    };
    const swap = envelope.swaps[0];
    assert.notEqual(swap, undefined);
    if (swap !== undefined) swap.order.toAmount = "1";
    writeFileSync(file, JSON.stringify(envelope));
    assert.throws(() => new TakerStateFile(file, DEPLOYMENT), /orderDigest/);
  });

  it("refuses a record whose proposal digest was edited on disk", () => {
    const file = tempFile();
    const order = signOrder();
    new TakerStateFile(file, DEPLOYMENT).upsert(withIntent(recordFor(order), order));
    const envelope = JSON.parse(readFileSync(file, "utf8")) as {
      swaps: { intents: { intentDigest: string }[] }[];
    };
    const intent = envelope.swaps[0]?.intents[0];
    assert.notEqual(intent, undefined);
    if (intent !== undefined) intent.intentDigest = `0x${"ab".repeat(32)}`;
    writeFileSync(file, JSON.stringify(envelope));
    assert.throws(
      () => new TakerStateFile(file, DEPLOYMENT),
      /does not follow from its proposal/,
    );
  });

  it("refuses an envelope from another role or version", () => {
    const file = tempFile();
    writeFileSync(
      file,
      JSON.stringify({ version: 1, role: "maker", deployment: DEPLOYMENT, swaps: [] }),
    );
    assert.throws(() => new TakerStateFile(file, DEPLOYMENT), /role/);
  });

  it("refuses unknown fields", () => {
    const file = tempFile();
    const order = signOrder();
    new TakerStateFile(file, DEPLOYMENT).upsert(recordFor(order));
    const envelope = JSON.parse(readFileSync(file, "utf8")) as {
      swaps: Record<string, unknown>[];
    };
    const swap = envelope.swaps[0];
    if (swap !== undefined) swap["surprise"] = true;
    writeFileSync(file, JSON.stringify(envelope));
    assert.throws(
      () => new TakerStateFile(file, DEPLOYMENT),
      /unsupported fields/,
    );
  });

  it("refuses to retain more proposals than the protocol holds", () => {
    const file = tempFile();
    const order = signOrder();
    let record = recordFor(order);
    for (let index = 0; index <= MAX_RETAINED_INTENTS; index += 1) {
      record = withIntent(record, order, NOW + index);
    }
    assert.throws(
      () => new TakerStateFile(file, DEPLOYMENT).upsert(record),
      /more proposals than the protocol allows/,
    );
  });

  it("round trips an authenticated maker fill", () => {
    const file = tempFile();
    const order = signOrder();
    const record = withFill(withIntent(recordFor(order), order), order);
    new TakerStateFile(file, DEPLOYMENT).upsert(record);
    const recovered = reopen(file).get(record.orderId);
    assert.equal(recovered?.fillAcknowledged, true);
    assert.equal(recovered?.fill?.fill.hashlock, `0x${"12".repeat(32)}`);
  });

  it("refuses a fill whose signature was edited on disk", () => {
    const file = tempFile();
    const order = signOrder();
    new TakerStateFile(file, DEPLOYMENT).upsert(
      withFill(withIntent(recordFor(order), order), order),
    );
    const envelope = JSON.parse(readFileSync(file, "utf8")) as {
      swaps: { fill: { auth: { nonce: string } } }[];
    };
    const fill = envelope.swaps[0]?.fill;
    if (fill !== undefined) fill.auth.nonce = `0x${"ee".repeat(32)}`;
    writeFileSync(file, JSON.stringify(envelope));
    assert.throws(
      () => new TakerStateFile(file, DEPLOYMENT),
      /does not authenticate the selected proposal/,
    );
  });

  it("refuses a fill whose timeouts were edited on disk", () => {
    const file = tempFile();
    const order = signOrder();
    new TakerStateFile(file, DEPLOYMENT).upsert(
      withFill(withIntent(recordFor(order), order), order),
    );
    const envelope = JSON.parse(readFileSync(file, "utf8")) as {
      swaps: { fill: { fill: { responderTimeout: number } } }[];
    };
    const fill = envelope.swaps[0]?.fill;
    if (fill !== undefined) fill.fill.responderTimeout = NOW + 60;
    writeFileSync(file, JSON.stringify(envelope));
    assert.throws(
      () => new TakerStateFile(file, DEPLOYMENT),
      /does not authenticate the selected proposal/,
    );
  });

  it("refuses a fill digest that does not follow from its fill", () => {
    const file = tempFile();
    const order = signOrder();
    new TakerStateFile(file, DEPLOYMENT).upsert(
      withFill(withIntent(recordFor(order), order), order),
    );
    const envelope = JSON.parse(readFileSync(file, "utf8")) as {
      swaps: Record<string, unknown>[];
    };
    const swap = envelope.swaps[0];
    if (swap !== undefined) swap["fillDigest"] = `0x${"cd".repeat(32)}`;
    writeFileSync(file, JSON.stringify(envelope));
    assert.throws(
      () => new TakerStateFile(file, DEPLOYMENT),
      /fillDigest does not follow/,
    );
  });

  it("refuses a funding acknowledgment with no fill behind it", () => {
    const file = tempFile();
    const order = signOrder();
    new TakerStateFile(file, DEPLOYMENT).upsert(
      withIntent(recordFor(order), order),
    );
    const envelope = JSON.parse(readFileSync(file, "utf8")) as {
      swaps: Record<string, unknown>[];
    };
    const swap = envelope.swaps[0];
    if (swap !== undefined) swap["fillAcknowledged"] = true;
    writeFileSync(file, JSON.stringify(envelope));
    assert.throws(
      () => new TakerStateFile(file, DEPLOYMENT),
      /no FillV2 behind it/,
    );
  });

  it("refuses a record whose accounts are not the loaded keys", () => {
    const file = tempFile();
    const order = signOrder();
    const record = recordFor(order);
    new TakerStateFile(file, DEPLOYMENT).upsert(record);
    assert.throws(
      () =>
        reopen(file, {
          ethAccount: `0x${"9".repeat(40)}`,
          qrlAccount: taker.address,
        }),
      /other taker accounts/,
    );
    assert.throws(
      () =>
        reopen(file, {
          ethAccount: TAKER_ETH,
          qrlAccount: maker.address,
        }),
      /other taker accounts/,
    );
    assert.notEqual(
      reopen(file, { ethAccount: TAKER_ETH, qrlAccount: taker.address }).get(
        record.orderId,
      ),
      null,
    );
  });

  it("refuses a proposal signed for other accounts", () => {
    const file = tempFile();
    const order = signOrder();
    new TakerStateFile(file, DEPLOYMENT).upsert(
      withIntent(recordFor(order), order),
    );
    const envelope = JSON.parse(readFileSync(file, "utf8")) as {
      swaps: { takerEthAccount: string }[];
    };
    const swap = envelope.swaps[0];
    if (swap !== undefined) swap.takerEthAccount = `0x${"9".repeat(40)}`;
    writeFileSync(file, JSON.stringify(envelope));
    assert.throws(
      () => new TakerStateFile(file, DEPLOYMENT),
      /proposal for other accounts/,
    );
  });

  it("never writes without the ownership gate", () => {
    const file = tempFile();
    const order = signOrder();
    const state = new TakerStateFile(file, DEPLOYMENT, () => {
      throw new Error("lease lost");
    });
    assert.throws(() => state.upsert(recordFor(order)), /lease lost/);
    assert.throws(() => readFileSync(file, "utf8"));
  });

  it("keeps the in-memory view consistent with a refused write", () => {
    const file = tempFile();
    const order = signOrder();
    let fail = false;
    const state = new TakerStateFile(file, DEPLOYMENT, () => {
      if (fail) throw new Error("lease lost");
    });
    const record = state.upsert(recordFor(order));
    fail = true;
    assert.throws(() =>
      state.upsert({ ...record, lockSentAt: NOW, updatedAt: NOW }),
    );
    assert.equal(state.get(record.orderId)?.lockSentAt, null);
  });
});
