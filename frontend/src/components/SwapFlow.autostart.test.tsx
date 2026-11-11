// @vitest-environment jsdom
// Automatic wallet prompt: an own step that turns actionable starts its action
// once; the button stays the retry.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegState } from "@/lib/htlc";
import type { ActiveSwap } from "@/lib/activeSwap";
import type { OrderView } from "@/lib/orderbook";
import type { SignedFillIntentV1, SignedFillV1 } from "@/lib/orderSigning";

const MAKER_ETH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TAKER_ETH = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MAKER_QRL = `Q${"c".repeat(128)}`;
const TAKER_QRL = `Q${"d".repeat(128)}`;
const HASHLOCK = `0x${"12".repeat(32)}`;
const PREIMAGE = `0x${"34".repeat(32)}`;
const NOW = Math.floor(Date.now() / 1000);
const ETH_AMOUNT = 10n ** 18n;
const QRL_AMOUNT = 5n * 10n ** 18n;

/** Per-leg on-chain status: 0 none, 1 open, 2 claimed, 3 refunded. */
const legStatus: Record<"eth" | "qrl", LegState["status"]> = { eth: 0, qrl: 0 };

/** Seconds from now until each leg's on-chain timeout. */
const legTimeoutIn: Record<"eth" | "qrl", number> = { eth: 7200, qrl: 3600 };
/** When true an Open responder leg already carries the preimage. */
const state = { leakPreimage: false };
/** Events the mocked chain scan returns per leg. */
const events: Record<"eth" | "qrl", { kind: string; txHash: string }[]> = { eth: [], qrl: [] };
const orderState: { order: OrderView | null } = { order: null };
const sender: { mode: "pending" | "reject" } = { mode: "pending" };
const sends: string[] = [];
const focus = { visible: true, focused: true };

vi.mock("@/lib/htlc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/htlc")>();
  const stateFor = (leg: "eth" | "qrl"): LegState => {
    const eth = leg === "eth";
    return {
      status: legStatus[leg],
      initiator: eth ? MAKER_ETH : `0x${TAKER_QRL.slice(1)}`,
      recipient: eth ? TAKER_ETH : `0x${MAKER_QRL.slice(1)}`,
      token: eth ? actual.NATIVE_TOKEN : actual.QRL_NATIVE_TOKEN,
      amount: eth ? ETH_AMOUNT : QRL_AMOUNT,
      timeout: NOW + legTimeoutIn[leg],
      preimage: `0x${"0".repeat(64)}`,
    };
  };
  return {
    ...actual,
    getLegState: vi.fn((leg: "eth" | "qrl") => Promise.resolve(stateFor(leg))),
    getConfirmedLegState: vi.fn((leg: "eth" | "qrl") => Promise.resolve(stateFor(leg))),
    getSwapEvents: vi.fn((leg: "eth" | "qrl") => Promise.resolve(events[leg])),
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

// The wallet send: counts calls and either stays pending or rejects.
vi.mock("@/lib/legSender", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/legSender")>();
  return {
    ...actual,
    makeLegSender: () => (leg: string) => {
      sends.push(leg);
      return sender.mode === "reject"
        ? Promise.reject(new Error("User rejected the request"))
        : new Promise<void>(() => undefined);
    },
  };
});

const { SwapFlow } = await import("./SwapFlow");

