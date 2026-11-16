// @vitest-environment jsdom
// The whole chain the page relies on: a tracked wallet request switches the
// hint on, the element shows itself after its delay, and the answer clears it.
import { useState, useSyncExternalStore } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalHint } from "./ApprovalHint";
import {
  createApprovalRequests,
  trackedProvider,
  type ApprovalRequestProvider,
  type ApprovalRequests,
} from "@qrlwallet/connect-ui/flow";

let approvals: ApprovalRequests;

function Page() {
  const [store] = useState(() => approvals);
  const pending = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.pending(),
  );
  return (
    <ApprovalHint wallet={{ name: "MetaMask", icon: null, kind: "extension" }} pending={pending} />
  );
}

const hint = (): Element => {
  const el = document.querySelector("qrl-approval-hint");
  if (el === null) throw new Error("no hint element");
  return el;
};

describe("a wallet request and the page's hint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    approvals = createApprovalRequests();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows the hint for a prompt left unanswered and clears it with the answer", async () => {
    let answer: (hash: string) => void = () => undefined;
    const wallet: ApprovalRequestProvider = {
      request: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    };
    const provider = trackedProvider(wallet, approvals);
    render(<Page />);
    expect(hint().hasAttribute("pending")).toBe(false);

    let sent: Promise<unknown> = Promise.resolve();
    act(() => {
      sent = provider.request({ method: "eth_sendTransaction", params: [] });
    });
    expect(hint().hasAttribute("pending")).toBe(true);
    expect(hint().hasAttribute("shown")).toBe(false);
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(hint().hasAttribute("shown")).toBe(true);
    expect(hint().shadowRoot?.querySelector(".title")?.textContent).toBe("Waiting for MetaMask");

    await act(async () => {
      answer("0xhash");
      await sent;
    });
    expect(hint().hasAttribute("pending")).toBe(false);
    expect(hint().hasAttribute("shown")).toBe(false);
  });

  it("stays out of the way for a read", async () => {
    const wallet: ApprovalRequestProvider = { request: () => Promise.resolve("0x1") };
    const provider = trackedProvider(wallet, approvals);
    render(<Page />);
    await act(async () => {
      await provider.request({ method: "eth_chainId" });
      vi.advanceTimersByTime(10_000);
    });
    expect(hint().hasAttribute("pending")).toBe(false);
  });
});
