// The share-link fragment is the only place a private order's capability
// secret travels; a parser that accepted junk (or a builder that drifted
// from the parser) would brick every share link silently.

import { describe, expect, it } from "vitest";
import type { ActiveSwap, MyOrderRef } from "./activeSwap";
import {
  acceptedOrderTerms,
  announcedOrderTerms,
  assertMakerOrderProgress,
  assertMakerOrderTerms,
  assertStoredMakerSwapTerms,
  parseShareToken,
  shareFragment,
  type OrderView,
} from "./orderbook";

describe("share-link fragment", () => {
  const TOKEN = "ab".repeat(32);

  it("round-trips a 32-byte hex token", () => {
    expect(parseShareToken(shareFragment(TOKEN))).toBe(TOKEN);
  });

  it("rejects malformed fragments", () => {
    expect(parseShareToken("")).toBeNull();
    expect(parseShareToken("#k=")).toBeNull();
    expect(parseShareToken(`#k=${"zz".repeat(32)}`)).toBeNull();
    expect(parseShareToken(`#k=${"ab".repeat(31)}`)).toBeNull();
    expect(parseShareToken(`#key=${TOKEN}`)).toBeNull();
    expect(parseShareToken(`#k=${TOKEN}x`)).toBeNull();
  });

  it("rejects uppercase hex (tokens are minted lowercase)", () => {
    expect(parseShareToken(`#k=${"AB".repeat(32)}`)).toBeNull();
  });
});

