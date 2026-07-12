// Persistence for managed orders. Preimages live here until their swap
// settles, so the file is written 0600 and atomically. Losing a preimage
// after our lock confirms would strand funds until the refund window.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ManagedOrder } from "./policy.js";

export class StateFile {
  private orders = new Map<string, ManagedOrder>();

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as ManagedOrder[];
      // `level`/`quotedMidMilli`/`announcedAt`/`asset` arrived after
      // earlier releases; old records mean rung 0, an unknown
      // (reprice-worthy) mid, no announce grace, and a native-ETH pair
      // (so pre-upgrade in-flight swaps keep settling under the native
      // claim gate).
      for (const o of parsed) {
        this.orders.set(o.id, {
          ...o,
          level: o.level ?? 0,
          quotedMidMilli: o.quotedMidMilli ?? null,
          announcedAt: o.announcedAt ?? null,
          asset: o.asset ?? "ETH",
        });
      }
    } catch {
      // first boot; start empty
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
