// Persistence for managed orders. Preimages live here until their swap
// settles, so the file is written 0600 and atomically. Losing a preimage
// after our lock confirms would strand funds until the refund window.

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isAssetSymbol } from "./assets.js";
import { orderRetentionUntil, parseAdmissionRecords, type AdmissionRecord } from "./admission.js";
import {
  parseDeploymentIdentity,
  sameDeployment,
  type DeploymentIdentity,
} from "./deployment.js";
import type {
  FillIntentAuthV1,
  ManagedOrder,
  ManagedProtocolV1,
  SelectedFillIntentV1,
} from "./policy.js";
import {
  buildCancelV1Payload,
  buildFillV1Payload,
  buildOrderV1Payload,
  capabilityCommitment,
  computeCancelDigest,
  computeFillDigest,
  computeFillIntentDigest,
  computeOrderDigest,
  deriveOrderV1Id,
  EMPTY_CAPABILITY_COMMITMENT,
  MAKER_CAPABILITY_DOMAIN,
  verifyFillIntentV1,
  verifyOfficialV1Proof,
  type CanonicalOrderV1Body,
  type FillIntentV1Body,
  type MakerOrderAuthV1,
  type ProtocolAuthV1,
  type SignedCancelV1,
  type SignedFillV1,
} from "./protocol-signing.js";

interface StateEnvelope {
  version: 2;
  deployment: DeploymentIdentity;
  orders: ManagedOrder[];
  admissions: AdmissionRecord[];
}

type PersistedOrder = Omit<
  ManagedOrder,
  | "level"
  | "quotedMidMilli"
  | "announcedAt"
  | "sponsorSentAt"
  | "asset"
  | "deployment"
  | "protocol"
> & {
  level?: number;
  quotedMidMilli?: string | null;
  announcedAt?: number | null;
  sponsorSentAt?: number | null;
  asset?: string;
  deployment?: unknown;
  protocol?: unknown;
};

const BYTES32_RE = /^0x[0-9a-f]{64}$/;
const ETH_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
// V2 persistence binds the full QIP-55 identity; legacy proof state fails closed.
const QRL_ADDRESS_RE = /^Q[0-9a-f]{128}$/;
const AMOUNT_RE = /^(?:0|[1-9][0-9]{0,29})$/;
const HEX_RE = /^0x[0-9a-f]+$/;
const DESCRIPTOR_RE = /^0x[0-9a-f]{6}$/;

interface LeaseRecord {
  /** 2 records carry pidNamespace. 1 records predate container awareness. */
  version: 1 | 2;
  pid: number;
  processStart: string;
  bootId: string;
  /** Absent in v1 records, so its absence means "assume our own namespace". */
  pidNamespace?: string;
  identityDigest: string;
  leaseId: string;
}

export interface StateLeaseIdentity {
  deploymentFingerprint: string;
  ethAccount: string;
  qrlAccount: string;
}

/**
 * How long a lease written from another PID namespace stays live after its
 * last heartbeat. PID and process start time are meaningless across
 * namespaces, so a peer container is judged by heartbeat freshness alone. A
 * container that dies without releasing blocks its replacement for at most
 * this long.
 */
export const LEASE_TTL_MS = 90_000;

/** Heartbeat period. Well under LEASE_TTL_MS so a slow tick cannot expire us. */
export const LEASE_HEARTBEAT_INTERVAL_MS = 10_000;

export interface StateLeaseAcquireOptions {
  /** Test and embedding seam for deterministic acquisition interleavings. */
  afterStaleObservation?: () => void;
  /** Test seam: observe the lease as a process in this PID namespace. */
  pidNamespace?: string | null;
  /** Test seam: clock used for foreign-namespace heartbeat freshness. */
  now?: () => number;
  /** Test seam: foreign-namespace heartbeat lifetime in milliseconds. */
  ttlMs?: number;
}

export class StateFilePoisonedError extends Error {}

/** Raised once the lease file no longer carries this process's lease id. */
export class StateLeaseLostError extends Error {}

function processStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const suffix = stat
      .slice(stat.lastIndexOf(") ") + 2)
      .trim()
      .split(/\s+/);
    return suffix[19] ?? null;
  } catch {
    return null;
  }
}

function bootId(): string {
  return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

/**
 * This process's PID namespace, as `pid:[4026531836]`. Two containers on one
 * state volume differ here, and each one's PIDs are invisible to the other.
 */
function currentPidNamespace(): string | null {
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return null;
  }
}

function parseLease(raw: string): LeaseRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<LeaseRecord>;
    if (
      (value.version !== 1 && value.version !== 2) ||
      typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.processStart !== "string" ||
      typeof value.bootId !== "string" ||
      (value.pidNamespace !== undefined &&
        typeof value.pidNamespace !== "string") ||
      typeof value.identityDigest !== "string" ||
      typeof value.leaseId !== "string"
    ) {
      return null;
    }
    return value as LeaseRecord;
  } catch {
    return null;
  }
}

function fsyncDirectory(directory: string): void {
  const directoryDescriptor = openSync(directory, "r");
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
}

const leaseContentionWait = new Int32Array(new SharedArrayBuffer(4));

function waitForLeaseRecovery(): void {
  Atomics.wait(leaseContentionWait, 0, 0, 10);
}

/** A lease file as observed on disk: its parsed record plus its heartbeat. */
interface ObservedLease {
  /** null when the file exists but holds no usable record. */
  record: LeaseRecord | null;
  mtimeMs: number;
}