const order = (overrides: Partial<OrderView> = {}): OrderView => ({
  id: "order-1",
  direction: "qrl->eth",
  asset: "USDC",
  fromAmount: "10000000000000000000",
  toAmount: "10000",
  makerEthAccount: "0x1111111111111111111111111111111111111111",
  makerQrlAccount: "Q2222222222222222222222222222222222222222",
  status: "accepted",
  takerEthAccount: "0x3333333333333333333333333333333333333333",
  takerQrlAccount: "Q4444444444444444444444444444444444444444",
  hashlock: null,
  initiatorTimeout: null,
  responderTimeout: null,
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

const TAKER = {
  takerEthAccount: "0x3333333333333333333333333333333333333333",
  takerQrlAccount: "Q4444444444444444444444444444444444444444",
};

const acceptedTerms = (
  displayed: OrderView,
  accepted: OrderView,
  mode: "same-order" | "same-or-better" = "same-order",
) => acceptedOrderTerms(displayed, accepted, "USDC", mode, TAKER);

describe("untrusted order term binding", () => {
  it("accepts an exact by-id response", () => {
    const displayed = order({ status: "open" });
    expect(acceptedTerms(displayed, order())).toMatchObject({
      direction: "qrl->eth",
      asset: "USDC",
      fromAmount: displayed.fromAmount,
      toAmount: displayed.toAmount,
    });
  });

  it("rejects a direction flip with identical raw amounts", () => {
    const displayed = order({ status: "open" });
    const flipped = order({ direction: "eth->qrl" });
    expect(() => acceptedTerms(displayed, flipped)).toThrow(
      /different swap semantics/,
    );
  });

  it("rejects asset and prelock semantic changes", () => {
    const displayed = order({ status: "open" });
    expect(() =>
      acceptedTerms(displayed, order({ asset: "ETH" })),
    ).toThrow(/different swap semantics/);
    expect(() =>
      acceptedTerms(
        displayed,
        order({
          prelocked: true,
          hashlock: `0x${"12".repeat(32)}`,
          initiatorTimeout: 1_800_000_000,
        }),
      ),
    ).toThrow(/different swap semantics/);
  });

  it("binds a displayed prelock to its exact hashlock and timeout", () => {
    const displayed = order({
      status: "open",
      prelocked: true,
      hashlock: `0x${"12".repeat(32)}`,
      initiatorTimeout: 1_800_000_000,
    });
    const accepted = order({
      prelocked: true,
      hashlock: displayed.hashlock,
      initiatorTimeout: displayed.initiatorTimeout,
    });
    expect(() => acceptedTerms(displayed, accepted)).not.toThrow();
    expect(() =>
      acceptedTerms(
        displayed,
        { ...accepted, hashlock: `0x${"34".repeat(32)}` },
      ),
    ).toThrow(/different swap semantics/);
  });

  it("rejects identity substitution on an accept-by-id response", () => {
    const displayed = order({ status: "open" });
    expect(() =>
      acceptedTerms(displayed, order({ id: "other-order" })),
    ).toThrow(/different swap semantics/);
    expect(() =>
      acceptedTerms(
        displayed,
        order({ makerQrlAccount: "Q5555555555555555555555555555555555555555" }),
      ),
    ).toThrow(/different swap semantics/);
  });

  it("allows a different same-pair row only when its numeric terms improve", () => {
    const displayed = order({ status: "open" });
    const better = order({
      id: "order-2",
      fromAmount: "11000000000000000000",
      toAmount: "9000",
      makerEthAccount: "0x5555555555555555555555555555555555555555",
    });
    expect(acceptedTerms(displayed, better, "same-or-better")).toMatchObject({
      fromAmount: better.fromAmount,
      toAmount: better.toAmount,
    });
    expect(() =>
      acceptedTerms(
        displayed,
        order({ id: "order-2", fromAmount: "9999999999999999999" }),
        "same-or-better",
      ),
    ).toThrow(/different swap semantics/);
  });

  it("rejects hidden H/T fields on classic rows and T2 on pre-funded rows", () => {
    const displayed = order({ status: "open" });
    expect(() =>
      acceptedTerms(displayed, order({ hashlock: `0x${"12".repeat(32)}` })),
    ).toThrow(/different swap semantics/);
    expect(() =>
      acceptedTerms(displayed, order({ initiatorTimeout: 1_800_000_000 })),
    ).toThrow(/different swap semantics/);
    expect(() =>
      acceptedTerms(displayed, order({ responderTimeout: 1_799_996_400 })),
    ).toThrow(/different swap semantics/);

    const prelocked = order({
      status: "open",
      prelocked: true,
      hashlock: `0x${"12".repeat(32)}`,
      initiatorTimeout: 1_800_000_000,
    });
    expect(() =>
      acceptedTerms(prelocked, {
        ...prelocked,
        status: "accepted",
        responderTimeout: 1_799_996_400,
      }),
    ).toThrow(/different swap semantics/);
  });

  it("binds accepted taker accounts to the wallet accounts in the request", () => {
    const displayed = order({ status: "open" });
    expect(() =>
      acceptedOrderTerms(displayed, order(), "USDC", "same-order", {
        ...TAKER,
        takerQrlAccount: "Q5555555555555555555555555555555555555555",
      }),
    ).toThrow(/different swap semantics/);
  });

  it("binds maker matching to the locally authored direction and terms", () => {
    const local: MyOrderRef = {
      id: "order-1",
      token: "maker-token",
      direction: "qrl->eth",
      asset: "USDC",
      fromAmount: "10000000000000000000",
      toAmount: "10000",
      shareToken: null,
      prelock: null,
    };
    expect(() => assertMakerOrderTerms(local, order())).not.toThrow();
    expect(() => assertMakerOrderTerms(local, order({ direction: "eth->qrl" }))).toThrow(
      /locally anchored swap terms/,
    );
  });

  it("binds a maker's pre-funded handle to its local escrow anchors", () => {
    const hashlock = `0x${"12".repeat(32)}`;
    const local: MyOrderRef = {
      id: "order-1",
      token: "maker-token",
      direction: "qrl->eth",
      asset: "USDC",
      fromAmount: "10000000000000000000",
      toAmount: "10000",
      shareToken: null,
      prelock: {
        hashlock,
        preimage: `0x${"34".repeat(32)}`,
        initiatorTimeout: 1_800_000_000,
        leg: "qrl",
      },
    };
    const current = order({ prelocked: true, hashlock, initiatorTimeout: 1_800_000_000 });
    expect(() => assertMakerOrderTerms(local, current)).not.toThrow();
    expect(() =>
      assertMakerOrderTerms(local, { ...current, initiatorTimeout: 1_800_000_001 }),
    ).toThrow(/locally anchored swap terms/);
  });

  it("fails closed for legacy maker handles without local term binding", () => {
    const legacy: MyOrderRef = {
      id: "order-1",
      token: "maker-token",
      direction: null,
      asset: "USDC",
      fromAmount: null,
      toAmount: null,
      shareToken: null,
      prelock: null,
    };
    expect(() => assertMakerOrderTerms(legacy, order())).toThrow(/predates local term binding/);
  });

  it("rejects a persisted maker swap whose semantics drift from the local handle", () => {
    const local: MyOrderRef = {
      id: "order-1",
      token: "maker-token",
      direction: "qrl->eth",
      asset: "USDC",
      fromAmount: "10000000000000000000",
      toAmount: "10000",
      shareToken: null,
      prelock: null,
    };
    const stored: ActiveSwap = {
      role: "maker",
      termsBindingVersion: 1,
      orderId: "order-1",
      takerToken: null,
      direction: "qrl->eth",
      ethAsset: "USDC",
      fromAmount: local.fromAmount!,
      toAmount: local.toAmount!,
      makerEthAccount: "0x1111111111111111111111111111111111111111",
      makerQrlAccount: "Q2222222222222222222222222222222222222222",
      takerEthAccount: "0x3333333333333333333333333333333333333333",
      takerQrlAccount: "Q4444444444444444444444444444444444444444",
      preimage: `0x${"34".repeat(32)}`,
      hashlock: `0x${"12".repeat(32)}`,
      initiatorTimeout: 1_800_000_000,
      responderTimeout: 1_799_996_400,
      createdAt: 1,
    };
    expect(() => assertStoredMakerSwapTerms(local, stored)).not.toThrow();
    expect(() =>
      assertStoredMakerSwapTerms(local, { ...stored, direction: "eth->qrl" }),
    ).toThrow(/saved swap does not match/);

    const locking = order({
      status: "locking",
      hashlock: stored.hashlock,
      initiatorTimeout: stored.initiatorTimeout,
      responderTimeout: stored.responderTimeout,
    });
    expect(() => assertMakerOrderProgress(local, stored, locking)).not.toThrow();
    expect(() =>
      assertMakerOrderProgress(local, stored, {
        ...locking,
        status: "accepted",
        hashlock: null,
        initiatorTimeout: null,
        responderTimeout: null,
      }),
    ).not.toThrow();
    expect(() =>
      assertMakerOrderProgress(local, stored, {
        ...locking,
        takerEthAccount: "0x5555555555555555555555555555555555555555",
      }),
    ).toThrow(/changed the matched parties/);
    expect(() =>
      assertMakerOrderProgress(local, stored, { ...locking, responderTimeout: 1_799_996_399 }),
    ).toThrow(/changed the matched parties or announcement/);
  });

  it("binds a taker's locking response to its accepted prelock anchor", () => {
    const hashlock = `0x${"12".repeat(32)}`;
    const now = 1_799_990_000;
    const stored: ActiveSwap = {
      role: "taker",
      termsBindingVersion: 1,
      orderId: "order-1",
      takerToken: "taker-token",
      direction: "qrl->eth",
      ethAsset: "USDC",
      fromAmount: "10000000000000000000",
      toAmount: "10000",
      makerEthAccount: "0x1111111111111111111111111111111111111111",
      makerQrlAccount: "Q2222222222222222222222222222222222222222",
      ...TAKER,
      preimage: null,
      hashlock: null,
      initiatorTimeout: null,
      responderTimeout: null,
      prelocked: true,
      acceptedPrelock: { hashlock, initiatorTimeout: 1_800_000_000 },
      createdAt: now,
    };
    const locking = order({
      status: "locking",
      prelocked: true,
      hashlock,
      initiatorTimeout: 1_800_000_000,
      responderTimeout: 1_799_996_400,
    });
    expect(announcedOrderTerms(stored, locking, now)).toEqual({
      hashlock,
      initiatorTimeout: 1_800_000_000,
      responderTimeout: 1_799_996_400,
    });
    expect(() =>
      announcedOrderTerms(
        stored,
        { ...locking, hashlock: `0x${"34".repeat(32)}` },
        now,
      ),
    ).toThrow(/unsafe or changed/);
    expect(() =>
      announcedOrderTerms({ ...stored, acceptedPrelock: null }, locking, now),
    ).toThrow(/unsafe or changed/);
    expect(() =>
      announcedOrderTerms(stored, { ...locking, direction: "eth->qrl" }, now),
    ).toThrow(/unsafe or changed/);
  });
});
