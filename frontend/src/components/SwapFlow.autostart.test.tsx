// @vitest-environment jsdom
// Automatic wallet prompt: an own step that turns actionable starts its action
// once; the button stays the retry. Runs on fake timers.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegState } from "@/lib/htlc";
import type { ActiveSwap } from "@/lib/activeSwap";
import type { OrderView } from "@/lib/orderbook";
import type { SignedFillIntentV1, SignedFillV1 } from "@/lib/orderSigning";
import { markFreshSwap } from "@/lib/freshSwaps";

const MAKER_ETH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TAKER_ETH = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MAKER_QRL = `Q${"c".repeat(128)}`;
const TAKER_QRL = `Q${"d".repeat(128)}`;
const HASHLOCK = `0x${"12".repeat(32)}`;
const OTHER_HASHLOCK = `0x${"56".repeat(32)}`;
const PREIMAGE = `0x${"34".repeat(32)}`;
const NOW = Math.floor(Date.now() / 1000);
const ETH_AMOUNT = 10n ** 18n;
const QRL_AMOUNT = 5n * 10n ** 18n;
const FILL_DIGEST = `0x${"ee".repeat(32)}`;

/** Per-leg on-chain status: 0 none, 1 open, 2 claimed, 3 refunded. */
const legStatus: Record<"eth" | "qrl", LegState["status"]> = { eth: 0, qrl: 0 };
const legTimeoutIn: Record<"eth" | "qrl", number> = { eth: 7200, qrl: 3600 };
const orderState: { order: OrderView | null } = { order: null };
const sender: { mode: "pending" | "reject" } = { mode: "pending" };
const sends: string[] = [];
const dir: { v: "eth->qrl" | "qrl->eth" } = { v: "eth->qrl" };
const focus = { visible: true, focused: true };

vi.mock("@/lib/htlc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/htlc")>();
  const stateFor = (leg: "eth" | "qrl"): LegState => {
    const eth = leg === "eth";
    const status = legStatus[leg];
    const flipped = dir.v === "qrl->eth";
    const makerFunds = eth !== flipped;
    return {
      status,
      initiator: eth
        ? makerFunds
          ? MAKER_ETH
          : TAKER_ETH
        : makerFunds
          ? `0x${MAKER_QRL.slice(1)}`
          : `0x${TAKER_QRL.slice(1)}`,
      recipient: eth
        ? makerFunds
          ? TAKER_ETH
          : MAKER_ETH
        : makerFunds
          ? `0x${TAKER_QRL.slice(1)}`
          : `0x${MAKER_QRL.slice(1)}`,
      token: eth ? actual.NATIVE_TOKEN : actual.QRL_NATIVE_TOKEN,
      amount: eth ? ETH_AMOUNT : QRL_AMOUNT,
      timeout: NOW + legTimeoutIn[leg],
      preimage: status === actual.SwapStatus.Claimed ? PREIMAGE : `0x${"0".repeat(64)}`,
    };
  };
  return {
    ...actual,
    getLegState: vi.fn((leg: "eth" | "qrl") => Promise.resolve(stateFor(leg))),
    getConfirmedLegState: vi.fn((leg: "eth" | "qrl") => Promise.resolve(stateFor(leg))),
    getSwapEvents: vi.fn(() => Promise.resolve([])),
    readSwapCredit: vi.fn(() => Promise.resolve({ global: 0n, credited: 0n })),
  };
});

vi.mock("@/lib/orderbook", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/orderbook")>();
  return {
    ...actual,
    getOrder: vi.fn(() =>
      orderState.order === null
        ? Promise.reject(new Error("offline test"))
        : Promise.resolve(orderState.order),
    ),
  };
});

// The fill verifies whenever the order was read and is not released.
vi.mock("@/components/signedOrderFlow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/signedOrderFlow")>();
  return {
    ...actual,
    verifyTakerFill: vi.fn(() => ({
      digest: FILL_DIGEST,
      signed: SIGNED_FILL,
    })),
  };
});

const result = () =>
  sender.mode === "reject"
    ? Promise.reject(new Error("User rejected the request"))
    : new Promise<void>(() => undefined);

