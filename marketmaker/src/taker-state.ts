// Persistence for in-flight takes. Every record holds walk-away secrets
// and the exact signed proofs a retry or a crash recovery needs, so the
// file is written 0600 and atomically, and the process lease from
// state.ts gates every write. Recovery material is persisted BEFORE the
// network send it belongs to, the same discipline the maker follows.

import {
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  fsyncSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { isAssetSymbol, type AssetSymbol } from "./assets.js";
import {
  parseDeploymentIdentity,
  sameDeployment,
  type DeploymentIdentity,
} from "./deployment.js";
import type { Direction } from "./policy.js";
import {
  buildFillV1Payload,
  computeFillDigest,
  computeFillIntentDigest,
  computeOrderDigest,
  deriveOrderV1Id,
  verifyProtocolV2Proof,
  type CanonicalOrderV1Body,
  type FillIntentV1Body,
  type MakerOrderAuthV1,
  type ProtocolAuthV1,
  type SignedFillV1,
  type SignedFillIntentV1,
  type SignedOrderV1,
} from "./protocol-signing.js";
import { fsyncDirectory } from "./state.js";
import {
  fillBindingIsValid,
  parseFillBody,
  parseFillIntentBody,
  parseMakerOrderAuth,
  parseProtocolAuth,
  verifyMakerOrder,
  verifyOwnIntent,
  type BookOrderRow,
} from "./taker-proofs.js";

const BYTES32_RE = /^0x[0-9a-f]{64}$/;
const ETH_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const QRL_ADDRESS_RE = /^Q[0-9a-f]{128}$/;
const AMOUNT_RE = /^(?:0|[1-9][0-9]{0,29})$/;
const ORDER_ID_RE = /^[0-9a-f]{64}$/;

/** Proposals retained per order. The book holds at most eight unexpired
 *  proposals per order, so a longer local history proves nothing. */
export const MAX_RETAINED_INTENTS = 8;

export type TakerOutcome =
  /** We claimed the maker escrow; the swap completed. */
  | "claimed"
  /** Our escrow came back to us after the timeout. */
  | "refunded"
  /** Nothing moved; the take was dropped before funding. */
  | "aborted"
  /** We revealed the walk-away secret before funding. */
  | "released"
  /** One leg claimed, the other refunded. Needs operator attention. */
  | "uneven";

export interface TakerIntentRecord {
  intentDigest: string;
  intent: FillIntentV1Body;
  auth: ProtocolAuthV1;
  /** 32-byte walk-away secret committed by this proposal. Never logged. */
  releaseSecret: string;
  submittedAt: number | null;
  releasedAt: number | null;
}

export interface TakerSwapRecord {
  orderId: string;
  /** Exact chains and HTLCs this take belongs to. */
  deployment: DeploymentIdentity;
  orderDigest: string;
  order: CanonicalOrderV1Body;
  orderAuth: MakerOrderAuthV1;
  asset: AssetSymbol;
  direction: Direction;
  takerEthAccount: string;
  takerQrlAccount: string;
  /** Proposals we signed for this order, oldest first. */
  intents: TakerIntentRecord[];
  /** Digest of the proposal the maker selected, once FillV2 authenticated. */
  selectedIntentDigest: string | null;
  fill?: SignedFillV1;
  fillDigest?: string;
  /** True only after an exact authenticated locking response was stored. */
  fillAcknowledged: boolean;
  /** Sticky: a release observation never un-sets. */
  releaseObserved: boolean;
  approveSentAt: number | null;
  lockSentAt: number | null;
  claimSentAt: number | null;
  refundSentAt: number | null;
  outcome: TakerOutcome | null;
  createdAt: number;
  updatedAt: number;
}

interface TakerStateEnvelope {
  version: 1;
  role: "taker";
  deployment: DeploymentIdentity;
  swaps: TakerSwapRecord[];
}

export class TakerStateFilePoisonedError extends Error {}

const recoveryError = (file: string, reason: string): Error =>
  new Error(
    `taker state file ${file}: ${reason}; refusing to run. The file was left untouched. ` +
      "Use the original chain and HTLC configuration to settle or refund its swaps",
  );

function object(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${field} is malformed`);
  }
  return raw as Record<string, unknown>;
}

function text(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${field} is malformed`);
  }
  return value;
}

