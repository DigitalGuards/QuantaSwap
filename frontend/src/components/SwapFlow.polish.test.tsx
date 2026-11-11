// @vitest-environment jsdom
// Swap screen polish: no duplicated step text, pending transaction link,
// stale fill banner, two-row leg header.

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
const SENT_HASH = `0x${"ab".repeat(32)}`;
const MINED_HASH = `0x${"cd".repeat(32)}`;
const orderState: { order: OrderView | null } = { order: null };
const nowOffsetMs = { value: 0 };
const sender: { release: (() => void) | null } = { release: null };

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

// The wallet send: reports the hash right away, then confirms when released.
vi.mock("@/lib/legSender", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/legSender")>();
  return {
    ...actual,
    makeLegSender:
      () =>
      (
        _leg: string,
        _data: string,
        _value: bigint,
        _to?: string,
        onSent?: (hash: string) => void,
      ) => {
        onSent?.(SENT_HASH);
        return new Promise<void>((resolve) => {
          sender.release = resolve;
        });
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

const RELEASED_ORDER: OrderView = {
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
  released: true,
  createdAt: 1,
  updatedAt: 1,
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
  sender.release = null;
  orderState.order = null;
  nowOffsetMs.value = 0;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + nowOffsetMs.value);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("swap screen polish", () => {
  it("shows a waiting sentence once when the status line carries it", async () => {
    legStatus.eth = 1;
    legStatus.qrl = 1;
    renderFlow("taker");
    const line = await screen.findByTestId("swap-now");
    expect(line.textContent).toContain("Waiting for the maker to claim and reveal the secret");
    expect(
      screen.getAllByText(/Waiting for the maker to claim and reveal the secret/),
    ).toHaveLength(1);
  });

  it("shows a pending link for the own lock, then the mined link takes over", async () => {
    legStatus.eth = 1;
    legStatus.qrl = 0;
    renderFlow("taker");
    expect(screen.queryByText(/view pending transaction on explorer/)).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /^Lock/ }));
    const pending = await screen.findByText("view pending transaction on explorer");
    expect(pending.getAttribute("href")).toMatch(new RegExp(`/tx/${SENT_HASH}$`));
    expect(pending.getAttribute("href")).toMatch(/^https:\/\/shorscan\.com\/tx\//);
    // The lock mines: the wallet call resolves and the chain scan finds it.
    legStatus.qrl = 1;
    events.qrl = [{ kind: "locked", txHash: MINED_HASH }];
    sender.release?.();
    const mined = await screen.findByText("view transaction on explorer", undefined, {
      timeout: 12_000,
    });
    expect(mined.getAttribute("href")).toMatch(new RegExp(`/tx/${MINED_HASH}$`));
    expect(screen.queryByText("view pending transaction on explorer")).toBeNull();
  }, 20_000);

  it("shows no pending link for the counterparty step", async () => {
    legStatus.eth = 1;
    legStatus.qrl = 1;
    renderFlow("taker");
    await screen.findByTestId("swap-now");
    expect(screen.queryByText(/view pending transaction on explorer/)).toBeNull();
  });

  it("lays the leg header out as one row per leg", async () => {
    renderFlow("taker");
    await screen.findByText("Swap in progress");
    const rows = screen.getAllByText(/ leg$/).map((el) => el.parentElement);
    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toBe(rows[1]);
    expect(rows[0]?.textContent).not.toContain("·");
    expect(rows[1]?.textContent).not.toContain("·");
  });

  const BANNER = /Checking the signed FillV1 before funding/;

  it("shows the fill banner while the step it gates is open", async () => {
    legStatus.eth = 1;
    legStatus.qrl = 0;
    renderFlow("taker", true);
    expect(await screen.findByText(BANNER)).toBeTruthy();
  });

  it("hides the fill banner once the gated step is done", async () => {
    legStatus.eth = 1;
    legStatus.qrl = 1;
    renderFlow("taker", true);
    await screen.findByTestId("swap-now");
    expect(screen.queryByText(BANNER)).toBeNull();
  });

  it("hides the fill banner on a completed swap", async () => {
    legStatus.eth = 2;
    legStatus.qrl = 2;
    renderFlow("taker", true);
    await waitFor(() => expect(screen.getByText(/Atomic swap complete/)).toBeTruthy());
    expect(screen.queryByText(BANNER)).toBeNull();
  });

  it("hides the stale deadline banner after the step but keeps a released fill visible", async () => {
    legStatus.eth = 1;
    legStatus.qrl = 1;
    orderState.order = RELEASED_ORDER;
    renderFlow("taker", true);
    expect(await screen.findByText(/This signed fill was released/)).toBeTruthy();
  });

  it("shows no pending link on a done step without a mined event", async () => {
    legStatus.eth = 1;
    legStatus.qrl = 0;
    renderFlow("taker");
    fireEvent.click(await screen.findByRole("button", { name: /^Lock/ }));
    await screen.findByText("view pending transaction on explorer");
    legStatus.qrl = 1;
    sender.release?.();
    await waitFor(() => expect(screen.getByTestId("swap-now").textContent).not.toMatch(/sent/), {
      timeout: 12_000,
    });
    await waitFor(() => expect(screen.queryByText(/view pending transaction/)).toBeNull(), {
      timeout: 12_000,
    });
  }, 30_000);

  it("disables the button and changes the line while a fresh own hash is awaited", async () => {
    legStatus.eth = 1;
    legStatus.qrl = 0;
    renderFlow("taker");
    fireEvent.click(await screen.findByRole("button", { name: /^Lock/ }));
    await screen.findByText("view pending transaction on explorer");
    sender.release?.();
    await waitFor(() => expect(screen.queryByText("Waiting for wallet…")).toBeNull());
    const button = screen.getByRole("button", { name: /^Lock/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("swap-now").textContent).toMatch(
      /^Transaction sent\. Waiting for it to confirm on /,
    );
  });

  it("returns the button after 180 seconds and keeps the link", async () => {
    legStatus.eth = 1;
    legStatus.qrl = 0;
    renderFlow("taker");
    fireEvent.click(await screen.findByRole("button", { name: /^Lock/ }));
    await screen.findByText("view pending transaction on explorer");
    sender.release?.();
    await waitFor(() => expect(screen.queryByText("Waiting for wallet…")).toBeNull());
    nowOffsetMs.value = 181_000;
    await waitFor(
      () =>
        expect(screen.getByRole("button", { name: /^Lock/ }).hasAttribute("disabled")).toBe(false),
      { timeout: 5_000 },
    );
    expect(screen.getByTestId("swap-now").textContent).toMatch(/^Your turn:/);
    expect(screen.getByText("view pending transaction on explorer")).toBeTruthy();
  }, 15_000);

  it("drops the pending link when the swap changes", async () => {
    legStatus.eth = 1;
    legStatus.qrl = 0;
    const view = renderFlow("taker");
    fireEvent.click(await screen.findByRole("button", { name: /^Lock/ }));
    await screen.findByText("view pending transaction on explorer");
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
    await waitFor(() => expect(screen.queryByText(/view pending transaction/)).toBeNull());
  });
});