type LiveObservedLease = ObservedLease & { record: LeaseRecord };

interface LeaseLiveness {
  bootId: string;
  pidNamespace: string | null;
  now: () => number;
  ttlMs: number;
}

/** True when the record's PID and process start time are readable from here. */
function usesPidSemantics(
  record: LeaseRecord,
  liveness: LeaseLiveness,
): boolean {
  // A v1 record carries no namespace. Single-host deployments from before
  // this format write those, so they keep the original PID semantics and
  // upgrade themselves on their next restart.
  if (record.pidNamespace === undefined) return true;
  return (
    record.pidNamespace === liveness.pidNamespace &&
    record.bootId === liveness.bootId
  );
}

function isLiveLease(
  observed: ObservedLease | undefined,
  liveness: LeaseLiveness,
): observed is LiveObservedLease {
  if (observed === undefined || observed.record === null) return false;
  const record = observed.record;
  if (usesPidSemantics(record, liveness)) {
    return (
      record.bootId === liveness.bootId &&
      processStart(record.pid) === record.processStart
    );
  }
  // Another PID namespace or another boot, so another container or host. The
  // recorded PID tells us nothing here: the number is either absent or owned
  // by an unrelated process. Only the heartbeat on the lease file can say
  // whether that maker still runs.
  return liveness.now() - observed.mtimeMs < liveness.ttlMs;
}

function readLease(path: string): ObservedLease | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    // Contents and heartbeat come from one descriptor, so a concurrent
    // replacement cannot pair one holder's record with another's timestamp.
    const raw = readFileSync(descriptor, "utf8");
    return { record: parseLease(raw), mtimeMs: fstatSync(descriptor).mtimeMs };
  } finally {
    closeSync(descriptor);
  }
}

function tryCreateLeaseFile(
  path: string,
  record: LeaseRecord,
  directory: string,
): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, JSON.stringify(record), "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(directory);
  return true;
}

function replaceStaleLeaseFile(
  path: string,
  record: LeaseRecord,
  directory: string,
): void {
  const stagedPath = `${path}.next.${process.pid}.${randomBytes(8).toString("hex")}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(stagedPath, "wx", 0o600);
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, JSON.stringify(record), "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(stagedPath, path);
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the replacement failure.
      }
    }
    try {
      unlinkSync(stagedPath);
    } catch {
      // A successful rename already consumed the staged path.
    }
    throw error;
  }
}

function releaseOwnedLeaseFile(
  path: string,
  leaseId: string,
  directory: string,
): void {
  const current = readLease(path);
  if (current === undefined || current.record?.leaseId !== leaseId) return;
  unlinkSync(path);
  fsyncDirectory(directory);
}

function heldLeaseMessage(
  path: string,
  observed: LiveObservedLease,
  liveness: LeaseLiveness,
): string {
  const refusal = "refusing a second market maker instance";
  if (usesPidSemantics(observed.record, liveness)) {
    return `state lease ${path} is held by live process ${observed.record.pid}; ${refusal}`;
  }
  const ageS = Math.max(
    0,
    Math.round((liveness.now() - observed.mtimeMs) / 1000),
  );
  return (
    `state lease ${path} is held by a maker in another PID namespace or another host boot, which ` +
    `means another container or machine on this state volume, so its PID cannot be inspected from ` +
    `here. Its heartbeat is the liveness signal: last refreshed ${ageS} s ago, and live for ` +
    `${Math.round(liveness.ttlMs / 1000)} s after each refresh. Stop that maker first, or wait for ` +
    `its heartbeat to expire if it already crashed; ${refusal}`
  );
}

/** Exclusive process lease for one state file and operator-key identity. */
export class StateProcessLease {
  private closed = false;
  private lost = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  private constructor(
    readonly path: string,
    private readonly leaseId: string,
  ) {}

  static acquire(
    stateFile: string,
    identity: StateLeaseIdentity,
    options: StateLeaseAcquireOptions = {},
  ): StateProcessLease {
    const path = `${stateFile}.lock`;
    const recoveryPath = `${path}.recovery`;
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const identityDigest = createHash("sha256")
      .update(JSON.stringify(identity))
      .digest("hex");
    const currentStart = processStart(process.pid);
    if (currentStart === null)
      throw new Error("cannot determine market maker process identity");
    const currentNamespace =
      options.pidNamespace === undefined
        ? currentPidNamespace()
        : options.pidNamespace;
    const liveness: LeaseLiveness = {
      bootId: bootId(),
      pidNamespace: currentNamespace,
      now: options.now ?? Date.now,
      ttlMs: options.ttlMs ?? LEASE_TTL_MS,
    };
    const makeRecord = (leaseId: string): LeaseRecord => ({
      version: 2,
      pid: process.pid,
      processStart: currentStart,
      bootId: liveness.bootId,
      ...(currentNamespace === null ? {} : { pidNamespace: currentNamespace }),
      identityDigest,
      leaseId,
    });
    let staleObservationNotified = false;

    for (let attempt = 0; attempt < 500; attempt += 1) {
      const observed = readLease(path);
      if (isLiveLease(observed, liveness)) {
        throw new Error(heldLeaseMessage(path, observed, liveness));
      }
      if (observed !== undefined && !staleObservationNotified) {
        staleObservationNotified = true;
        options.afterStaleObservation?.();
      }

      const recoveryLeaseId = randomBytes(32).toString("hex");
      const recoveryRecord = makeRecord(recoveryLeaseId);
      if (!tryCreateLeaseFile(recoveryPath, recoveryRecord, directory)) {
        const recoveryOwner = readLease(recoveryPath);
        if (
          recoveryOwner !== undefined &&
          recoveryOwner.record !== null &&
          !isLiveLease(recoveryOwner, liveness)
        ) {
          throw new Error(
            `state lease recovery guard ${recoveryPath} is stale; refusing unsafe automatic removal`,
          );
        }
        waitForLeaseRecovery();
        continue;
      }

      try {
        // The first stale read is only a hint. Ownership of the recovery
        // guard is the point where the active path may be checked and either
        // created or replaced. The replacement is atomic, so the main lease
        // never has an absent window where another starter can slip in.
        const current = readLease(path);
        if (isLiveLease(current, liveness)) {
          throw new Error(heldLeaseMessage(path, current, liveness));
        }
        const leaseId = randomBytes(32).toString("hex");
        const record = makeRecord(leaseId);
        if (current === undefined) {
          if (!tryCreateLeaseFile(path, record, directory)) continue;
        } else {
          replaceStaleLeaseFile(path, record, directory);
        }
        return new StateProcessLease(path, leaseId);
      } finally {
        releaseOwnedLeaseFile(recoveryPath, recoveryLeaseId, directory);
      }
    }
    throw new Error(
      `state lease ${path} remained contended during stale-lock recovery`,
    );
  }

  /**
   * Keep the lease file's heartbeat fresh so peers in other PID namespaces
   * can see that this maker still runs, and detect the moment the lease stops
   * being ours. onLost fires at most once and stops the timer with it.
   */
  startHeartbeat(
    onLost: () => void,
    intervalMs: number = LEASE_HEARTBEAT_INTERVAL_MS,
  ): void {
    if (this.heartbeat !== undefined || this.closed || this.lost) return;
    this.heartbeat = setInterval(() => {
      this.beat(onLost);
    }, intervalMs);
    // The maker's own work keeps the loop alive. A heartbeat must never be
    // the reason the process stays up.
    this.heartbeat.unref();
  }

  /** Throws once the lease file no longer carries our lease id. */
  assertOwned(): void {
    if (this.lost) {
      throw new StateLeaseLostError(
        `state lease ${this.path} is no longer held by this process; refusing to write state a displaced maker no longer owns`,
      );
    }
    if (this.closed) {
      throw new StateLeaseLostError(
        `state lease ${this.path} was released by this process; refusing to write state after shutdown`,
      );
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    let current: ObservedLease | undefined;
    try {
      current = readLease(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (current === undefined || current.record?.leaseId !== this.leaseId)
      return;
    unlinkSync(this.path);
    fsyncDirectory(dirname(this.path));
  }

  private beat(onLost: () => void): void {
    if (this.closed || this.lost) return;
    let observed: ObservedLease | undefined;
    try {
      observed = readLease(this.path);
    } catch {
      // A transient read failure is not proof of displacement. Skipping this
      // beat lets our own heartbeat age, so a peer can still take over after
      // the TTL if the failure persists.
      return;
    }
    if (observed === undefined || observed.record?.leaseId !== this.leaseId) {
      this.lost = true;
      this.stopHeartbeat();
      onLost();
      return;
    }
    try {
      const stamp = new Date();
      utimesSync(this.path, stamp, stamp);
    } catch {
      // Same reasoning as a failed read: retry on the next beat.
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeat === undefined) return;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
}

function proofObject(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${field} is malformed`);
  }
  return raw as Record<string, unknown>;
}

function exactProofKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const expected = new Set(keys);
  if (
    Object.keys(value).length !== expected.size ||
    Object.keys(value).some((key) => !expected.has(key))
  ) {
    throw new Error(`${field} has unsupported or missing fields`);
  }
}

function proofString(raw: unknown, pattern: RegExp, field: string): string {
  if (typeof raw !== "string" || !pattern.test(raw)) {
    throw new Error(`${field} is malformed`);
  }
  return raw;
}

function proofInteger(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new Error(`${field} is malformed`);
  }
  return raw;
}

function parseIntentAuth(
  raw: unknown,
  field: string,
  maxLifetimeS = 120,
): FillIntentAuthV1 {
  const auth = proofObject(raw, field);
  exactProofKeys(
    auth,
    [
      "version",
      "scheme",
      "issuedAt",
      "expiresAt",
      "nonce",
      "signature",
      "publicKey",
      "descriptor",
    ],
    field,
  );
  if (auth["version"] !== "2") throw new Error(`${field}.version is malformed`);
  const scheme = auth["scheme"];
  if (scheme !== "qrl-sign-message-v2") {
    throw new Error(`${field}.scheme is malformed`);
  }
  const issuedAt = proofInteger(auth["issuedAt"], `${field}.issuedAt`);
  const expiresAt = proofInteger(auth["expiresAt"], `${field}.expiresAt`);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > maxLifetimeS) {
    throw new Error(`${field} lifetime is malformed`);
  }
  return {
    version: "2",
    scheme,
    issuedAt,
    expiresAt,
    nonce: proofString(auth["nonce"], BYTES32_RE, `${field}.nonce`),
    signature: proofString(auth["signature"], HEX_RE, `${field}.signature`),
    publicKey: proofString(auth["publicKey"], HEX_RE, `${field}.publicKey`),
    descriptor: proofString(
      auth["descriptor"],
      DESCRIPTOR_RE,
      `${field}.descriptor`,
    ),
  };
}

