// Persistence tests for the in-flight swap. The preimage in localStorage
// is safety-critical (losing it strands funds until the refund path), so
// roundtrips and the legacy sandbox migration are pinned here.

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearActiveSwap,
  clearPrelockStage,
  hasCurrentTermBinding,
  loadActiveSwap,
  loadMyOrder,
  loadPrelockStage,
  saveActiveSwap,
  saveMyOrder,
  savePrelockStage,
  type ActiveSwap,
  type PrelockStage,
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
  termsBindingVersion: 1,
  orderId: "order-1",
  takerToken: null,
  direction: "eth->qrl",
  ethAsset: "ETH",
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

  it("hydrates swaps stored before the ETH-leg asset existed as native ETH", () => {
    const { ethAsset: _omit, ...legacy } = swap;
    localStorage.setItem("quantaswap.swap.v2", JSON.stringify(legacy));
    expect(loadActiveSwap()).toEqual({ ...swap, ethAsset: "ETH" });
  });

  it("keeps a stored stable-pair asset intact", () => {
    saveActiveSwap({ ...swap, ethAsset: "USDC" });
    expect(loadActiveSwap()?.ethAsset).toBe("USDC");
    saveActiveSwap({ ...swap, ethAsset: "tUSDT" });
    expect(loadActiveSwap()?.ethAsset).toBe("tUSDT");
  });

  it("normalizes an unknown persisted asset to ETH (fails closed downstream)", () => {
    localStorage.setItem("quantaswap.swap.v2", JSON.stringify({ ...swap, ethAsset: "DOGE" }));
    expect(loadActiveSwap()?.ethAsset).toBe("ETH");
  });

  it("roundtrips the prelocked flag and leaves classic swaps without it", () => {
    saveActiveSwap({ ...swap, prelocked: true });
    expect(loadActiveSwap()?.prelocked).toBe(true);
    saveActiveSwap(swap);
    expect(loadActiveSwap()?.prelocked).toBeUndefined();
  });

  it("distinguishes current order-book records from legacy recovery state", () => {
    const { termsBindingVersion: _version, ...legacy } = swap;
    expect(hasCurrentTermBinding(swap)).toBe(true);
    expect(hasCurrentTermBinding(legacy)).toBe(false);
    expect(hasCurrentTermBinding({ ...legacy, role: "sandbox" })).toBe(true);
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
    // The demo predates ERC-20 legs: always native ETH.
    expect(migrated?.ethAsset).toBe("ETH");
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
    const ref = {
      id: "o1",
      token: "t1",
      direction: "qrl->eth" as const,
      asset: "USDC" as const,
      fromAmount: "5000000",
      toAmount: "6000000000000000000",
      shareToken: "ab".repeat(32),
      prelock: null,
    };
    saveMyOrder(ref);
    expect(loadMyOrder()).toEqual(ref);
    localStorage.setItem("quantaswap.myorder.v1", "?");
    expect(loadMyOrder()).toBeNull();
  });

  it("roundtrips a pre-funded handle's escrow anchors, preimage included", () => {
    const ref = {
      id: "o1",
      token: "t1",
      direction: "eth->qrl" as const,
      asset: "ETH" as const,
      fromAmount: "1000000000000000000",
      toAmount: "5000000000000000000",
      shareToken: null,
      prelock: {
        hashlock: `0x${"12".repeat(32)}`,
        preimage: `0x${"34".repeat(32)}`,
        initiatorTimeout: 1_800_172_800,
        leg: "eth" as const,
      },
    };
    saveMyOrder(ref);
    expect(loadMyOrder()).toEqual(ref);
  });

  it("hydrates handles stored before the asset existed as native ETH", () => {
    localStorage.setItem("quantaswap.myorder.v1", JSON.stringify({ id: "o1", token: "t1" }));
    // Pre-asset handles also predate amount anchoring: both hydrate null
    // and the match flow falls back to the book copy for those.
    expect(loadMyOrder()).toEqual({
      id: "o1",
      token: "t1",
      direction: null,
      asset: "ETH",
      fromAmount: null,
      toAmount: null,
      shareToken: null,
      prelock: null,
    });
  });

  it("hydrates handles stored before amount anchoring with null amounts", () => {
    localStorage.setItem(
      "quantaswap.myorder.v1",
      JSON.stringify({ id: "o1", token: "t1", asset: "USDC" }),
    );
    expect(loadMyOrder()).toEqual({
      id: "o1",
      token: "t1",
      direction: null,
      asset: "USDC",
      fromAmount: null,
      toAmount: null,
      shareToken: null,
      prelock: null,
    });
  });
});

describe("prelock staging record", () => {
  const stage: PrelockStage = {
    hashlock: `0x${"12".repeat(32)}`,
    preimage: `0x${"34".repeat(32)}`,
    initiatorTimeout: 1_800_172_800,
    leg: "eth",
    direction: "eth->qrl",
    asset: "ETH",
    fromAmount: "1000000000000000000",
    toAmount: "5000000000000000000",
    visibility: "private",
    allowedTakerEth: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    allowedTakerQrl: null,
    createdAt: 1_800_000_000,
  };

  it("roundtrips, clears, and survives corruption", () => {
    expect(loadPrelockStage()).toBeNull();
    savePrelockStage(stage);
    expect(loadPrelockStage()).toEqual(stage);
    clearPrelockStage();
    expect(loadPrelockStage()).toBeNull();
    localStorage.setItem("quantaswap.prelockstage.v1", "{nope");
    expect(loadPrelockStage()).toBeNull();
  });
});