const swap = (role: ActiveSwap["role"]): ActiveSwap => ({
  role,
  termsBindingVersion: 1,
  orderId: "order-1",
  takerToken: null,
  direction: "eth->qrl",
  ethAsset: "ETH",
  fromAmount: ETH_AMOUNT.toString(),
  toAmount: QRL_AMOUNT.toString(),
  makerEthAccount: MAKER_ETH,
  makerQrlAccount: MAKER_QRL,
  takerEthAccount: TAKER_ETH,
  takerQrlAccount: TAKER_QRL,
  preimage: role === "taker" ? null : PREIMAGE,
  hashlock: HASHLOCK,
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

function renderFlow(role: ActiveSwap["role"], withIntent = false) {
  const base = swap(role);
  // A signed-fill swap whose order cannot be read keeps signedFillIssue set,
  // which is the banner condition under test.
  const active: ActiveSwap = withIntent
    ? {
        ...base,
        intent: SIGNED_INTENT,
        orderDigest: SIGNED_INTENT.intent.orderDigest,
        intentDigest: SIGNED_FILL.fill.intentDigest,
        fill: SIGNED_FILL,
        fillDigest: `0x${"ee".repeat(32)}`,
      }
    : base;
  return render(
    <MemoryRouter>
      <SwapFlow
        swap={active}
        ethAccount={role === "taker" ? TAKER_ETH : MAKER_ETH}
        qrlAccount={role === "taker" ? TAKER_QRL : MAKER_QRL}
        browserProvider={null}
        ensureSepolia={vi.fn()}
        qrlRequest={vi.fn()}
        qrlTransport={null}
        onDiscard={vi.fn()}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  legStatus.eth = 0;
  legStatus.qrl = 0;
  legTimeoutIn.eth = 7200;
  legTimeoutIn.qrl = 3600;
  state.leakPreimage = false;
  events.eth = [];
  events.qrl = [];
  sender.mode = "pending";
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
  vi.restoreAllMocks();
});

const POLL = { timeout: 12_000 };
const lockButton = () => screen.findByRole("button", { name: /^Lock/ }, POLL);

describe("automatic wallet prompt", () => {
  it("does not start a step that was already actionable at mount", async () => {
    legStatus.eth = 1;
    renderFlow("taker");
    await lockButton();
    await new Promise((r) => setTimeout(r, 300));
    expect(sends).toHaveLength(0);
  });

  it("starts the step once when it turns actionable", async () => {
    renderFlow("taker");
    await screen.findByTestId("swap-now");
    legStatus.eth = 1;
    await waitFor(() => expect(sends).toEqual(["qrl"]), POLL);
    await screen.findByText(/Transaction in progress/);
    expect(screen.getByTestId("swap-now").textContent).toContain(
      "If no wallet window opened, open your wallet from the browser toolbar.",
    );
    expect(sends).toHaveLength(1);
  }, 20_000);

  it("does not start again after a rejection and leaves the button as the retry", async () => {
    sender.mode = "reject";
    renderFlow("taker");
    await screen.findByTestId("swap-now");
    legStatus.eth = 1;
    await waitFor(() => expect(sends).toHaveLength(1), POLL);
    const button = await lockButton();
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    await new Promise((r) => setTimeout(r, 6_000));
    expect(sends).toHaveLength(1);
    fireEvent.click(button);
    await waitFor(() => expect(sends).toHaveLength(2));
  }, 25_000);

  it("waits for a visible, focused tab and then starts once", async () => {
    focus.focused = false;
    focus.visible = false;
    renderFlow("taker");
    await screen.findByTestId("swap-now");
    legStatus.eth = 1;
    await lockButton();
    await new Promise((r) => setTimeout(r, 6_000));
    expect(sends).toHaveLength(0);
    focus.visible = true;
    focus.focused = true;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(sends).toEqual(["qrl"]));
    window.dispatchEvent(new Event("focus"));
    expect(sends).toHaveLength(1);
  }, 25_000);

  it("never starts a refund", async () => {
    renderFlow("taker");
    await screen.findByTestId("swap-now");
    legStatus.eth = 1;
    legStatus.qrl = 1;
    legTimeoutIn.qrl = -10;
    await screen.findByRole("button", { name: /^Refund/ }, POLL);
    await new Promise((r) => setTimeout(r, 500));
    expect(sends).toHaveLength(0);
  }, 20_000);

  it("does not start a gated step", async () => {
    renderFlow("taker", true);
    await screen.findByTestId("swap-now");
    legStatus.eth = 1;
    await lockButton();
    await new Promise((r) => setTimeout(r, 6_000));
    expect(sends).toHaveLength(0);
  }, 25_000);

  it("starts fresh for a new hashlock", async () => {
    sender.mode = "reject";
    const view = renderFlow("taker");
    await screen.findByTestId("swap-now");
    legStatus.eth = 1;
    await waitFor(() => expect(sends).toHaveLength(1), POLL);
    legStatus.eth = 0;
    const other = { ...swap("taker"), hashlock: `0x${"56".repeat(32)}` };
    view.rerender(
      <MemoryRouter>
        <SwapFlow
          swap={other}
          ethAccount={TAKER_ETH}
          qrlAccount={TAKER_QRL}
          browserProvider={null}
          ensureSepolia={vi.fn()}
          qrlRequest={vi.fn()}
          qrlTransport={null}
          onDiscard={vi.fn()}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Lock/ })).toBeNull(), POLL);
    legStatus.eth = 1;
    await waitFor(() => expect(sends).toHaveLength(2), POLL);
  }, 30_000);
});