function uint(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} is malformed`);
  }
  return value;
}

function nullableUint(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : uint(value, field);
}

function flag(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} is malformed`);
  return value;
}

function parseCanonicalOrder(
  raw: unknown,
  field: string,
): CanonicalOrderV1Body {
  const body = object(raw, field);
  const direction = body["direction"];
  if (direction !== "eth->qrl" && direction !== "qrl->eth") {
    throw new Error(`${field}.direction is malformed`);
  }
  const asset = body["asset"];
  if (typeof asset !== "string" || !isAssetSymbol(asset)) {
    throw new Error(`${field}.asset is malformed`);
  }
  const visibility = body["visibility"];
  if (visibility !== "public") {
    throw new Error(`${field}.visibility must be public for a headless taker`);
  }
  const prelockRaw = body["prelock"];
  const prelock =
    prelockRaw === undefined
      ? undefined
      : (() => {
          const value = object(prelockRaw, `${field}.prelock`);
          return {
            hashlock: text(
              value["hashlock"],
              BYTES32_RE,
              `${field}.prelock.hashlock`,
            ),
            initiatorTimeout: uint(
              value["initiatorTimeout"],
              `${field}.prelock.initiatorTimeout`,
            ),
          };
        })();
  const known = [
    "direction",
    "asset",
    "fromAmount",
    "toAmount",
    "makerEthAccount",
    "makerQrlAccount",
    "visibility",
    "prelock",
  ];
  if (Object.keys(body).some((key) => !known.includes(key))) {
    throw new Error(`${field} has unsupported fields`);
  }
  return {
    direction,
    asset,
    fromAmount: text(body["fromAmount"], AMOUNT_RE, `${field}.fromAmount`),
    toAmount: text(body["toAmount"], AMOUNT_RE, `${field}.toAmount`),
    makerEthAccount: text(
      body["makerEthAccount"],
      ETH_ADDRESS_RE,
      `${field}.makerEthAccount`,
    ),
    makerQrlAccount: text(
      body["makerQrlAccount"],
      QRL_ADDRESS_RE,
      `${field}.makerQrlAccount`,
    ),
    visibility,
    ...(prelock === undefined ? {} : { prelock }),
  };
}

function parseIntentRecord(raw: unknown, field: string): TakerIntentRecord {
  const row = object(raw, field);
  const known = [
    "intentDigest",
    "intent",
    "auth",
    "releaseSecret",
    "submittedAt",
    "releasedAt",
  ];
  if (Object.keys(row).some((key) => !known.includes(key))) {
    throw new Error(`${field} has unsupported fields`);
  }
  const intent = parseFillIntentBody(row["intent"], `${field}.intent`);
  const auth = parseProtocolAuth(row["auth"], `${field}.auth`);
  const intentDigest = text(
    row["intentDigest"],
    BYTES32_RE,
    `${field}.intentDigest`,
  );
  if (intentDigest !== computeFillIntentDigest(intent, auth)) {
    throw new Error(`${field}.intentDigest does not follow from its proposal`);
  }
  return {
    intentDigest,
    intent,
    auth,
    releaseSecret: text(
      row["releaseSecret"],
      BYTES32_RE,
      `${field}.releaseSecret`,
    ),
    submittedAt: nullableUint(row["submittedAt"], `${field}.submittedAt`),
    releasedAt: nullableUint(row["releasedAt"], `${field}.releasedAt`),
  };
}

function parseOutcome(value: unknown, field: string): TakerOutcome | null {
  if (value === null || value === undefined) return null;
  if (
    value !== "claimed" &&
    value !== "refunded" &&
    value !== "aborted" &&
    value !== "released" &&
    value !== "uneven"
  ) {
    throw new Error(`${field} is malformed`);
  }
  return value;
}

