// Single-writer lease for the order book's data files. Two book processes on
// one data directory interleave a whole-file orders rewrite with an
// append-only feed log and destroy each other's state, so exactly one process
// may hold the files at a time.
//
// This is a hand-maintained port of the market maker's StateProcessLease in
// marketmaker/src/state.ts. The two packages are separate npm packages with
// their own lockfile, tsconfig (rootDir "src") and Docker build context, so a
// module shared from the repository root cannot be compiled into either
// package without reworking both builds. The copy stays behavior-compatible;
// fix both files when the algorithm changes. Two deliberate differences:
// wording is order-book wording, and the record is version 1 because the book
// has no earlier lease format to accept. Its field set matches the market
// maker's version 2 record.

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

interface LeaseRecord {
  version: 1;
  pid: number;
  processStart: string;
  bootId: string;
  pidNamespace: string;
  /** Diagnostic fingerprint of the protected file set. */
  identityDigest: string;
  leaseId: string;
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

/**
 * Tolerated clock skew on a heartbeat. A timestamp further ahead than this
 * came from a stepped-back clock here or a fast clock there, so the record is
 * treated as stale. Trusting it would hold the lease for another whole TTL.
 */
export const LEASE_CLOCK_SKEW_MS = 30_000;

/**
 * Recorded when this process cannot read its own PID namespace, its own
 * process start time, or the kernel boot id. It never matches a live PID
 * check, so such a record is judged by its heartbeat alone.
 */
export const UNKNOWN_PID_NAMESPACE = "unknown";

export interface ProcessLeaseAcquireOptions {
  /** Test and embedding seam for deterministic acquisition interleavings. */
  afterStaleObservation?: () => void;
  /** Test seam: observe the lease as a process in this PID namespace. */
  pidNamespace?: string | null;
  /** Test seam: clock used for foreign-namespace heartbeat freshness. */
  now?: () => number;
  /** Test seam: foreign-namespace heartbeat lifetime in milliseconds. */
  ttlMs?: number;
}

/** Raised once the lease file provably stopped carrying our lease id. */
export class ProcessLeaseLostError extends Error {
  override name = "ProcessLeaseLostError";
}

/**
 * Raised when ownership can neither be confirmed nor disproved, which a
 * transient read failure causes. The write is refused, so nothing reaches the
 * data files, and the lease is still held: only the heartbeat's run of
 * consecutive failures turns this into a real loss.
 */
export class ProcessLeaseUnverifiableError extends Error {
  override name = "ProcessLeaseUnverifiableError";
}

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

function bootId(): string | null {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * This process's PID namespace, as `pid:[4026531836]`. Two containers on one
 * state volume differ here, and each one's PIDs are invisible to the other.
 * An unreadable namespace is recorded as UNKNOWN_PID_NAMESPACE, which never
 * matches anything, so such a record is judged by its heartbeat.
 */
function currentPidNamespace(): string {
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return UNKNOWN_PID_NAMESPACE;
  }
}

function parseLease(raw: string): LeaseRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<LeaseRecord>;
    if (
      value.version !== 1 ||
      typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.processStart !== "string" ||
      typeof value.bootId !== "string" ||
      typeof value.pidNamespace !== "string" ||
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
  pidNamespace: string;
  now: () => number;
  ttlMs: number;
}

/** True when the record's PID and process start time are readable from here. */
function usesPidSemantics(
  record: LeaseRecord,
  liveness: LeaseLiveness,
): boolean {
  // An unknown namespace proves nothing about PID visibility, so the
  // heartbeat decides. Checked for this process first: without our own
  // namespace every record is foreign.
  if (liveness.pidNamespace === UNKNOWN_PID_NAMESPACE) return false;
  if (record.pidNamespace === UNKNOWN_PID_NAMESPACE) return false;
  return (
    record.pidNamespace === liveness.pidNamespace &&
    record.bootId === liveness.bootId
  );
}

/** Milliseconds since the observed heartbeat. Negative when it is ahead. */
function heartbeatAgeMs(
  observed: ObservedLease,
  liveness: LeaseLiveness,
): number {
  return liveness.now() - observed.mtimeMs;
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
  // whether that book still runs.
  const age = heartbeatAgeMs(observed, liveness);
  // A timestamp from the future is untrustworthy in both directions, so it
  // expires the lease at once.
  if (age < -LEASE_CLOCK_SKEW_MS) return false;
  return age < liveness.ttlMs;
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

/**
 * Manual step named by every contention refusal, so one wording covers the
 * recovery guard and the lease itself.
 */
const LEASE_MANUAL_RECOVERY =
  'confirm no order book process runs on this data directory, then remove the file by hand (see "Single active writer" in docs/MIRROR_OPERATORS.md)';

/**
 * Drop staging files a crashed starter left behind between creating and
 * renaming a lease replacement. Only entries older than the heartbeat
 * lifetime are removed, so a live starter's staged file is never touched.
 * Called while the recovery guard is held.
 */
function sweepStagedLeaseFiles(
  path: string,
  directory: string,
  liveness: LeaseLiveness,
): void {
  const prefix = `${basename(path)}.next.`;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    // Housekeeping only. A directory this process cannot list still fails
    // loudly on the writes that matter.
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const staged = join(directory, entry);
    try {
      if (liveness.now() - statSync(staged).mtimeMs < liveness.ttlMs) continue;
      unlinkSync(staged);
    } catch {
      // Another starter may have consumed or removed it already.
    }
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
  const refusal = "refusing a second order book process on this data";
  if (usesPidSemantics(observed.record, liveness)) {
    return `data lease ${path} is held by live process ${observed.record.pid}; ${refusal}`;
  }
  // Printed signed and unrounded in direction: a negative age means the
  // holder's timestamp is ahead of this clock, which is worth seeing.
  const ageS = (heartbeatAgeMs(observed, liveness) / 1000).toFixed(1);
  return (
    `data lease ${path} is held by a book in another PID namespace or another host boot, which ` +
    `means another container on this data volume, so its PID cannot be inspected from here. Its ` +
    `heartbeat is the liveness signal: last refreshed ${ageS} s ago (a negative age means its ` +
    `clock runs ahead of this one), and live for ${Math.round(liveness.ttlMs / 1000)} s after each ` +
    `refresh. Stop that book first, or wait for its heartbeat to expire if it already crashed; ` +
    `${refusal}`
  );
}

/** Why a lease stopped being ours, named in the shutdown log and refusals. */
const LEASE_LOSS_REPLACED = "the lease file now carries another holder's lease id";
const LEASE_LOSS_REMOVED = "the lease file was removed";

/** Exclusive process lease for one protected file. */
export class ProcessLease {
  private closed = false;
  private lost = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private onLost: ((reason: string) => void) | undefined;
  private lostReason = LEASE_LOSS_REPLACED;
  private failedBeats = 0;
  private failureBudget = 1;

  private constructor(
    readonly path: string,
    private readonly leaseId: string,
    /** Heartbeat lifetime this lease was acquired under. */
    private readonly ttlMs: number,
  ) {}

  static acquire(
    protectedFile: string,
    identityDigest: string,
    options: ProcessLeaseAcquireOptions = {},
  ): ProcessLease {
    const path = `${protectedFile}.lock`;
    const recoveryPath = `${path}.recovery`;
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Without a readable /proc this process cannot use PID semantics at all,
    // so it records an unknown namespace and every record it sees, its own
    // included, is judged by heartbeat freshness. That keeps the lease usable
    // off Linux, at the cost of the instant dead-PID takeover.
    const localStart = processStart(process.pid);
    const localBootId = bootId();
    const procUsable = localStart !== null && localBootId !== null;
    const currentStart = localStart ?? UNKNOWN_PID_NAMESPACE;
    const currentNamespace =
      options.pidNamespace === undefined
        ? procUsable
          ? currentPidNamespace()
          : UNKNOWN_PID_NAMESPACE
        : (options.pidNamespace ?? UNKNOWN_PID_NAMESPACE);
    const liveness: LeaseLiveness = {
      bootId: localBootId ?? UNKNOWN_PID_NAMESPACE,
      pidNamespace: currentNamespace,
      now: options.now ?? Date.now,
      ttlMs: options.ttlMs ?? LEASE_TTL_MS,
    };
    const makeRecord = (leaseId: string): LeaseRecord => ({
      version: 1,
      pid: process.pid,
      processStart: currentStart,
      bootId: liveness.bootId,
      pidNamespace: currentNamespace,
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
            `data lease recovery guard ${recoveryPath} is stale: its owner is gone and, for a guard ` +
              `from another PID namespace, its heartbeat expired. Refusing unsafe automatic removal; ` +
              LEASE_MANUAL_RECOVERY,
          );
        }
        waitForLeaseRecovery();
        continue;
      }

      try {
        sweepStagedLeaseFiles(path, directory, liveness);
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
        return new ProcessLease(path, leaseId, liveness.ttlMs);
      } finally {
        releaseOwnedLeaseFile(recoveryPath, recoveryLeaseId, directory);
      }
    }
    throw new Error(
      `data lease ${path} remained contended during stale-lock recovery: another starter holds the ` +
        `recovery guard ${recoveryPath}, or a guard file outlived its owner. If this repeats, ` +
        LEASE_MANUAL_RECOVERY,
    );
  }