function parseMakerAuth(raw: unknown, field: string): MakerOrderAuthV1 {
  const value = proofObject(raw, field);
  exactProofKeys(
    value,
    [
      "version",
      "scheme",
      "issuedAt",
      "expiresAt",
      "nonce",
      "makerTokenCommitment",
      "shareTokenCommitment",
      "signature",
      "publicKey",
      "descriptor",
    ],
    field,
  );
  const auth = parseIntentAuth(
    {
      version: value["version"],
      scheme: value["scheme"],
      issuedAt: value["issuedAt"],
      expiresAt: value["expiresAt"],
      nonce: value["nonce"],
      signature: value["signature"],
      publicKey: value["publicKey"],
      descriptor: value["descriptor"],
    },
    field,
    48 * 3600,
  );
  if (auth.scheme !== "qrl-sign-message-v2" || auth.descriptor !== "0x010000") {
    throw new Error(`${field} is not a headless maker proof`);
  }
  return {
    ...auth,
    scheme: "qrl-sign-message-v2",
    descriptor: "0x010000",
    makerTokenCommitment: proofString(
      value["makerTokenCommitment"],
      BYTES32_RE,
      `${field}.makerTokenCommitment`,
    ),
    shareTokenCommitment: proofString(
      value["shareTokenCommitment"],
      BYTES32_RE,
      `${field}.shareTokenCommitment`,
    ),
  };
}

function verifyMakerProof(
  signer: string,
  auth: ProtocolAuthV1,
  payload: ReturnType<typeof buildOrderV1Payload>,
  field: string,
): void {
  if (!verifyOfficialV1Proof(signer, auth, payload)) {
    throw new Error(`${field} signature is malformed`);
  }
}

function parseTerminalMakerAuth(raw: unknown, field: string): ProtocolAuthV1 {
  const auth = parseIntentAuth(raw, field, 48 * 3600);
  if (auth.scheme !== "qrl-sign-message-v2" || auth.descriptor !== "0x010000") {
    throw new Error(`${field} is not a headless maker proof`);
  }
  return auth;
}

function parseCanonicalOrder(
  raw: unknown,
  field: string,
): CanonicalOrderV1Body {
  const order = proofObject(raw, field);
  const allowed = new Set([
    "direction",
    "asset",
    "fromAmount",
    "toAmount",
    "makerEthAccount",
    "makerQrlAccount",
    "visibility",
    "allowedTakerEth",
    "allowedTakerQrl",
    "prelock",
  ]);
  if (Object.keys(order).some((key) => !allowed.has(key))) {
    throw new Error(`${field} has unsupported fields`);
  }
  const direction = order["direction"];
  if (direction !== "eth->qrl" && direction !== "qrl->eth") {
    throw new Error(`${field}.direction is malformed`);
  }
  const asset = order["asset"];
  if (typeof asset !== "string" || !isAssetSymbol(asset)) {
    throw new Error(`${field}.asset is malformed`);
  }
  const visibility = order["visibility"];
  if (visibility !== "public" && visibility !== "private") {
    throw new Error(`${field}.visibility is malformed`);
  }
  const allowedTakerEth = order["allowedTakerEth"];
  const allowedTakerQrl = order["allowedTakerQrl"];
  if (
    visibility === "public" &&
    (allowedTakerEth !== undefined || allowedTakerQrl !== undefined)
  ) {
    throw new Error(`${field} public order cannot restrict the taker`);
  }
  let prelock: CanonicalOrderV1Body["prelock"];
  if (order["prelock"] !== undefined) {
    const rawPrelock = proofObject(order["prelock"], `${field}.prelock`);
    exactProofKeys(
      rawPrelock,
      ["hashlock", "initiatorTimeout"],
      `${field}.prelock`,
    );
    prelock = {
      hashlock: proofString(
        rawPrelock["hashlock"],
        BYTES32_RE,
        `${field}.prelock.hashlock`,
      ),
      initiatorTimeout: proofInteger(
        rawPrelock["initiatorTimeout"],
        `${field}.prelock.initiatorTimeout`,
      ),
    };
  }
  return {
    direction,
    asset,
    fromAmount: proofString(
      order["fromAmount"],
      AMOUNT_RE,
      `${field}.fromAmount`,
    ),
    toAmount: proofString(order["toAmount"], AMOUNT_RE, `${field}.toAmount`),
    makerEthAccount: proofString(
      order["makerEthAccount"],
      ETH_ADDRESS_RE,
      `${field}.makerEthAccount`,
    ),
    makerQrlAccount: proofString(
      order["makerQrlAccount"],
      QRL_ADDRESS_RE,
      `${field}.makerQrlAccount`,
    ),
    visibility,
    ...(allowedTakerEth === undefined
      ? {}
      : {
          allowedTakerEth: proofString(
            allowedTakerEth,
            ETH_ADDRESS_RE,
            `${field}.allowedTakerEth`,
          ),
        }),
    ...(allowedTakerQrl === undefined
      ? {}
      : {
          allowedTakerQrl: proofString(
            allowedTakerQrl,
            QRL_ADDRESS_RE,
            `${field}.allowedTakerQrl`,
          ),
        }),
    ...(prelock === undefined ? {} : { prelock }),
  };
}