/** Parse and cryptographically re-verify one persisted take. */
export function parseTakerSwapRecord(
  raw: unknown,
  field: string,
): TakerSwapRecord {
  const row = object(raw, field);
  const known = [
    "orderId",
    "deployment",
    "orderDigest",
    "order",
    "orderAuth",
    "asset",
    "direction",
    "takerEthAccount",
    "takerQrlAccount",
    "intents",
    "selectedIntentDigest",
    "fill",
    "fillDigest",
    "fillAcknowledged",
    "releaseObserved",
    "approveSentAt",
    "lockSentAt",
    "claimSentAt",
    "refundSentAt",
    "outcome",
    "createdAt",
    "updatedAt",
  ];
  if (Object.keys(row).some((key) => !known.includes(key))) {
    throw new Error(`${field} has unsupported fields`);
  }
  const order = parseCanonicalOrder(row["order"], `${field}.order`);
  const orderAuth = parseMakerOrderAuth(row["orderAuth"], `${field}.orderAuth`);
  const orderDigest = text(
    row["orderDigest"],
    BYTES32_RE,
    `${field}.orderDigest`,
  );
  if (orderDigest !== computeOrderDigest(order, orderAuth)) {
    throw new Error(`${field}.orderDigest does not follow from its order`);
  }
  const orderId = text(row["orderId"], ORDER_ID_RE, `${field}.orderId`);
  if (orderId !== deriveOrderV1Id(order.makerQrlAccount, orderAuth.nonce)) {
    throw new Error(`${field}.orderId does not follow from its order`);
  }
  const intentsRaw = row["intents"];
  if (!Array.isArray(intentsRaw) || intentsRaw.length > MAX_RETAINED_INTENTS) {
    throw new Error(`${field}.intents is malformed`);
  }
  const intents = intentsRaw.map((value, index) =>
    parseIntentRecord(value, `${field}.intents[${index}]`),
  );
  for (const record of intents) {
    if (
      record.intent.orderDigest !== orderDigest ||
      !verifyOwnIntent({ intent: record.intent, auth: record.auth }, orderDigest, orderAuth, {
        now: record.auth.issuedAt,
        allowExpired: true,
      })
    ) {
      throw new Error(`${field}.intents holds a proposal that does not verify`);
    }
  }
  const selectedIntentDigest =
    row["selectedIntentDigest"] === null ||
    row["selectedIntentDigest"] === undefined
      ? null
      : text(
          row["selectedIntentDigest"],
          BYTES32_RE,
          `${field}.selectedIntentDigest`,
        );
  if (
    selectedIntentDigest !== null &&
    !intents.some((record) => record.intentDigest === selectedIntentDigest)
  ) {
    throw new Error(`${field}.selectedIntentDigest names no retained proposal`);
  }
  const fill =
    row["fill"] === undefined
      ? undefined
      : {
          fill: parseFillBody(
            object(row["fill"], `${field}.fill`)["fill"],
            `${field}.fill.fill`,
          ),
          auth: parseProtocolAuth(
            object(row["fill"], `${field}.fill`)["auth"],
            `${field}.fill.auth`,
          ),
        };
  if (fill !== undefined && fill.fill.orderDigest !== orderDigest) {
    throw new Error(`${field}.fill belongs to another order`);
  }
  if (fill !== undefined && selectedIntentDigest === null) {
    throw new Error(`${field}.fill has no selected proposal`);
  }
  const fillDigest =
    row["fillDigest"] === undefined || row["fillDigest"] === null
      ? undefined
      : text(row["fillDigest"], BYTES32_RE, `${field}.fillDigest`);
  const takerEthAccount = text(
    row["takerEthAccount"],
    ETH_ADDRESS_RE,
    `${field}.takerEthAccount`,
  );
  const takerQrlAccount = text(
    row["takerQrlAccount"],
    QRL_ADDRESS_RE,
    `${field}.takerQrlAccount`,
  );
  // A proposal signed for other accounts belongs to another taker, so it
  // could have this process fund a swap that pays someone else.
  for (const entry of intents) {
    if (
      entry.intent.takerEthAccount !== takerEthAccount ||
      entry.intent.takerQrlAccount !== takerQrlAccount
    ) {
      throw new Error(`${field}.intents holds a proposal for other accounts`);
    }
  }
  const fillAcknowledged = flag(
    row["fillAcknowledged"],
    `${field}.fillAcknowledged`,
  );
  if (fillAcknowledged && fill === undefined) {
    throw new Error(`${field}.fillAcknowledged has no FillV2 behind it`);
  }
  // The FillV2 is what authorizes funding, so it is re-authenticated here
  // exactly as it was when it first arrived: signature, bindings to the
  // selected proposal, every window bound, and its semantic digest.
  if (fill !== undefined) {
    const selected = intents.find(
      (entry) => entry.intentDigest === selectedIntentDigest,
    );
    if (selected === undefined) {
      throw new Error(`${field}.fill names no retained proposal`);
    }
    const prelock = order.prelock;
    if (
      !fillBindingIsValid({
        fill: fill.fill,
        auth: fill.auth,
        orderAuth,
        recovery: {
          orderDigest,
          intent: { intent: selected.intent, auth: selected.auth },
          intentDigest: selected.intentDigest,
        },
        ...(prelock === undefined ? {} : { prelock }),
      }) ||
      !verifyProtocolV2Proof(
        order.makerQrlAccount,
        fill.auth,
        buildFillV1Payload(fill.fill, orderAuth, fill.auth),
      )
    ) {
      throw new Error(
        `${field}.fill does not authenticate the selected proposal`,
      );
    }
    const expectedFillDigest = computeFillDigest(
      fill.fill,
      orderAuth,
      fill.auth,
    );
    if (fillDigest !== undefined && fillDigest !== expectedFillDigest) {
      throw new Error(`${field}.fillDigest does not follow from its fill`);
    }
  }
  const asset = row["asset"];
  if (typeof asset !== "string" || !isAssetSymbol(asset) || asset !== order.asset) {
    throw new Error(`${field}.asset is malformed`);
  }
  const direction: Direction = order.direction;
  if (row["direction"] !== direction) {
    throw new Error(`${field}.direction is malformed`);
  }
  return {
    orderId,
    deployment: parseDeploymentIdentity(
      row["deployment"],
      `${field}.deployment`,
    ),
    orderDigest,
    order,
    orderAuth,
    asset,
    direction,
    takerEthAccount,
    takerQrlAccount,
    intents,
    selectedIntentDigest,
    ...(fill === undefined ? {} : { fill }),
    ...(fillDigest === undefined ? {} : { fillDigest }),
    fillAcknowledged,
    releaseObserved: flag(row["releaseObserved"], `${field}.releaseObserved`),
    approveSentAt: nullableUint(row["approveSentAt"], `${field}.approveSentAt`),
    lockSentAt: nullableUint(row["lockSentAt"], `${field}.lockSentAt`),
    claimSentAt: nullableUint(row["claimSentAt"], `${field}.claimSentAt`),
    refundSentAt: nullableUint(row["refundSentAt"], `${field}.refundSentAt`),
    outcome: parseOutcome(row["outcome"], `${field}.outcome`),
    createdAt: uint(row["createdAt"], `${field}.createdAt`),
    updatedAt: uint(row["updatedAt"], `${field}.updatedAt`),
  };
}

