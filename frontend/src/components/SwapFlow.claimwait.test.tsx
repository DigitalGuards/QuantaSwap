// @vitest-environment jsdom
// Claim wait: the taker's claim hold shows progress and no button, survives a
// reload through the chain time of the reveal, never runs into the claim
// cutoff, an own pending transaction shows liveness, and crossed claims are
// explained. Runs on fake timers.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegState } from "@/lib/htlc";
import type { ActiveSwap } from "@/lib/activeSwap";
import { CROSSED_CLAIM_NOTE, HOLD_END_NOTE, QRL_BLOCK_NOTE } from "@/lib/swapNowLine";

const MAKER_ETH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TAKER_ETH = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MAKER_QRL = `Q${"c".repeat(128)}`;
const TAKER_QRL = `Q${"d".repeat(128)}`;
const HASHLOCK = `0x${"12".repeat(32)}`;
const PREIMAGE = `0x${"34".repeat(32)}`;
const OWN_HASH = `0x${"ab".repeat(32)}`;
const SECOND_HASH = `0x${"ef".repeat(32)}`;
const MAKER_HASH = `0x${"cd".repeat(32)}`;
const NOW = Math.floor(Date.now() / 1000);
const ETH_AMOUNT = 10n ** 18n;
const QRL_AMOUNT = 5n * 10n ** 18n;

const legStatus: Record<"eth" | "qrl", LegState["status"]> = { eth: 0, qrl: 0 };
const legTimeoutIn: Record<"eth" | "qrl", number> = { eth: 7200, qrl: 7200 };
const events: Record<"eth" | "qrl", { kind: string; txHash: string; blockNumber?: number }[]> = {
  eth: [],
  qrl: [],
};
/** Age of the reveal block on the chain's clock, when the lookup runs. */
const reveal = { agoS: 60 };
/** The chain clock runs this many seconds ahead of the device clock. */
const chain = { skewS: 0, delayMs: 0, fail: false, confirmedFails: false, headLagS: 0 };
/** Sender the node reports for the transaction that claimed the leg. */
const claimer: { addr: string | null } = { addr: null };
const MAKER_QRL_HEX = `0x${MAKER_QRL.slice(1)}`;
const TAKER_QRL_HEX = `0x${TAKER_QRL.slice(1)}`;
const sends: string[] = [];
const dir: { v: "qrl->eth" | "eth->qrl" } = { v: "qrl->eth" };
/** When true the next wallet calls return at once after reporting a hash. */
const sender: {
  resolveFirst: boolean;
  hashes: string[];
  /** Call index whose report waits for `report`. */
  lateIndex: number;
  report: (() => void) | null;
  /** The wallet reports a hash, then the call fails. */
  failAfterReport: boolean;
} = {
  resolveFirst: false,
  hashes: [OWN_HASH, SECOND_HASH],
  lateIndex: -1,
  report: null,
  failAfterReport: false,
};

vi.mock("@/lib/htlc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/htlc")>();
  // Quanta to ETH: the maker funds the Quanta leg, the taker funds the ETH leg.
  const stateFor = (leg: "eth" | "qrl"): LegState => {
    const eth = leg === "eth";
    const status = legStatus[leg];
    const flipped = dir.v === "eth->qrl";
    const makerFunds = eth === flipped;
    return {
      status,
      initiator: eth
        ? makerFunds
          ? MAKER_ETH
          : TAKER_ETH
        : `0x${(makerFunds ? MAKER_QRL : TAKER_QRL).slice(1)}`,
      recipient: eth
        ? makerFunds
          ? TAKER_ETH
          : MAKER_ETH
        : `0x${(makerFunds ? TAKER_QRL : MAKER_QRL).slice(1)}`,
      token: eth ? actual.NATIVE_TOKEN : actual.QRL_NATIVE_TOKEN,
      amount: eth ? ETH_AMOUNT : QRL_AMOUNT,
      timeout: NOW + chain.skewS + legTimeoutIn[leg],
      preimage: status === actual.SwapStatus.Claimed ? PREIMAGE : `0x${"0".repeat(64)}`,
    };
  };
  return {
    ...actual,
    getLegState: vi.fn((leg: "eth" | "qrl") => Promise.resolve(stateFor(leg))),
    getConfirmedLegState: vi.fn((leg: "eth" | "qrl") =>
      chain.confirmedFails ? Promise.reject(new Error("offline")) : Promise.resolve(stateFor(leg)),
    ),
    getSwapEvents: vi.fn((leg: "eth" | "qrl") => Promise.resolve(events[leg])),
    getChainClockReading: vi.fn(() => {
      const answer = () => {
        if (chain.fail) return Promise.reject(new Error("lookup failed"));
        return Promise.resolve({
          ageS: reveal.agoS,
          claimHeadS: Math.floor(Date.now() / 1000) + chain.skewS - chain.headLagS,
        });
      };
      return chain.delayMs === 0
        ? answer()
        : new Promise((resolve) => {
            setTimeout(() => resolve(answer()), chain.delayMs);
          });
    }),
    getTxSender: vi.fn(() => Promise.resolve(claimer.addr)),
    readSwapCredit: vi.fn(() => Promise.resolve({ global: 0n, credited: 0n })),
  };
});