function parseIntentBody(raw: unknown, field: string): FillIntentV1Body {
  const intent = proofObject(raw, field);
  exactProofKeys(
    intent,
    ["orderDigest", "takerEthAccount", "takerQrlAccount", "releaseCommitment"],
    field,
  );
  return {
    orderDigest: proofString(
      intent["orderDigest"],
      BYTES32_RE,
      `${field}.orderDigest`,
    ),
    takerEthAccount: proofString(
      intent["takerEthAccount"],
      ETH_ADDRESS_RE,
      `${field}.takerEthAccount`,
    ),
    takerQrlAccount: proofString(
      intent["takerQrlAccount"],
      QRL_ADDRESS_RE,
      `${field}.takerQrlAccount`,
    ),
    releaseCommitment: proofString(
      intent["releaseCommitment"],
      BYTES32_RE,
      `${field}.releaseCommitment`,
    ),
  };
}

function parseSelectedIntent(
  raw: unknown,
  field: string,
  orderDigest: string,
  orderAuth: MakerOrderAuthV1,
): SelectedFillIntentV1 {
  const selected = proofObject(raw, field);
  exactProofKeys(
    selected,
    ["intentDigest", "intent", "auth", "receivedAt"],
    field,
  );
  const intent = parseIntentBody(selected["intent"], `${field}.intent`);
  const auth = parseIntentAuth(selected["auth"], `${field}.auth`);
  const intentDigest = proofString(
    selected["intentDigest"],
    BYTES32_RE,
    `${field}.intentDigest`,
  );
  if (intent.orderDigest !== orderDigest)
    throw new Error(`${field} references another order`);
  if (computeFillIntentDigest(intent, auth) !== intentDigest) {
    throw new Error(`${field} digest is malformed`);
  }
  if (
    !verifyFillIntentV1(intent, auth, orderDigest, {
      now: auth.issuedAt,
      orderIssuedAt: orderAuth.issuedAt,
      orderExpiresAt: orderAuth.expiresAt,
    })
  ) {
    throw new Error(`${field} signature is malformed`);
  }
  return {
    intentDigest,
    intent,
    auth,
    receivedAt: proofInteger(selected["receivedAt"], `${field}.receivedAt`),
  };
}

function parseFillProof(
  raw: unknown,
  field: string,
  order: CanonicalOrderV1Body,
  orderAuth: MakerOrderAuthV1,
  selected: SelectedFillIntentV1,
  makerQrlAccount: string,
): SignedFillV1 {
  const wrapper = proofObject(raw, field);
  exactProofKeys(wrapper, ["fill", "auth"], field);
  const fillRow = proofObject(wrapper["fill"], `${field}.fill`);
  exactProofKeys(
    fillRow,
    [
      "orderDigest",
      "intentDigest",
      "takerEthAccount",
      "takerQrlAccount",
      "releaseCommitment",
      "hashlock",
      "initiatorTimeout",
      "responderTimeout",
    ],
    `${field}.fill`,
  );
  const fill = {
    orderDigest: proofString(
      fillRow["orderDigest"],
      BYTES32_RE,
      `${field}.fill.orderDigest`,
    ),
    intentDigest: proofString(
      fillRow["intentDigest"],
      BYTES32_RE,
      `${field}.fill.intentDigest`,
    ),
    takerEthAccount: proofString(
      fillRow["takerEthAccount"],
      ETH_ADDRESS_RE,
      `${field}.fill.takerEthAccount`,
    ),
    takerQrlAccount: proofString(
      fillRow["takerQrlAccount"],
      QRL_ADDRESS_RE,
      `${field}.fill.takerQrlAccount`,
    ),
    releaseCommitment: proofString(
      fillRow["releaseCommitment"],
      BYTES32_RE,
      `${field}.fill.releaseCommitment`,
    ),
    hashlock: proofString(
      fillRow["hashlock"],
      BYTES32_RE,
      `${field}.fill.hashlock`,
    ),
    initiatorTimeout: proofInteger(
      fillRow["initiatorTimeout"],
      `${field}.fill.initiatorTimeout`,
    ),
    responderTimeout: proofInteger(
      fillRow["responderTimeout"],
      `${field}.fill.responderTimeout`,
    ),
  };
  const auth = parseTerminalMakerAuth(wrapper["auth"], `${field}.auth`);
  computeFillDigest(fill, orderAuth, auth);
  verifyMakerProof(
    makerQrlAccount,
    auth,
    buildFillV1Payload(fill, orderAuth, auth),
    `${field}.auth`,
  );
  if (
    fill.orderDigest !== selected.intent.orderDigest ||
    fill.intentDigest !== selected.intentDigest ||
    fill.takerEthAccount !== selected.intent.takerEthAccount ||
    fill.takerQrlAccount !== selected.intent.takerQrlAccount ||
    fill.releaseCommitment !== selected.intent.releaseCommitment
  ) {
    throw new Error(`${field} does not select the persisted intent`);
  }
  if (fill.hashlock === `0x${"00".repeat(32)}`) {
    throw new Error(`${field} hashlock is zero`);
  }
  if (
    auth.scheme !== orderAuth.scheme ||
    auth.publicKey !== orderAuth.publicKey ||
    auth.descriptor !== orderAuth.descriptor ||
    auth.issuedAt < selected.auth.issuedAt ||
    auth.issuedAt >= selected.auth.expiresAt ||
    auth.expiresAt > orderAuth.expiresAt ||
    auth.expiresAt - auth.issuedAt < 60 ||
    auth.expiresAt - auth.issuedAt > 900 ||
    fill.responderTimeout - auth.expiresAt <= 600
  ) {
    throw new Error(`${field} maker authorization is malformed`);
  }
  const initiatorWindow = fill.initiatorTimeout - auth.issuedAt;
  const responderWindow = fill.responderTimeout - auth.issuedAt;
  if (
    responderWindow <= 0 ||
    initiatorWindow < responderWindow ||
    responderWindow > Math.floor(initiatorWindow / 2) ||
    responderWindow > 2 * 60 * 60 ||
    (order.prelock === undefined && initiatorWindow > 4 * 60 * 60)
  ) {
    throw new Error(`${field} timeout window is malformed`);
  }
  if (
    order.prelock !== undefined &&
    (fill.hashlock !== order.prelock.hashlock ||
      fill.initiatorTimeout !== order.prelock.initiatorTimeout)
  ) {
    throw new Error(`${field} does not match the signed prelock`);
  }
  return { fill, auth };
}