/** Build a fresh record for an order this client verified itself. */
export function newTakerSwapRecord(args: {
  verified: { id: string; signed: SignedOrderV1; orderDigest: string; asset: AssetSymbol; direction: Direction };
  deployment: DeploymentIdentity;
  takerEthAccount: string;
  takerQrlAccount: string;
  nowS: number;
}): TakerSwapRecord {
  return {
    orderId: args.verified.id,
    deployment: args.deployment,
    orderDigest: args.verified.orderDigest,
    order: args.verified.signed.order,
    orderAuth: args.verified.signed.auth,
    asset: args.verified.asset,
    direction: args.verified.direction,
    takerEthAccount: args.takerEthAccount,
    takerQrlAccount: args.takerQrlAccount,
    intents: [],
    selectedIntentDigest: null,
    fillAcknowledged: false,
    releaseObserved: false,
    approveSentAt: null,
    lockSentAt: null,
    claimSentAt: null,
    refundSentAt: null,
    outcome: null,
    createdAt: args.nowS,
    updatedAt: args.nowS,
  };
}

export function selectedIntent(
  record: TakerSwapRecord,
): TakerIntentRecord | null {
  if (record.selectedIntentDigest === null) return null;
  return (
    record.intents.find(
      (intent) => intent.intentDigest === record.selectedIntentDigest,
    ) ?? null
  );
}