vi.mock("@/lib/legSender", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/legSender")>();
  return {
    ...actual,
    makeLegSender: () => (leg: string) => {
      sends.push(leg);
      return result();
    },
    makePreflightedClaimSender: () => (leg: string) => {
      sends.push(`claim-${leg}`);
      return result();
    },
  };
});

const { SwapFlow } = await import("./SwapFlow");

const swap = (role: ActiveSwap["role"], hashlock = HASHLOCK): ActiveSwap => ({
  role,
  termsBindingVersion: 1,
  orderId: "order-1",
  takerToken: null,
  direction: dir.v,
  ethAsset: "ETH",
  fromAmount: (dir.v === "eth->qrl" ? ETH_AMOUNT : QRL_AMOUNT).toString(),
  toAmount: (dir.v === "eth->qrl" ? QRL_AMOUNT : ETH_AMOUNT).toString(),
  makerEthAccount: MAKER_ETH,
  makerQrlAccount: MAKER_QRL,
  takerEthAccount: TAKER_ETH,
  takerQrlAccount: TAKER_QRL,
  preimage: role === "taker" ? null : PREIMAGE,
  hashlock,
  initiatorTimeout: NOW + 7200,
  responderTimeout: NOW + 3600,
  createdAt: NOW - 60,
});

const SIGNED_INTENT: SignedFillIntentV1 = {
  intent: {
    orderDigest: `0x${"44".repeat(32)}`,
    takerEthAccount: TAKER_ETH,
    takerQrlAccount: TAKER_QRL,
    releaseCommitment: `0x${"77".repeat(32)}`,
  },
  auth: {
    version: "2",
    scheme: "qrl-sign-message-v2",
    issuedAt: 10,
    expiresAt: 20,
    nonce: `0x${"33".repeat(32)}`,
    signature: "0x01",
    publicKey: "0x02",
    descriptor: "0x010000",
  },
};

const SIGNED_FILL: SignedFillV1 = {
  fill: {
    orderDigest: SIGNED_INTENT.intent.orderDigest,
    intentDigest: `0x${"88".repeat(32)}`,
    takerEthAccount: TAKER_ETH,
    takerQrlAccount: TAKER_QRL,
    releaseCommitment: SIGNED_INTENT.intent.releaseCommitment,
    hashlock: HASHLOCK,
    initiatorTimeout: NOW + 7200,
    responderTimeout: NOW + 3600,
  },
  auth: SIGNED_INTENT.auth,
};

const OPEN_ORDER: OrderView = {
  id: "order-1",
  direction: "eth->qrl",
  asset: "ETH",
  fromAmount: ETH_AMOUNT.toString(),
  toAmount: QRL_AMOUNT.toString(),
  makerEthAccount: MAKER_ETH,
  makerQrlAccount: MAKER_QRL,
  status: "accepted",
  takerEthAccount: TAKER_ETH,
  takerQrlAccount: TAKER_QRL,
  hashlock: HASHLOCK,
  initiatorTimeout: NOW + 7200,
  responderTimeout: NOW + 3600,
  createdAt: 1,
  updatedAt: 1,
};

interface Opts {
  hashlock?: string;
  withIntent?: boolean;
  qrlAccount?: string | null;
}

const ui = (role: ActiveSwap["role"], opts: Opts = {}) => {
  const hashlock = opts.hashlock ?? HASHLOCK;
  const base = swap(role, hashlock);
  const active: ActiveSwap = opts.withIntent
    ? {
        ...base,
        intent: SIGNED_INTENT,
        orderDigest: SIGNED_INTENT.intent.orderDigest,
        intentDigest: SIGNED_FILL.fill.intentDigest,
        fill: SIGNED_FILL,
        fillDigest: FILL_DIGEST,
      }
    : base;
  return (
    <MemoryRouter>
      {/* Keyed like the pages key it, so navigation starts from fresh state. */}
      <SwapFlow
        key={hashlock}
        swap={active}
        ethAccount={role === "taker" ? TAKER_ETH : MAKER_ETH}
        qrlAccount={opts.qrlAccount === undefined ? TAKER_QRL : opts.qrlAccount}
        browserProvider={null}
        ensureSepolia={vi.fn()}
        qrlRequest={vi.fn()}
        qrlTransport={null}
        onDiscard={vi.fn()}
      />
    </MemoryRouter>
  );
};