function parseCancelProof(
  raw: unknown,
  field: string,
  orderDigest: string,
  orderAuth: MakerOrderAuthV1,
  makerQrlAccount: string,
): SignedCancelV1 {
  const wrapper = proofObject(raw, field);
  exactProofKeys(wrapper, ["cancel", "auth"], field);
  const cancelRow = proofObject(wrapper["cancel"], `${field}.cancel`);
  exactProofKeys(cancelRow, ["orderDigest", "reasonCode"], `${field}.cancel`);
  const reasonCode = proofInteger(
    cancelRow["reasonCode"],
    `${field}.cancel.reasonCode`,
  );
  if (reasonCode > 255)
    throw new Error(`${field}.cancel.reasonCode is malformed`);
  const cancel = {
    orderDigest: proofString(
      cancelRow["orderDigest"],
      BYTES32_RE,
      `${field}.cancel.orderDigest`,
    ),
    reasonCode,
  };
  const auth = parseTerminalMakerAuth(wrapper["auth"], `${field}.auth`);
  computeCancelDigest(cancel, orderAuth, auth);
  verifyMakerProof(
    makerQrlAccount,
    auth,
    buildCancelV1Payload(cancel, orderAuth, auth),
    `${field}.auth`,
  );
  if (
    cancel.orderDigest !== orderDigest ||
    auth.scheme !== orderAuth.scheme ||
    auth.publicKey !== orderAuth.publicKey ||
    auth.descriptor !== orderAuth.descriptor ||
    auth.expiresAt !== orderAuth.expiresAt
  ) {
    throw new Error(`${field} maker authorization is malformed`);
  }
  return { cancel, auth };
}