  /**
   * Keep the lease file's heartbeat fresh so peers in other PID namespaces
   * can see that this book still runs, and detect the moment the lease stops
   * being ours. onLost fires at most once and stops the timer with it.
   */
  startHeartbeat(
    onLost: (reason: string) => void,
    intervalMs: number = LEASE_HEARTBEAT_INTERVAL_MS,
  ): void {
    if (intervalMs * 3 > this.ttlMs) {
      throw new Error(
        `data lease heartbeat interval ${intervalMs} ms leaves no detection margin under a ` +
          `${this.ttlMs} ms lease lifetime; a peer would take the lease over before this process ` +
          `could notice. Use an interval of at most ${Math.floor(this.ttlMs / 3)} ms`,
      );
    }
    if (this.heartbeat !== undefined || this.closed || this.lost) return;
    this.onLost = onLost;
    // A beat that cannot read or stamp the file is a silent failure: our
    // heartbeat stops advancing while a peer counts down to the TTL. Declaring
    // loss after this many consecutive failures keeps our own detection two
    // beats ahead of that peer's takeover.
    this.failureBudget = Math.max(
      1,
      Math.floor((this.ttlMs - 2 * intervalMs) / intervalMs),
    );
    this.heartbeat = setInterval(() => {
      this.beat();
    }, intervalMs);
    // The HTTP server keeps the loop alive. A heartbeat must never be the
    // reason the process stays up.
    this.heartbeat.unref();
  }