/** The newest proposal, whether or not a maker selected it. */
export function latestIntent(
  record: TakerSwapRecord,
): TakerIntentRecord | null {
  return record.intents[record.intents.length - 1] ?? null;
}

export function signedIntentOf(
  intent: TakerIntentRecord,
): SignedFillIntentV1 {
  return { intent: intent.intent, auth: intent.auth };
}

/** Re-derive the verified order view a record was created from, so the
 *  settlement path never has to trust the live book for signed terms. */
export function recordOrderRow(record: TakerSwapRecord): BookOrderRow {
  const prelock = record.order.prelock;
  return {
    id: record.orderId,
    direction: record.direction,
    asset: record.asset,
    fromAmount: record.order.fromAmount,
    toAmount: record.order.toAmount,
    makerEthAccount: record.order.makerEthAccount,
    makerQrlAccount: record.order.makerQrlAccount,
    status: "open",
    takerEthAccount: null,
    takerQrlAccount: null,
    hashlock: prelock === undefined ? null : prelock.hashlock,
    initiatorTimeout: prelock === undefined ? null : prelock.initiatorTimeout,
    responderTimeout: null,
    released: false,
    makerSeen: null,
    visibility: "public",
    prelocked: prelock !== undefined,
    makerAuth: record.orderAuth,
    orderDigest: record.orderDigest,
    equivocated: false,
    conflictDigests: [],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** The accounts a state file's records must belong to. */
export interface TakerIdentity {
  ethAccount: string;
  qrlAccount: string;
}

export class TakerStateFile {
  private swaps = new Map<string, TakerSwapRecord>();
  private poisoned: Error | null = null;

  constructor(
    private readonly file: string,
    private readonly deployment: DeploymentIdentity,
    /** Ownership gate for every write, normally the process lease. */
    private readonly assertOwned: () => void = () => {},
    /**
     * The keys this process loaded. A record for other accounts is refused:
     * its recipient fields would decide who gets paid while this process
     * funds the swap, so a shared state file must never be driven by the
     * wrong identity.
     */
    private readonly identity?: TakerIdentity,
    private readonly syncDirectory: (directory: string) => void = fsyncDirectory,
  ) {
    let raw: string | null = null;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (err) {
      // Only a missing file is a first run. Any other read failure on a
      // secret-holding file must not silently start empty, or the next
      // write would overwrite live recovery material.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (raw === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw recoveryError(this.file, "state envelope is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw recoveryError(this.file, "state envelope is malformed");
    }
    const envelope = parsed as Record<string, unknown>;
    if (
      envelope["version"] !== 1 ||
      envelope["role"] !== "taker" ||
      !Array.isArray(envelope["swaps"])
    ) {
      throw recoveryError(
        this.file,
        "state envelope version, role or swap list is malformed",
      );
    }
    let fileDeployment: DeploymentIdentity;
    try {
      fileDeployment = parseDeploymentIdentity(
        envelope["deployment"],
        `taker state file ${this.file} deployment identity`,
      );
    } catch (err) {
      throw recoveryError(
        this.file,
        err instanceof Error ? err.message : "deployment identity is malformed",
      );
    }
    if (!sameDeployment(fileDeployment, this.deployment)) {
      throw recoveryError(
        this.file,
        `deployment fingerprint ${fileDeployment.configFingerprint} does not match configured ${this.deployment.configFingerprint}`,
      );
    }
    for (const [index, value] of envelope["swaps"].entries()) {
      let record: TakerSwapRecord;
      try {
        record = parseTakerSwapRecord(value, `swap ${index}`);
      } catch (err) {
        throw recoveryError(
          this.file,
          err instanceof Error ? err.message : `swap ${index} is malformed`,
        );
      }
      if (
        !sameDeployment(record.deployment, fileDeployment) ||
        !sameDeployment(record.deployment, this.deployment)
      ) {
        throw recoveryError(
          this.file,
          `swap ${record.orderId} belongs to another deployment`,
        );
      }
      // The maker proof must still authenticate on hydration, expired or
      // not: a record whose terms no longer verify is never acted on.
      if (
        verifyMakerOrder(recordOrderRow(record), {
          now: record.orderAuth.issuedAt,
          allowExpired: true,
        }) === null
      ) {
        throw recoveryError(
          this.file,
          `swap ${record.orderId} holds an order proof that no longer verifies`,
        );
      }
      this.assertIdentity(record);
      this.swaps.set(record.orderId, record);
    }
  }

  all(): TakerSwapRecord[] {
    this.assertHealthy();
    return [...this.swaps.values()].map((record) => structuredClone(record));
  }

  get(orderId: string): TakerSwapRecord | null {
    this.assertHealthy();
    const record = this.swaps.get(orderId);
    return record === undefined ? null : structuredClone(record);
  }

  /** Write one record, then return the durable copy. The caller sends only
   *  after this resolves, so a crash can never leave a send unrecorded. */
  upsert(record: TakerSwapRecord): TakerSwapRecord {
    this.assertHealthy();
    if (!sameDeployment(record.deployment, this.deployment)) {
      throw recoveryError(
        this.file,
        `swap ${record.orderId} belongs to another deployment`,
      );
    }
    if (record.intents.length > MAX_RETAINED_INTENTS) {
      throw new Error(
        `swap ${record.orderId} retains more proposals than the protocol allows`,
      );
    }
    this.assertIdentity(record);
    const previous = this.swaps.get(record.orderId);
    const stored = structuredClone(record);
    this.swaps.set(record.orderId, stored);
    try {
      this.persist();
    } catch (err) {
      if (this.poisoned === null) {
        if (previous === undefined) this.swaps.delete(record.orderId);
        else this.swaps.set(record.orderId, previous);
      }
      throw err;
    }
    return structuredClone(stored);
  }

  delete(orderId: string): void {
    this.assertHealthy();
    const previous = this.swaps.get(orderId);
    if (previous === undefined) return;
    this.swaps.delete(orderId);
    try {
      this.persist();
    } catch (err) {
      if (this.poisoned === null) this.swaps.set(orderId, previous);
      throw err;
    }
  }

  private assertHealthy(): void {
    if (this.poisoned !== null) throw this.poisoned;
  }

  private assertIdentity(record: TakerSwapRecord): void {
    const identity = this.identity;
    if (identity === undefined) return;
    if (
      record.takerEthAccount !== identity.ethAccount.toLowerCase() ||
      record.takerQrlAccount !== identity.qrlAccount
    ) {
      throw recoveryError(
        this.file,
        `swap ${record.orderId} belongs to other taker accounts, so the keys this process loaded must not drive it`,
      );
    }
  }

  private persist(): void {
    // The only path that touches the file, so one ownership check here
    // blocks every write a displaced process could still attempt.
    this.assertOwned();
    const directory = dirname(this.file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tmp = join(
      directory,
      `.taker-state.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    const envelope: TakerStateEnvelope = {
      version: 1,
      role: "taker",
      deployment: this.deployment,
      swaps: [...this.swaps.values()],
    };
    let fileDescriptor: number | undefined;
    let renamed = false;
    try {
      fileDescriptor = openSync(tmp, "wx", 0o600);
      fchmodSync(fileDescriptor, 0o600);
      writeFileSync(fileDescriptor, JSON.stringify(envelope), "utf8");
      fsyncSync(fileDescriptor);
      closeSync(fileDescriptor);
      fileDescriptor = undefined;
      renameSync(tmp, this.file);
      renamed = true;
      this.syncDirectory(directory);
    } catch (error) {
      if (fileDescriptor !== undefined) {
        try {
          closeSync(fileDescriptor);
        } catch {
          // Preserve the original persistence failure.
        }
      }
      try {
        unlinkSync(tmp);
      } catch {
        // The rename may already have consumed the temporary file.
      }
      if (renamed) {
        this.poisoned = new TakerStateFilePoisonedError(
          `taker state file ${this.file} reached disk but its directory sync failed; refusing every further state operation until process restart`,
          { cause: error },
        );
        throw this.poisoned;
      }
      throw error;
    }
  }
}