function parseProtocol(
  raw: unknown,
  order: PersistedOrder,
): ManagedProtocolV1 | undefined {
  if (raw === undefined || raw === null) return undefined;
  const field = `order ${order.id} protocol state`;
  const protocol = proofObject(raw, field);
  const allowed = new Set([
    "version",
    "orderDigest",
    "order",
    "orderAuth",
    "fillAcknowledged",
    "releaseObserved",
    "selectedIntent",
    "fillProof",
    "cancelProof",
  ]);
  if (Object.keys(protocol).some((key) => !allowed.has(key))) {
    throw new Error(`${field} has unsupported fields`);
  }
  if (protocol["version"] !== 2)
    throw new Error(`${field}.version is malformed`);
  if (
    protocol["fillAcknowledged"] !== undefined &&
    typeof protocol["fillAcknowledged"] !== "boolean"
  ) {
    throw new Error(`${field}.fillAcknowledged is malformed`);
  }
  if (
    protocol["releaseObserved"] !== undefined &&
    typeof protocol["releaseObserved"] !== "boolean"
  ) {
    throw new Error(`${field}.releaseObserved is malformed`);
  }
  const fillAcknowledged = protocol["fillAcknowledged"] === true;
  const releaseObserved = protocol["releaseObserved"] === true;
  const orderBody = parseCanonicalOrder(protocol["order"], `${field}.order`);
  if (orderBody.visibility !== "public") {
    throw new Error(
      `${field} is private and unsupported by the headless market maker`,
    );
  }
  const orderAuth = parseMakerAuth(protocol["orderAuth"], `${field}.orderAuth`);
  if (
    orderAuth.makerTokenCommitment === EMPTY_CAPABILITY_COMMITMENT ||
    (orderBody.visibility === "public" &&
      orderAuth.shareTokenCommitment !== EMPTY_CAPABILITY_COMMITMENT)
  ) {
    throw new Error(`${field} capability commitments are malformed`);
  }
  if (
    typeof order.token !== "string" ||
    !/^[0-9a-f]{64}$/.test(order.token) ||
    capabilityCommitment(MAKER_CAPABILITY_DOMAIN, order.token) !==
      orderAuth.makerTokenCommitment
  ) {
    throw new Error(
      `${field} maker capability does not match its signed commitment`,
    );
  }
  if (orderBody.prelock !== undefined) {
    const prelockWindow =
      orderBody.prelock.initiatorTimeout - orderAuth.issuedAt;
    if (
      prelockWindow < 3 * 60 * 60 ||
      prelockWindow > 72 * 60 * 60 ||
      orderAuth.expiresAt > orderBody.prelock.initiatorTimeout
    ) {
      throw new Error(`${field} prelock window is malformed`);
    }
  }
  const orderDigest = proofString(
    protocol["orderDigest"],
    BYTES32_RE,
    `${field}.orderDigest`,
  );
  if (computeOrderDigest(orderBody, orderAuth) !== orderDigest) {
    throw new Error(`${field}.orderDigest is malformed`);
  }
  verifyMakerProof(
    orderBody.makerQrlAccount,
    orderAuth,
    buildOrderV1Payload(orderBody, orderAuth),
    `${field}.orderAuth`,
  );
  if (
    order.id !== deriveOrderV1Id(orderBody.makerQrlAccount, orderAuth.nonce)
  ) {
    throw new Error(`${field} order id is malformed`);
  }
  if (
    order.direction !== orderBody.direction ||
    order.asset !== orderBody.asset ||
    order.fromAmount !== orderBody.fromAmount ||
    order.toAmount !== orderBody.toAmount
  ) {
    throw new Error(`${field} economic projection is malformed`);
  }

  const selectedIntent =
    protocol["selectedIntent"] === undefined ||
    protocol["selectedIntent"] === null
      ? undefined
      : parseSelectedIntent(
          protocol["selectedIntent"],
          `${field}.selectedIntent`,
          orderDigest,
          orderAuth,
        );
  const fillProof =
    protocol["fillProof"] === undefined || protocol["fillProof"] === null
      ? undefined
      : selectedIntent === undefined
        ? (() => {
            throw new Error(`${field}.fillProof has no selected intent`);
          })()
        : parseFillProof(
            protocol["fillProof"],
            `${field}.fillProof`,
            orderBody,
            orderAuth,
            selectedIntent,
            orderBody.makerQrlAccount,
          );
  const cancelProof =
    protocol["cancelProof"] === undefined || protocol["cancelProof"] === null
      ? undefined
      : parseCancelProof(
          protocol["cancelProof"],
          `${field}.cancelProof`,
          orderDigest,
          orderAuth,
          orderBody.makerQrlAccount,
        );
  if (fillProof !== undefined && cancelProof !== undefined) {
    throw new Error(`${field} contains conflicting terminal proofs`);
  }
  if (fillAcknowledged && fillProof === undefined) {
    throw new Error(`${field}.fillAcknowledged has no fill proof`);
  }
  if (releaseObserved && (!fillAcknowledged || fillProof === undefined)) {
    throw new Error(`${field}.releaseObserved has no acknowledged fill proof`);
  }
  if (selectedIntent !== undefined) {
    if (
      order.preimage === null ||
      order.hashlock === null ||
      order.initiatorTimeout === null ||
      order.responderTimeout === null ||
      order.takerEthAccount !== selectedIntent.intent.takerEthAccount ||
      order.takerQrlAccount !== selectedIntent.intent.takerQrlAccount
    ) {
      throw new Error(`${field} selected intent projection is malformed`);
    }
    const preimage = proofString(
      order.preimage,
      BYTES32_RE,
      `${field} preimage`,
    );
    const derivedHashlock = `0x${createHash("sha256")
      .update(Buffer.from(preimage.slice(2), "hex"))
      .digest("hex")}`;
    if (derivedHashlock !== order.hashlock)
      throw new Error(`${field} hashlock is malformed`);
  }
  if (
    fillProof !== undefined &&
    (fillProof.fill.hashlock !== order.hashlock ||
      fillProof.fill.initiatorTimeout !== order.initiatorTimeout ||
      fillProof.fill.responderTimeout !== order.responderTimeout)
  ) {
    throw new Error(`${field} fill projection is malformed`);
  }
  if (cancelProof !== undefined && selectedIntent !== undefined) {
    throw new Error(`${field} cancellation follows an intent selection`);
  }
  return {
    version: 2,
    orderDigest,
    order: orderBody,
    orderAuth,
    fillAcknowledged,
    releaseObserved,
    ...(selectedIntent === undefined ? {} : { selectedIntent }),
    ...(fillProof === undefined ? {} : { fillProof }),
    ...(cancelProof === undefined ? {} : { cancelProof }),
  };
}

const recoveryError = (file: string, reason: string): Error =>
  new Error(
    `state file ${file}: ${reason}; refusing to run or re-lock. The file was left untouched. ` +
      "Use the original chain/HTLC configuration to settle or manually refund its orders",
  );

export class StateFile {
  private orders = new Map<string, ManagedOrder>();
  private admissions = new Map<string, number>();
  private poisoned: Error | null = null;