  /**
   * Confirms the lease file still carries our lease id, and throws when it
   * does not. Every persisted write runs through this, so it re-reads the
   * file: the record is tiny, and a write that outlives our ownership would
   * corrupt the successor's data.
   */
  assertOwned(): void {
    if (this.lost) {
      throw new ProcessLeaseLostError(
        `data lease ${this.path} is no longer held by this process (${this.lostReason}); refusing to write data a displaced book no longer owns`,
      );
    }
    if (this.closed) {
      throw new ProcessLeaseLostError(
        `data lease ${this.path} was released by this process; refusing to write data after shutdown`,
      );
    }
    let observed: ObservedLease | undefined;
    try {
      observed = readLease(this.path);
    } catch (error) {
      // Unreadable proves nothing. The write is refused so nothing reaches
      // the data files, and the lease is still held. Persistent
      // unreadability reaches the heartbeat's failure budget on its own.
      throw new ProcessLeaseUnverifiableError(
        `data lease ${this.path} cannot be read right now, so this write cannot be proven safe; refusing it`,
        { cause: error },
      );
    }
    if (observed === undefined) {
      this.markLost(LEASE_LOSS_REMOVED);
      throw new ProcessLeaseLostError(
        `data lease ${this.path} is gone, so this process no longer holds it; refusing the write`,
      );
    }
    if (observed.record === null) {
      throw new ProcessLeaseUnverifiableError(
        `data lease ${this.path} holds no readable record, so this write cannot be proven safe; refusing it`,
      );
    }
    if (observed.record.leaseId !== this.leaseId) {
      this.markLost(LEASE_LOSS_REPLACED);
      throw new ProcessLeaseLostError(
        `data lease ${this.path} now carries another holder's lease id; refusing to write data this process no longer owns`,
      );
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    // A lease already known to be lost is never touched again. Whatever sits
    // at that path now belongs to the process that took it over.
    if (this.lost) return;
    let current: ObservedLease | undefined;
    try {
      current = readLease(this.path);
    } catch {
      // Release can only remove what it can prove is its own. An unreadable
      // lease file is left for whichever holder can read it, and shutdown
      // continues either way.
      return;
    }
    if (current === undefined || current.record?.leaseId !== this.leaseId)
      return;
    try {
      unlinkSync(this.path);
      fsyncDirectory(dirname(this.path));
    } catch {
      // Shutdown continues. A lease file left behind expires on its
      // heartbeat, and a same-namespace restart sees a dead PID at once.
    }
  }

  private beat(): void {
    if (this.closed || this.lost) return;
    let observed: ObservedLease | undefined;
    try {
      observed = readLease(this.path);
    } catch {
      this.countFailedBeat();
      return;
    }
    if (observed === undefined) {
      this.markLost(LEASE_LOSS_REMOVED);
      return;
    }
    if (observed.record === null) {
      this.countFailedBeat();
      return;
    }
    if (observed.record.leaseId !== this.leaseId) {
      this.markLost(LEASE_LOSS_REPLACED);
      return;
    }
    try {
      const stamp = new Date();
      utimesSync(this.path, stamp, stamp);
    } catch {
      this.countFailedBeat();
      return;
    }
    this.failedBeats = 0;
  }

  /**
   * A single failed beat proves nothing, so the beat is retried. Once the run
   * of failures covers the heartbeat lifetime minus two beats, this process
   * can no longer show a peer that it is alive, so it treats the lease as
   * lost before that peer can take it over.
   */
  private countFailedBeat(): void {
    this.failedBeats += 1;
    if (this.failedBeats < this.failureBudget) return;
    this.markLost(
      `the lease file stayed unverifiable for ${this.failedBeats} consecutive heartbeats`,
    );
  }

  private markLost(reason: string): void {
    if (this.lost) return;
    this.lost = true;
    this.lostReason = reason;
    this.stopHeartbeat();
    const notify = this.onLost;
    this.onLost = undefined;
    if (notify === undefined) return;
    // Dispatched off the current stack so the write that detected this
    // unwinds and throws before shutdown starts tearing the book down.
    setImmediate(() => {
      notify(reason);
    });
  }

  private stopHeartbeat(): void {
    if (this.heartbeat === undefined) return;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
}

/**
 * The lease over one book's protected file set: the orders file and the
 * federation feed log. One lease sits beside each protected file, so any
 * overlap on either file is refused even when an operator points the two
 * paths at different directories. The files are acquired in sorted resolved
 * order, so two starters racing on the same set contend on the same file
 * first, so exactly one of them wins and neither ends up holding one file
 * of a pair it cannot complete.
 */
export class BookLease {
  private lostNotified = false;

  private constructor(private readonly leases: readonly ProcessLease[]) {}

  static acquire(
    protectedFiles: readonly string[],
    options: ProcessLeaseAcquireOptions = {},
  ): BookLease {
    const files = [...new Set(protectedFiles.map((file) => resolve(file)))].sort();
    if (files.length === 0) {
      throw new Error("a book lease needs at least one protected file");
    }
    const identityDigest = createHash("sha256")
      .update(JSON.stringify(files))
      .digest("hex");
    const held: ProcessLease[] = [];
    try {
      for (const file of files) {
        held.push(ProcessLease.acquire(file, identityDigest, options));
      }
    } catch (error) {
      for (const lease of [...held].reverse()) lease.close();
      throw error;
    }
    return new BookLease(held);
  }

  /** Lease file paths, for log lines and operator messages. */
  get paths(): string[] {
    return this.leases.map((lease) => lease.path);
  }

  /** Starts every heartbeat. onLost fires at most once for the whole set. */
  startHeartbeat(
    onLost: (reason: string) => void,
    intervalMs: number = LEASE_HEARTBEAT_INTERVAL_MS,
  ): void {
    for (const lease of this.leases) {
      lease.startHeartbeat((reason) => {
        if (this.lostNotified) return;
        this.lostNotified = true;
        onLost(`${lease.path}: ${reason}`);
      }, intervalMs);
    }
  }

  /** Throws unless every protected file is still owned by this process. */
  assertOwned(): void {
    for (const lease of this.leases) lease.assertOwned();
  }

  close(): void {
    for (const lease of [...this.leases].reverse()) lease.close();
  }
}
