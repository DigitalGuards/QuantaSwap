// Persistence for managed orders. Preimages live here until their swap
// settles, so the file is written 0600 and atomically. Losing a preimage
// after our lock confirms would strand funds until the refund window.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isAssetSymbol } from "./assets.js";
import type { ManagedOrder } from "./policy.js";

export class StateFile {
  private orders = new Map<string, ManagedOrder>();

  constructor(private readonly file: string) {
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
    // Records carry live preimages, so a state file this build cannot
    // interpret must stop the daemon loudly: skipping or relabeling a
    // record would strand its swap, and the next persist() would erase
    // it from disk. Malformed JSON throws out of the constructor for the
    // same reason.
    type PersistedOrder = Omit<
      ManagedOrder,
      "level" | "quotedMidMilli" | "announcedAt" | "asset"
    > & {
      level?: number;
      quotedMidMilli?: string | null;
      announcedAt?: number | null;
      asset?: string;
    };
    const parsed = JSON.parse(raw) as PersistedOrder[];
    // `level`/`quotedMidMilli`/`announcedAt`/`asset` arrived after
    // earlier releases; old records mean rung 0, an unknown
    // (reprice-worthy) mid, no announce grace, and a native-ETH pair
    // (so pre-upgrade in-flight swaps keep settling under the native
    // claim gate).
    for (const o of parsed) {
      const asset = o.asset ?? "ETH";
      if (!isAssetSymbol(asset)) {
        throw new Error(
          `state file ${this.file}: order ${o.id} has unknown asset ${JSON.stringify(o.asset)}; refusing to run on records this build cannot interpret`,
        );
      }
      this.orders.set(o.id, {
        ...o,
        level: o.level ?? 0,
        quotedMidMilli: o.quotedMidMilli ?? null,
        announcedAt: o.announcedAt ?? null,
        asset,
      });
    }
  }

  all(): ManagedOrder[] {
    return [...this.orders.values()];
  }

  upsert(order: ManagedOrder): void {
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
    writeFileSync(tmp, JSON.stringify(this.all()), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