  constructor(
    private readonly file: string,
    private readonly deployment: DeploymentIdentity,
    private readonly syncDirectory: (
      directory: string,
    ) => void = fsyncDirectory,
    /**
     * Ownership gate for every write. The process lease passes its
     * assertOwned here, so a maker displaced by another container stops
     * writing the state file the new holder now owns.
     */
    private readonly assertOwned: () => void = () => {},
  ) {
    let raw: string | null = null;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (err) {
      // Only a missing file is a first boot. Any other read failure on a
      // preimage-holding file must not silently start empty: the next
      // persist() would overwrite whatever is on disk.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (raw === null) return;

    // The pre-deployment-identity format was a bare order array. An empty
    // array contains no recovery material and can be safely bound in place.
    // A non-empty one may contain locks on any prior HTLC, so never guess.
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      if (parsed.length > 0) {
        throw recoveryError(
          this.file,
          "non-empty legacy state has no deployment identity",
        );
      }
      this.persist();
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw recoveryError(this.file, "state envelope is malformed");
    }
    const envelope = parsed as Record<string, unknown>;
    if ((envelope.version !== 1 && envelope.version !== 2) || !Array.isArray(envelope.orders)) {
      throw recoveryError(
        this.file,
        "state envelope version or order list is malformed",
      );
    }
    let fileDeployment: DeploymentIdentity;
    try {
      fileDeployment = parseDeploymentIdentity(
        envelope.deployment,
        `state file ${this.file} deployment identity`,
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
    if (envelope.version === 2 || envelope.admissions !== undefined) {
      for (const entry of parseAdmissionRecords(envelope.admissions)) {
        this.admissions.set(entry.id, entry.retainUntil);
      }
    }

    // Records carry live preimages, so a state file this build cannot
    // interpret must stop the daemon loudly. Skipping or relabeling one
    // could strand its swap, and a later persist would erase it.
    for (const value of envelope.orders) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw recoveryError(this.file, "an order record is malformed");
      }
      const order = value as PersistedOrder;
      if (typeof order.id !== "string" || order.id.length === 0) {
        throw recoveryError(this.file, "an order has no valid id");
      }
      const asset = order.asset ?? "ETH";
      if (!isAssetSymbol(asset)) {
        throw recoveryError(
          this.file,
          `order ${order.id} has unknown asset ${JSON.stringify(order.asset)}`,
        );
      }
      let orderDeployment: DeploymentIdentity;
      try {
        orderDeployment = parseDeploymentIdentity(
          order.deployment,
          `state file ${this.file} order ${order.id} deployment identity`,
        );
      } catch (err) {
        throw recoveryError(
          this.file,
          err instanceof Error
            ? err.message
            : `order ${order.id} deployment identity is malformed`,
        );
      }
      if (
        !sameDeployment(orderDeployment, fileDeployment) ||
        !sameDeployment(orderDeployment, this.deployment)
      ) {
        throw recoveryError(
          this.file,
          `order ${order.id} belongs to another deployment`,
        );
      }
      if (order.token !== null && typeof order.token !== "string") {
        throw recoveryError(
          this.file,
          `order ${order.id} has a malformed maker token`,
        );
      }
      let protocol: ManagedProtocolV1 | undefined;
      try {
        protocol = parseProtocol(order.protocol, { ...order, asset });
      } catch (err) {
        throw recoveryError(
          this.file,
          err instanceof Error
            ? err.message
            : `order ${order.id} protocol state is malformed`,
        );
      }
      if (protocol === undefined && order.token === null) {
        throw recoveryError(
          this.file,
          `legacy order ${order.id} has no maker token`,
        );
      }
      // These fields arrived before deployment binding. They remain
      // defaultable inside a correctly bound envelope so in-flight swaps
      // from that same deployment continue settling after an upgrade.
      const { protocol: _rawProtocol, ...persisted } = order;
      void _rawProtocol;
      this.orders.set(order.id, {
        ...persisted,
        level: order.level ?? 0,
        quotedMidMilli: order.quotedMidMilli ?? null,
        announcedAt: order.announcedAt ?? null,
        sponsorSentAt: order.sponsorSentAt ?? null,
        asset,
        deployment: orderDeployment,
        ...(protocol === undefined ? {} : { protocol }),
      });
      this.rememberAdmission(this.orders.get(order.id)!);
    }
  }

  all(): ManagedOrder[] {
    this.assertHealthy();
    return [...this.orders.values()].map((order) => structuredClone(order));
  }

  retainedAdmissionCount(now: number): number {
    this.assertHealthy();
    return [...this.admissions.values()].filter(until => until > now).length;
  }

  private rememberAdmission(order: ManagedOrder): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [id, until] of this.admissions) {
      if (until <= now) this.admissions.delete(id);
    }
    const until = orderRetentionUntil(order, now);
    if (until !== null) {
      this.admissions.set(order.id, Math.max(this.admissions.get(order.id) ?? 0, until));
    }
  }

  upsert(order: ManagedOrder): void {
    this.assertHealthy();
    if (!sameDeployment(order.deployment, this.deployment)) {
      throw recoveryError(
        this.file,
        `order ${order.id} belongs to another deployment`,
      );
    }
    const previous = this.orders.get(order.id);
    const previousAdmission = this.admissions.get(order.id);
    this.orders.set(order.id, structuredClone(order));
    this.rememberAdmission(order);
    try {
      this.persist();
    } catch (err) {
      if (this.poisoned === null) {
        if (previous === undefined) this.orders.delete(order.id);
        else this.orders.set(order.id, previous);
        if (previousAdmission === undefined) this.admissions.delete(order.id);
        else this.admissions.set(order.id, previousAdmission);
      }
      throw err;
    }
  }

  delete(id: string): void {
    this.assertHealthy();
    const previous = this.orders.get(id);
    this.orders.delete(id);
    try {
      this.persist();
    } catch (err) {
      if (this.poisoned === null && previous !== undefined)
        this.orders.set(id, previous);
      throw err;
    }
  }

  private assertHealthy(): void {
    if (this.poisoned !== null) throw this.poisoned;
  }

  private persist(): void {
    // This is the only path that touches the state file, so one check here
    // blocks every write a displaced process could still attempt.
    this.assertOwned();
    const directory = dirname(this.file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tmp = join(
      directory,
      `.state.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    const envelope: StateEnvelope = {
      version: 2,
      deployment: this.deployment,
      orders: this.all(),
      admissions: [...this.admissions.entries()]
        .filter(([, until]) => until > Math.floor(Date.now() / 1000))
        .map(([id, retainUntil]) => ({ id, retainUntil })),
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
        this.poisoned = new StateFilePoisonedError(
          `state file ${this.file} reached disk but its directory sync failed; refusing every further state operation until process restart`,
          { cause: error },
        );
        throw this.poisoned;
      }
      throw error;
    }
  }
}
