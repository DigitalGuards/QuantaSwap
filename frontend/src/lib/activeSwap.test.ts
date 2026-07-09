// Persistence tests for the in-flight swap. The preimage in localStorage
// is safety-critical (losing it strands funds until the refund path), so
// roundtrips and the legacy sandbox migration are pinned here.

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearActiveSwap,
  loadActiveSwap,
  loadMyOrder,
  saveActiveSwap,
  saveMyOrder,
  type ActiveSwap,
} from "./activeSwap";

// Minimal localStorage for the node test environment.
function stubStorage(): void {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

const swap: ActiveSwap = {
  role: "maker",
  orderId: "order-1",
  takerToken: null,
  direction: "eth->qrl",
  fromAmount: "1000000000000000000",
  toAmount: "5000000000000000000",
  makerEthAccount: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  makerQrlAccount: "Qcccccccccccccccccccccccccccccccccccccccc",
  takerEthAccount: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  takerQrlAccount: "Qdddddddddddddddddddddddddddddddddddddddd",
  preimage: `0x${"34".repeat(32)}`,
  hashlock: `0x${"12".repeat(32)}`,
  initiatorTimeout: 1_800_007_200,
  responderTimeout: 1_800_003_600,
  createdAt: 1_800_000_000,
};

beforeEach(stubStorage);

describe("active swap persistence", () => {
  it("roundtrips save -> load, preimage included", () => {
    saveActiveSwap(swap);
    expect(loadActiveSwap()).toEqual(swap);
  });

  it("returns null when nothing is stored", () => {
    expect(loadActiveSwap()).toBeNull();
  });

  it("returns null on corrupted JSON instead of throwing", () => {
    localStorage.setItem("quantaswap.swap.v2", "{not json");
    expect(loadActiveSwap()).toBeNull();
  });

  it("clears", () => {
    saveActiveSwap(swap);
    clearActiveSwap();
    expect(loadActiveSwap()).toBeNull();
  });

  it("normalizes swaps stored before the taker token existed", () => {
    const { takerToken: _omit, ...legacy } = swap;
    localStorage.setItem("quantaswap.swap.v2", JSON.stringify(legacy));
    expect(loadActiveSwap()).toEqual({ ...swap, takerToken: null });
  });
});

describe("legacy demo.v1 migration", () => {
  it("maps the single-account sandbox shape into a sandbox ActiveSwap and removes the old key", () => {
    localStorage.setItem(
      "quantaswap.demo.v1",
      JSON.stringify({
        direction: "qrl->eth",
        preimage: swap.preimage,
        hashlock: swap.hashlock,
        fromAmount: swap.fromAmount,
        toAmount: swap.toAmount,
        ethAccount: swap.makerEthAccount,
        qrlAccount: swap.makerQrlAccount,
        initiatorTimeout: swap.initiatorTimeout,
        responderTimeout: swap.responderTimeout,
        createdAt: swap.createdAt,
      }),
    );
    const migrated = loadActiveSwap();
    expect(migrated).not.toBeNull();
    expect(migrated?.role).toBe("sandbox");
    expect(migrated?.orderId).toBeNull();
    expect(migrated?.direction).toBe("qrl->eth");
    expect(migrated?.preimage).toBe(swap.preimage);
    // Sandbox plays both parties with the same accounts.
    expect(migrated?.makerEthAccount).toBe(swap.makerEthAccount);
    expect(migrated?.takerEthAccount).toBe(swap.makerEthAccount);
    expect(migrated?.makerQrlAccount).toBe(swap.makerQrlAccount);
    expect(migrated?.takerQrlAccount).toBe(swap.makerQrlAccount);
    // Old key gone, new key present: migration happens once.
    expect(localStorage.getItem("quantaswap.demo.v1")).toBeNull();
    expect(localStorage.getItem("quantaswap.swap.v2")).not.toBeNull();
    expect(loadActiveSwap()).toEqual(migrated);
  });

  it("ignores a corrupted legacy payload", () => {
    localStorage.setItem("quantaswap.demo.v1", "][");
    expect(loadActiveSwap()).toBeNull();
  });
});

describe("my-order handle", () => {
  it("roundtrips and survives corruption", () => {
    saveMyOrder({ id: "o1", token: "t1" });
    expect(loadMyOrder()).toEqual({ id: "o1", token: "t1" });
    localStorage.setItem("quantaswap.myorder.v1", "?");
    expect(loadMyOrder()).toBeNull();
  });
});
