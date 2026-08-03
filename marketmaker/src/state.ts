// Persistence for managed orders. Preimages live here until their swap
// settles, so the file is written 0600 and atomically. Losing a preimage
// after our lock confirms would strand funds until the refund window.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isAssetSymbol } from "./assets.js";
import {
  parseDeploymentIdentity,
  sameDeployment,
  type DeploymentIdentity,
} from "./deployment.js";
import type { ManagedOrder } from "./policy.js";

interface StateEnvelope {
  version: 1;
  deployment: DeploymentIdentity;
  orders: ManagedOrder[];
}

type PersistedOrder = Omit<
  ManagedOrder,
  "level" | "quotedMidMilli" | "announcedAt" | "asset" | "deployment"
> & {
  level?: number;
  quotedMidMilli?: string | null;
  announcedAt?: number | null;
  asset?: string;
  deployment?: unknown;
};

const recoveryError = (file: string, reason: string): Error =>
  new Error(
    `state file ${file}: ${reason}; refusing to run or re-lock. The file was left untouched. ` +
      "Use the original chain/HTLC configuration to settle or manually refund its orders",
  );

export class StateFile {
  private orders = new Map<string, ManagedOrder>();

  constructor(
    private readonly file: string,
    private readonly deployment: DeploymentIdentity,
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
        throw recoveryError(this.file, "non-empty legacy state has no deployment identity");
      }
      this.persist();
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw recoveryError(this.file, "state envelope is malformed");
    }
    const envelope = parsed as Record<string, unknown>;
    if (envelope.version !== 1 || !Array.isArray(envelope.orders)) {
      throw recoveryError(this.file, "state envelope version or order list is malformed");
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
          err instanceof Error ? err.message : `order ${order.id} deployment identity is malformed`,
        );
      }
      if (
        !sameDeployment(orderDeployment, fileDeployment) ||
        !sameDeployment(orderDeployment, this.deployment)
      ) {
        throw recoveryError(this.file, `order ${order.id} belongs to another deployment`);
      }
      // These fields arrived before deployment binding. They remain
      // defaultable inside a correctly bound envelope so in-flight swaps
      // from that same deployment continue settling after an upgrade.
      this.orders.set(order.id, {
        ...order,
        level: order.level ?? 0,
        quotedMidMilli: order.quotedMidMilli ?? null,
        announcedAt: order.announcedAt ?? null,
        asset,
        deployment: orderDeployment,
      });
    }
  }

  all(): ManagedOrder[] {
    return [...this.orders.values()];
  }

  upsert(order: ManagedOrder): void {
    if (!sameDeployment(order.deployment, this.deployment)) {
      throw recoveryError(this.file, `order ${order.id} belongs to another deployment`);
    }
    this.orders.set(order.id, order);
    this.persist();
  }

  delete(id: string): void {
    this.orders.delete(id);
    this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = join(dirname(this.file), `.state.${process.pid}.tmp`);
    const envelope: StateEnvelope = {
      version: 1,
      deployment: this.deployment,
      orders: this.all(),
    };
    writeFileSync(tmp, JSON.stringify(envelope), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