vi.mock("@/lib/orderbook", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/orderbook")>();
  return { ...actual, getOrder: vi.fn(() => Promise.reject(new Error("offline test"))) };
});

/** The wallet reports its hash at once, then the transaction stays pending. */
vi.mock("@/lib/legSender", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/legSender")>();
  const send =
    (name: string) =>
    (_leg: string, ...rest: unknown[]) => {
      sends.push(name);
      const onSent = [...rest]
        .reverse()
        .find((arg): arg is (hash: string) => void => typeof arg === "function");
      const n = sends.length - 1;
      const hash = sender.hashes[n] ?? OWN_HASH;
      if (n === sender.lateIndex) {
        sender.report = () => onSent?.(hash);
      } else {
        onSent?.(hash);
      }
      if (sender.failAfterReport) return Promise.reject(new Error("The wallet call failed."));
      return sender.resolveFirst && n === 0
        ? Promise.resolve()
        : new Promise<void>(() => undefined);
    };
  return {
    ...actual,
    makeLegSender: () => send("send"),
    makePreflightedClaimSender: () => send("claim"),
  };
});

const { SwapFlow } = await import("./SwapFlow");

const active = (): ActiveSwap => ({
  role: "taker",
  termsBindingVersion: 1,
  orderId: "order-1",
  takerToken: null,
  direction: dir.v,
  ethAsset: "ETH",
  fromAmount: (dir.v === "qrl->eth" ? QRL_AMOUNT : ETH_AMOUNT).toString(),
  toAmount: (dir.v === "qrl->eth" ? ETH_AMOUNT : QRL_AMOUNT).toString(),
  makerEthAccount: MAKER_ETH,
  makerQrlAccount: MAKER_QRL,
  takerEthAccount: TAKER_ETH,
  takerQrlAccount: TAKER_QRL,
  preimage: null,
  hashlock: HASHLOCK,
  initiatorTimeout: NOW + 7200,
  responderTimeout: NOW + 3600,
  createdAt: NOW - 60,
});

const ui = (qrlAccount: string | null = TAKER_QRL) => (
  <MemoryRouter>
    <SwapFlow
      swap={active()}
      ethAccount={TAKER_ETH}
      qrlAccount={qrlAccount}
      browserProvider={null}
      ensureSepolia={vi.fn()}
      qrlRequest={vi.fn()}
      qrlTransport={null}
      onDiscard={vi.fn()}
    />
  </MemoryRouter>
);

const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const claimButton = () => screen.queryByRole("button", { name: /^Claim/ });
const revealed = () => {
  legStatus.qrl = 1;
  legStatus.eth = 2;
};
/** The reveal is long past its window: the button shows once the lookups land. */
const revealedLongAgo = () => {
  revealed();
  reveal.agoS = 400;
  events.eth = [{ kind: "claimed", txHash: MAKER_HASH, blockNumber: 7 }];
};