const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const line = () => screen.getByTestId("swap-now").textContent;
const lockButton = () => screen.getByRole("button", { name: /^Lock/ });
const focusWindow = () =>
  act(async () => {
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
  });

beforeEach(() => {
  vi.useFakeTimers();
  legStatus.eth = 0;
  legStatus.qrl = 0;
  legTimeoutIn.eth = 7200;
  legTimeoutIn.qrl = 3600;
  sender.mode = "pending";
  dir.v = "eth->qrl";
  sends.length = 0;
  focus.visible = true;
  focus.focused = true;
  orderState.order = null;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focus.focused);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
    focus.visible ? "visible" : "hidden",
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("automatic wallet prompt", () => {
  it("does not start a step that was already actionable at mount", async () => {
    legStatus.eth = 1;
    render(ui("taker"));
    await tick(20_000);
    expect(lockButton().hasAttribute("disabled")).toBe(false);
    expect(sends).toHaveLength(0);
  });

  it("starts the step once when it turns actionable and shows the hint", async () => {
    render(ui("taker"));
    await tick(100);
    legStatus.eth = 1;
    await tick(6_000);
    expect(sends).toEqual(["qrl"]);
    expect(line()).toContain("Transaction in progress.");
    expect(line()).toContain("If nothing opened, open your wallet to approve it.");
    await tick(20_000);
    expect(sends).toHaveLength(1);
  });

  it("does not start again after a rejection; the button is the retry", async () => {
    sender.mode = "reject";
    render(ui("taker"));
    await tick(100);
    legStatus.eth = 1;
    await tick(6_000);
    expect(sends).toHaveLength(1);
    expect(lockButton().hasAttribute("disabled")).toBe(false);
    await tick(20_000);
    expect(sends).toHaveLength(1);
    fireEvent.click(lockButton());
    await tick(0);
    expect(sends).toHaveLength(2);
  });

  it("waits for a visible, focused tab and then starts once", async () => {
    focus.visible = false;
    focus.focused = false;
    render(ui("taker"));
    await tick(100);
    legStatus.eth = 1;
    await tick(20_000);
    expect(sends).toHaveLength(0);
    focus.visible = true;
    focus.focused = true;
    await focusWindow();
    expect(sends).toEqual(["qrl"]);
    await focusWindow();
    expect(sends).toHaveLength(1);
  });

  it("drops a step that waited longer than ten minutes and leaves the button", async () => {
    focus.visible = false;
    focus.focused = false;
    render(ui("taker"));
    await tick(100);
    legStatus.eth = 1;
    // In slices, so the component renders between them as it does live.
    for (let i = 0; i < 62; i += 1) await tick(10_000);
    focus.visible = true;
    focus.focused = true;
    await focusWindow();
    await tick(6_000);
    expect(sends).toHaveLength(0);
    expect(lockButton().hasAttribute("disabled")).toBe(false);
  });

  it("never starts a refund", async () => {
    render(ui("taker"));
    await tick(100);
    legStatus.eth = 1;
    legStatus.qrl = 1;
    legTimeoutIn.qrl = -10;
    await tick(20_000);
    expect(screen.getByRole("button", { name: /^Refund/ })).toBeTruthy();
    expect(sends).toHaveLength(0);
  });

  it("does not start a gated step", async () => {
    render(ui("taker", { withIntent: true }));
    await tick(100);
    legStatus.eth = 1;
    await tick(20_000);
    expect(sends).toHaveLength(0);
  });

  it("takes no baseline before the signed fill has been read", async () => {
    legStatus.eth = 1;
    render(ui("taker", { withIntent: true }));
    await tick(11_000);
    // The order arrives later and the step turns actionable: still the
    // reading of an opened link, so nothing starts.
    orderState.order = OPEN_ORDER;
    await tick(11_000);
    expect(lockButton().hasAttribute("disabled")).toBe(false);
    expect(sends).toHaveLength(0);
  });

  it("does not start while no wallet is connected on the step's leg, then does", async () => {
    const view = render(ui("taker", { qrlAccount: null }));
    await tick(100);
    legStatus.eth = 1;
    await tick(20_000);
    expect(sends).toHaveLength(0);
    view.rerender(ui("taker"));
    await tick(0);
    expect(sends).toEqual(["qrl"]);
  });

  it("does not start while a connected account differs from the swap's, then does", async () => {
    const view = render(ui("taker", { qrlAccount: MAKER_QRL }));
    await tick(100);
    legStatus.eth = 1;
    await tick(20_000);
    expect(sends).toHaveLength(0);
    view.rerender(ui("taker"));
    await tick(0);
    expect(sends).toEqual(["qrl"]);
  });

  it("holds the taker's claim for the maker's sponsored claim, then starts it", async () => {
    legStatus.eth = 1;
    legStatus.qrl = 1;
    render(ui("taker"));
    await tick(100);
    legStatus.qrl = 2;
    await tick(6_000);
    expect(line()).toContain("Your maker may submit this claim for you.");
    expect(line()).toContain("within about 2 minutes");
    // Inside the hold the step shows progress and no button.
    expect(screen.queryByRole("button", { name: /^Claim/ })).toBeNull();
    expect(screen.getByTestId("claim-hold")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuemax")).toBe("90");
    await tick(60_000);
    expect(sends).toHaveLength(0);
    await tick(30_000);
    expect(sends).toEqual(["claim-eth"]);
    expect(screen.queryByTestId("claim-hold")).toBeNull();
    expect(screen.getByRole("button", { name: "Waiting for wallet…" })).toBeTruthy();
  });

  it("holds the taker's QRL claim for 180 seconds", async () => {
    dir.v = "qrl->eth";
    legTimeoutIn.qrl = 7200;
    legStatus.qrl = 1;
    legStatus.eth = 1;
    render(ui("taker"));
    await tick(100);
    legStatus.eth = 2;
    await tick(6_000);
    expect(line()).toContain("Your maker may submit this claim for you.");
    expect(line()).toContain("within about 3 minutes");
    await tick(150_000);
    expect(sends).toHaveLength(0);
    await tick(30_000);
    expect(sends).toEqual(["claim-qrl"]);
  });

  it("clears a step error once that step is done, and keeps it while open", async () => {
    sender.mode = "reject";
    render(ui("taker"));
    await tick(100);
    legStatus.eth = 1;
    await tick(6_000);
    expect(sends).toEqual(["qrl"]);
    expect(screen.getByText("Transaction rejected in your wallet.")).toBeTruthy();
    await tick(10_000);
    expect(screen.getByText("Transaction rejected in your wallet.")).toBeTruthy();
    legStatus.qrl = 1;
    await tick(10_000);
    expect(screen.queryByText("Transaction rejected in your wallet.")).toBeNull();
  });

  it("clears a claim error when the sponsored claim completes the swap", async () => {
    sender.mode = "reject";
    legStatus.eth = 1;
    legStatus.qrl = 1;
    render(ui("taker"));
    await tick(100);
    legStatus.qrl = 2;
    await tick(6_000);
    await tick(95_000);
    expect(sends).toEqual(["claim-eth"]);
    expect(screen.getByText("Transaction rejected in your wallet.")).toBeTruthy();
    legStatus.eth = 2;
    await tick(10_000);
    expect(screen.queryByText("Transaction rejected in your wallet.")).toBeNull();
  });

  it("starts the first step of a swap created in this session at once", async () => {
    markFreshSwap(HASHLOCK);
    legStatus.eth = 1;
    render(ui("taker"));
    await tick(100);
    expect(sends).toEqual(["qrl"]);
  });

  it("starts nothing in a swap opened from a link after a fresh one", async () => {
    // The fresh entry of the previous test was removed at its mount.
    legStatus.eth = 1;
    render(ui("taker"));
    await tick(1_000);
    expect(sends).toHaveLength(0);
  });

  it("takes the new swap's baseline from its own chain state after navigation", async () => {
    sender.mode = "reject";
    const view = render(ui("taker"));
    await tick(100);
    legStatus.eth = 1;
    await tick(6_000);
    expect(sends).toHaveLength(1);
    view.rerender(ui("taker", { hashlock: OTHER_HASHLOCK }));
    await tick(20_000);
    // Swap B was already actionable when it opened: no second start.
    expect(sends).toHaveLength(1);
  });
});
