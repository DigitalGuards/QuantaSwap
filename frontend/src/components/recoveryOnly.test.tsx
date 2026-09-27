// @vitest-environment jsdom
// This release is kept only so swaps started before the HTLCv3 cutover can be
// finished, refunded or released. It is served under a sub-path, and that is
// the signal: a build at /v2/ must never lock new funds into the contract
// generation it belongs to, and must never take an order that would.
//
// The gate is a module constant read at import time, so each case imports the
// component with BASE_URL already set for that case.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/orderbook", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/orderbook")>();
  return {
    ...actual,
    listOrders: vi.fn().mockResolvedValue({ orders: [], mirrors: [] }),
    getOrder: vi.fn().mockRejectedValue(new Error("offline test")),
  };
});

vi.mock("@/lib/mirrorBook", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mirrorBook")>();
  return { ...actual, loadMirrorBook: vi.fn().mockResolvedValue({ rows: [], mirrors: [] }) };
});

const WALLET_PROPS = {
  ethAccount: null,
  qrlAccount: null,
  qrlRequest: vi.fn(),
  qrlWalletRdns: null,
};

async function importWithBase(base: string) {
  vi.resetModules();
  vi.stubEnv("BASE_URL", base);
  const post = await import("./PostOrderCard");
  const book = await import("./OrderBookPanel");
  return { PostOrderCard: post.PostOrderCard, OrderBookPanel: book.OrderBookPanel };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("legacy release under a sub-path", () => {
  it("renders no post form, so it cannot lock new funds into HTLCv2", async () => {
    const { PostOrderCard } = await importWithBase("/v2/");
    render(
      <PostOrderCard
        {...WALLET_PROPS}
        browserProvider={null}
        ensureSepolia={vi.fn()}
        qrlTransport={null}
        prefill={null}
        onPosted={vi.fn()}
      />,
    );
    expect(screen.getByText("Recovery only")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Post order/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /switch direction/i })).toBeNull();
    expect(screen.queryByText("You give")).toBeNull();
  });

  it("still renders the post form at the site root", async () => {
    const { PostOrderCard } = await importWithBase("/");
    render(
      <PostOrderCard
        {...WALLET_PROPS}
        browserProvider={null}
        ensureSepolia={vi.fn()}
        qrlTransport={null}
        prefill={null}
        onPosted={vi.fn()}
      />,
    );
    expect(screen.queryByText("Recovery only")).toBeNull();
    expect(screen.getByRole("button", { name: /switch direction/i })).toBeTruthy();
  });

  it("shows the book read only, with no take action", async () => {
    const { OrderBookPanel } = await importWithBase("/v2/");
    render(
      <OrderBookPanel
        {...WALLET_PROPS}
        ownOrderId={null}
        takeDisabled={false}
        onTaken={vi.fn()}
        onPrefill={vi.fn()}
      />,
    );
    expect(await screen.findByText(/The book is shown read only/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Take/ })).toBeNull();
  });
});