beforeEach(() => {
  vi.useFakeTimers();
  legStatus.eth = 0;
  legStatus.qrl = 0;
  legTimeoutIn.eth = 7200;
  legTimeoutIn.qrl = 7200;
  events.eth = [];
  events.qrl = [];
  reveal.agoS = 60;
  chain.skewS = 0;
  chain.delayMs = 0;
  chain.fail = false;
  chain.confirmedFails = false;
  chain.headLagS = 0;
  claimer.addr = MAKER_QRL_HEX;
  sends.length = 0;
  sender.resolveFirst = false;
  sender.lateIndex = -1;
  sender.report = null;
  sender.failAfterReport = false;
  dir.v = "qrl->eth";
  vi.spyOn(document, "hasFocus").mockImplementation(() => true);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => "visible");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("claim hold", () => {
  it("counts from the chain time of the reveal after a reload, with no button", async () => {
    revealed();
    events.eth = [{ kind: "claimed", txHash: MAKER_HASH, blockNumber: 7 }];
    render(ui());
    await tick(6_000);
    expect(screen.getByTestId("claim-hold")).toBeTruthy();
    expect(claimButton()).toBeNull();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuemax")).toBe("180");
    // The reveal was 60 s ago, so about 66 s of the window have passed.
    expect(Number(bar.getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(60);
    expect(Number(bar.getAttribute("aria-valuenow"))).toBeLessThanOrEqual(75);
    expect(screen.getByTestId("claim-hold").textContent).toContain(QRL_BLOCK_NOTE);
    // The window ends 180 s after the reveal; a reloaded page starts nothing.
    await tick(120_000);
    expect(screen.queryByTestId("claim-hold")).toBeNull();
    expect(claimButton()).not.toBeNull();
    expect(sends).toHaveLength(0);
  });

  it("words a Quanta-leg hold as a possibility and adds the Quanta block note", async () => {
    revealed();
    events.eth = [{ kind: "claimed", txHash: MAKER_HASH, blockNumber: 7 }];
    render(ui());
    await tick(6_000);
    expect(screen.getByTestId("swap-now").textContent).toContain(
      "Your maker may submit this claim for you.",
    );
    const hold = screen.getByTestId("claim-hold");
    expect(hold.textContent).toContain("Waiting for your maker's claim");
    expect(hold.textContent).toContain(HOLD_END_NOTE);
    expect(hold.textContent).toContain(QRL_BLOCK_NOTE);
  });

  it("gives an ETH-leg hold no Quanta block note and a 90 second bar", async () => {
    dir.v = "eth->qrl";
    legStatus.eth = 1;
    legStatus.qrl = 2;
    events.qrl = [{ kind: "claimed", txHash: MAKER_HASH, blockNumber: 7 }];
    render(ui());
    await tick(6_000);
    const hold = screen.getByTestId("claim-hold");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuemax")).toBe("90");
    expect(hold.textContent).toContain(HOLD_END_NOTE);
    expect(hold.textContent).not.toContain(QRL_BLOCK_NOTE);
    expect(claimButton()).toBeNull();
  });

  it("checks for the maker's claim for at most 20 s when the reveal cannot be dated", async () => {
    revealed();
    render(ui());
    await tick(6_000);
    expect(screen.getByTestId("claim-hold").textContent).toContain(
      "Checking for your maker's claim",
    );
    expect(screen.getByTestId("swap-now").textContent).toBe(
      "Checking whether your maker's claim is still on its way.",
    );
    expect(claimButton()).toBeNull();
    await tick(20_000);
    expect(screen.queryByTestId("claim-hold")).toBeNull();
    expect(claimButton()).not.toBeNull();
    expect(sends).toHaveLength(0);
  });

  it("shows the button after the check when the lookups fail", async () => {
    revealed();
    chain.fail = true;
    events.eth = [{ kind: "claimed", txHash: MAKER_HASH, blockNumber: 7 }];
    render(ui());
    await tick(6_000);
    expect(claimButton()).toBeNull();
    await tick(20_000);
    expect(claimButton()).not.toBeNull();
  });

  it("keeps the button away through a slow lookup and then holds by the reveal age", async () => {
    revealed();
    chain.delayMs = 5_000;
    events.eth = [{ kind: "claimed", txHash: MAKER_HASH, blockNumber: 7 }];
    render(ui());
    await tick(2_000);
    expect(screen.getByTestId("claim-hold").textContent).toContain("Checking");
    expect(claimButton()).toBeNull();
    await tick(8_000);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuemax")).toBe("180");
    expect(claimButton()).toBeNull();
  });

  it("measures a remounted page on the chain clock when the device clock runs slow", async () => {
    revealed();
    // The chain is 2 hours ahead of the device. Chain time never meets page time.
    chain.skewS = 7_200;
    events.eth = [{ kind: "claimed", txHash: MAKER_HASH, blockNumber: 7 }];
    render(ui());
    await tick(6_000);
    expect(screen.getByTestId("claim-hold")).toBeTruthy();
    expect(claimButton()).toBeNull();
    // Reveal 60 s old at the reading: the window ends about 120 s later.
    await tick(125_000);
    expect(screen.queryByTestId("claim-hold")).toBeNull();
    expect(claimButton()).not.toBeNull();
  });

  it("holds the full window in page time when the device clock runs fast", async () => {
    legStatus.qrl = 1;
    legStatus.eth = 1;
    chain.skewS = -240;
    render(ui());
    await tick(100);
    revealed();
    events.eth = [{ kind: "claimed", txHash: MAKER_HASH, blockNumber: 7 }];
    reveal.agoS = 0;
    await tick(10_000);
    expect(screen.getByTestId("claim-hold")).toBeTruthy();
    expect(sends).toHaveLength(0);
    await tick(150_000);
    expect(sends).toHaveLength(0);
    await tick(30_000);
    expect(sends).toEqual(["claim"]);
  });

  it("promises the wallet only where an automatic start follows", async () => {
    revealed();
    events.eth = [{ kind: "claimed", txHash: MAKER_HASH, blockNumber: 7 }];
    const view = render(ui());
    await tick(6_000);
    // Found on the first reading: nothing will start by itself.
    expect(screen.getByTestId("swap-now").textContent).not.toContain("your wallet opens");
    expect(screen.getByTestId("swap-now").textContent).toContain("the Claim button appears.");
    view.unmount();
    cleanup();
    chain.delayMs = 0;
    legStatus.qrl = 1;
    legStatus.eth = 1;
    events.eth = [];
    render(ui());
    await tick(100);
    revealed();
    events.eth = [{ kind: "claimed", txHash: MAKER_HASH, blockNumber: 7 }];
    reveal.agoS = 0;
    await tick(10_000);
    expect(screen.getByTestId("swap-now").textContent).toContain("and your wallet opens for it");
  });

  it("shows the button when the reveal is older than the window", async () => {
    revealed();
    reveal.agoS = 400;
    events.eth = [{ kind: "claimed", txHash: MAKER_HASH, blockNumber: 7 }];
    render(ui());
    await tick(6_000);
    expect(screen.queryByTestId("claim-hold")).toBeNull();
    expect(claimButton()).not.toBeNull();
  });

  it("does not hold when the window would reach the claim cutoff margin", async () => {
    revealed();
    // 30 min claim margin + 15 min safety = 2700 s; the window ends in 120 s.
    legTimeoutIn.qrl = 2700 + 100;
    events.eth = [{ kind: "claimed", txHash: MAKER_HASH, blockNumber: 7 }];
    render(ui());
    await tick(6_000);
    expect(screen.queryByTestId("claim-hold")).toBeNull();
    expect(claimButton()).not.toBeNull();
  });

  it("starts the claim by itself once the window of a live transition ends", async () => {
    legStatus.qrl = 1;
    legStatus.eth = 1;
    render(ui());
    await tick(100);
    revealed();
    events.eth = [{ kind: "claimed", txHash: MAKER_HASH, blockNumber: 7 }];
    reveal.agoS = 0;
    await tick(10_000);
    expect(screen.getByTestId("claim-hold")).toBeTruthy();
    expect(claimButton()).toBeNull();
    await tick(185_000);
    expect(sends).toEqual(["claim"]);
  });
});

describe("own transaction wait", () => {
  it("stops counting beside a displayed error for the step", async () => {
    revealedLongAgo();
    sender.failAfterReport = true;
    render(ui());
    await tick(6_000);
    fireEvent.click(screen.getByRole("button", { name: /^Claim/ }));
    await tick(2_000);
    expect(document.querySelector(".text-destructive")).not.toBeNull();
    expect(screen.queryByTestId("own-tx-wait")).toBeNull();
  });

  it("shows elapsed time, motion and the block cadence on the Quanta side", async () => {
    // The taker locks ETH here: the ETH wait shows no Quanta cadence note.
    legStatus.qrl = 1;
    legStatus.eth = 0;
    render(ui());
    await tick(6_000);
    fireEvent.click(screen.getByRole("button", { name: /^Lock/ }));
    await tick(1_000);
    const wait = screen.getByTestId("own-tx-wait");
    expect(wait.textContent).toContain("Waiting for the transaction to confirm.");
    const before = screen.getByRole("progressbar").firstElementChild?.getAttribute("style");
    await tick(3_000);
    const after = screen.getByRole("progressbar").firstElementChild?.getAttribute("style");
    expect(after).not.toBe(before);
    expect(wait.textContent).toMatch(/0:0[3-6]/);
    expect(wait.textContent).not.toContain(QRL_BLOCK_NOTE);
    // The wallet reported a hash and the call still waits for its receipt.
    expect(screen.getByTestId("swap-now").textContent).toBe(
      "Transaction sent. Waiting for it to confirm on Sepolia.",
    );
    expect(screen.getByRole("button", { name: "Waiting for confirmation…" })).toBeTruthy();
  });

  it("names the Quanta block cadence for a Quanta transaction", async () => {
    revealedLongAgo();
    render(ui());
    await tick(6_000);
    fireEvent.click(screen.getByRole("button", { name: /^Claim/ }));
    await tick(65_000);
    const wait = screen.getByTestId("own-tx-wait");
    expect(wait.textContent).toContain("1:0");
    expect(wait.textContent).toContain(QRL_BLOCK_NOTE);
    expect(screen.getByText("view pending transaction on explorer")).toBeTruthy();
  });
});

describe("hold rules", () => {
  it("does not hold on a stale claim-leg head", async () => {
    revealed();
    // The page clock leaves 2800 s, so the window would end inside the margin.
    // The chain head is an hour old and would claim 3600 s more.
    legTimeoutIn.qrl = 2800;
    chain.headLagS = 3600;
    events.eth = [{ kind: "claimed", txHash: MAKER_HASH, blockNumber: 7 }];
    render(ui());
    await tick(6_000);
    expect(screen.queryByTestId("claim-hold")).toBeNull();
    expect(claimButton()).not.toBeNull();
  });

  it("never holds again once the button was offered", async () => {
    revealed();
    chain.fail = true;
    render(ui());
    await tick(6_000);
    expect(screen.getByTestId("claim-hold")).toBeTruthy();
    await tick(20_000);
    expect(claimButton()).not.toBeNull();
    // The step drops out and comes back: no new hold.
    legStatus.eth = 1;
    await tick(10_000);
    expect(claimButton()).toBeNull();
    legStatus.eth = 2;
    await tick(10_000);
    expect(screen.queryByTestId("claim-hold")).toBeNull();
    expect(claimButton()).not.toBeNull();
  });

  it("promises the wallet only when the automatic start is not blocked", async () => {
    legStatus.qrl = 1;
    legStatus.eth = 1;
    render(ui(null));
    await tick(100);
    revealed();
    events.eth = [{ kind: "claimed", txHash: MAKER_HASH, blockNumber: 7 }];
    reveal.agoS = 0;
    await tick(10_000);
    expect(screen.getByTestId("claim-hold")).toBeTruthy();
    expect(screen.getByTestId("swap-now").textContent).not.toContain("your wallet opens");
    expect(screen.getByTestId("swap-now").textContent).toContain("the Claim button appears.");
  });
});

describe("before the first reading is trusted", () => {
  it("holds a claim step from its first paint and never starts it by itself", async () => {
    revealed();
    // The confirmed-depth read fails, so the first reading is never trusted.
    chain.confirmedFails = true;
    events.eth = [{ kind: "claimed", txHash: MAKER_HASH, blockNumber: 7 }];
    render(ui());
    await tick(6_000);
    expect(claimButton()).toBeNull();
    expect(screen.getByTestId("claim-hold")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuemax")).toBe("180");
    await tick(200_000);
    expect(sends).toHaveLength(0);
  });

  it("shows the checking meter while the reveal cannot be dated, then the button", async () => {
    revealed();
    chain.confirmedFails = true;
    render(ui());
    await tick(6_000);
    expect(claimButton()).toBeNull();
    expect(screen.getByTestId("claim-hold").textContent).toContain("Checking");
    await tick(20_000);
    expect(claimButton()).not.toBeNull();
    expect(sends).toHaveLength(0);
  });
});

describe("discard while the payout is open", () => {
  it("replaces Discard swap for a taker whose payout claim is open", async () => {
    revealedLongAgo();
    render(ui());
    await tick(6_000);
    expect(screen.queryByRole("button", { name: "Discard swap" })).toBeNull();
    expect(
      screen.getByText(/Your payout is still open, so this swap cannot be discarded yet\./),
    ).toBeTruthy();
  });

  it("offers Discard swap again once the initiator leg was refunded", async () => {
    revealedLongAgo();
    legStatus.qrl = 3;
    render(ui());
    await tick(6_000);
    expect(screen.getByRole("button", { name: "Discard swap" })).toBeTruthy();
    expect(screen.queryByText(/Your payout is still open/)).toBeNull();
  });

  it("offers Discard swap once the initiator leg timed out without a refund", async () => {
    revealedLongAgo();
    legTimeoutIn.qrl = -10;
    render(ui());
    await tick(6_000);
    expect(screen.getByRole("button", { name: "Discard swap" })).toBeTruthy();
    expect(screen.queryByText(/Your payout is still open/)).toBeNull();
  });

  it("still offers Discard swap where it was offered before", async () => {
    legStatus.qrl = 1;
    legStatus.eth = 0;
    render(ui());
    await tick(6_000);
    expect(screen.getByRole("button", { name: "Discard swap" })).toBeTruthy();
    expect(screen.queryByText(/Your payout is still open/)).toBeNull();
  });
});

describe("crossed claims", () => {
  const crossedSetup = async () => {
    revealedLongAgo();
    render(ui());
    await tick(6_000);
    fireEvent.click(screen.getByRole("button", { name: /^Claim/ }));
    await tick(2_000);
  };

  it("explains a claim that lost to the maker's claim, without an error", async () => {
    await crossedSetup();
    legStatus.qrl = 2;
    events.qrl = [{ kind: "claimed", txHash: MAKER_HASH }];
    await tick(12_000);
    expect(screen.getByTestId("crossed-claim-note").textContent).toBe(CROSSED_CLAIM_NOTE);
    expect(document.querySelector(".text-destructive")).toBeNull();
  });

  it("shows no note when the own claim is the one that settled", async () => {
    await crossedSetup();
    claimer.addr = TAKER_QRL_HEX;
    legStatus.qrl = 2;
    events.qrl = [{ kind: "claimed", txHash: OWN_HASH.toUpperCase().replace("0X", "0x") }];
    await tick(12_000);
    expect(screen.queryByTestId("crossed-claim-note")).toBeNull();
  });

  it("reads a retry as sent only after the wallet reported that attempt", async () => {
    sender.resolveFirst = true;
    sender.lateIndex = 1;
    revealedLongAgo();
    render(ui());
    await tick(6_000);
    fireEvent.click(screen.getByRole("button", { name: /^Claim/ }));
    await tick(190_000);
    fireEvent.click(screen.getByRole("button", { name: /^Claim/ }));
    await tick(1_000);
    // The old hash is still stored, but this attempt has reported nothing.
    expect(screen.getByTestId("swap-now").textContent).toMatch(
      /^Transaction in progress\. Approve/,
    );
    expect(screen.getByRole("button", { name: "Waiting for wallet…" })).toBeTruthy();
    act(() => {
      sender.report?.();
    });
    await tick(1_000);
    expect(screen.getByTestId("swap-now").textContent).toMatch(/^Transaction sent\./);
    expect(screen.getByRole("button", { name: "Waiting for confirmation…" })).toBeTruthy();
  });

  it("shows no note when the first of two own claims is the one that settled", async () => {
    sender.resolveFirst = true;
    revealedLongAgo();
    claimer.addr = TAKER_QRL_HEX;
    render(ui());
    await tick(6_000);
    fireEvent.click(screen.getByRole("button", { name: /^Claim/ }));
    await tick(1_000);
    // The first claim stays unconfirmed past the wait, so a second is sent.
    await tick(190_000);
    fireEvent.click(screen.getByRole("button", { name: /^Claim/ }));
    await tick(1_000);
    expect(sends).toEqual(["claim", "claim"]);
    // The first one lands and claims; the second is rolled back.
    legStatus.qrl = 2;
    events.qrl = [{ kind: "claimed", txHash: OWN_HASH }];
    await tick(12_000);
    expect(screen.queryByTestId("crossed-claim-note")).toBeNull();
  });

  it("shows no note when the own claim came from another connected account", async () => {
    await crossedSetup();
    claimer.addr = `0x${"99".repeat(64)}`;
    legStatus.qrl = 2;
    events.qrl = [{ kind: "claimed", txHash: OWN_HASH }];
    await tick(12_000);
    expect(screen.queryByTestId("crossed-claim-note")).toBeNull();
  });

  it("covers the ETH initiator leg: own hash is own, a third party's claim is noted", async () => {
    dir.v = "eth->qrl";
    legStatus.eth = 1;
    legStatus.qrl = 2;
    reveal.agoS = 400;
    events.qrl = [{ kind: "claimed", txHash: MAKER_HASH, blockNumber: 7 }];
    render(ui());
    await tick(6_000);
    fireEvent.click(screen.getByRole("button", { name: /^Claim/ }));
    await tick(2_000);
    claimer.addr = `0x${"99".repeat(20)}`;
    legStatus.eth = 2;
    events.eth = [{ kind: "claimed", txHash: OWN_HASH }];
    await tick(12_000);
    expect(screen.queryByTestId("crossed-claim-note")).toBeNull();
    cleanup();
    sends.length = 0;
    events.eth = [{ kind: "claimed", txHash: MAKER_HASH }];
    claimer.addr = `0x${"88".repeat(20)}`;
    render(ui());
    await tick(6_000);
    // A fresh page has reported nothing, so there is no note.
    expect(screen.queryByTestId("crossed-claim-note")).toBeNull();
  });

  it("notes a third party's claim on the ETH initiator leg", async () => {
    dir.v = "eth->qrl";
    legStatus.eth = 1;
    legStatus.qrl = 2;
    reveal.agoS = 400;
    events.qrl = [{ kind: "claimed", txHash: MAKER_HASH, blockNumber: 7 }];
    render(ui());
    await tick(6_000);
    fireEvent.click(screen.getByRole("button", { name: /^Claim/ }));
    await tick(2_000);
    claimer.addr = `0x${"88".repeat(20)}`;
    legStatus.eth = 2;
    events.eth = [{ kind: "claimed", txHash: MAKER_HASH }];
    await tick(12_000);
    expect(screen.getByTestId("crossed-claim-note")).toBeTruthy();
  });

  it("shows no note when a repriced own claim settled under another hash", async () => {
    await crossedSetup();
    claimer.addr = TAKER_QRL_HEX;
    legStatus.qrl = 2;
    events.qrl = [{ kind: "claimed", txHash: MAKER_HASH }];
    await tick(12_000);
    expect(screen.queryByTestId("crossed-claim-note")).toBeNull();
  });

  it("shows no note while the sender of the claim is unknown", async () => {
    await crossedSetup();
    claimer.addr = null;
    legStatus.qrl = 2;
    events.qrl = [{ kind: "claimed", txHash: MAKER_HASH }];
    await tick(12_000);
    expect(screen.queryByTestId("crossed-claim-note")).toBeNull();
  });

  it("shows the note once the node knows the claiming transaction", async () => {
    await crossedSetup();
    claimer.addr = null;
    legStatus.qrl = 2;
    events.qrl = [{ kind: "claimed", txHash: MAKER_HASH }];
    await tick(12_000);
    expect(screen.queryByTestId("crossed-claim-note")).toBeNull();
    claimer.addr = MAKER_QRL_HEX;
    await tick(16_000);
    expect(screen.getByTestId("crossed-claim-note")).toBeTruthy();
  });

  it("shows no note when no own claim was reported in this session", async () => {
    revealedLongAgo();
    legStatus.qrl = 2;
    events.qrl = [{ kind: "claimed", txHash: MAKER_HASH }];
    render(ui());
    await tick(12_000);
    expect(screen.queryByTestId("crossed-claim-note")).toBeNull();
  });

  it("does not keep the reported hash across a reload, so no note appears", async () => {
    await crossedSetup();
    cleanup();
    legStatus.qrl = 2;
    events.qrl = [{ kind: "claimed", txHash: MAKER_HASH }];
    render(ui());
    await tick(12_000);
    expect(screen.queryByTestId("crossed-claim-note")).toBeNull();
  });
});
