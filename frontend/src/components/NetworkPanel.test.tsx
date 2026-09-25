// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ETH_LEG, QRL_LEG } from "@/config";
import { NetworkPanel } from "./NetworkPanel";

vi.mock("@/lib/htlc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/htlc")>();
  return {
    ...actual,
    getBlockNumber: vi.fn().mockRejectedValue(new Error("offline test")),
  };
});

afterEach(cleanup);

describe("NetworkPanel", () => {
  it("describes target-specific builds and keeps complete explorer destinations", () => {
    render(<NetworkPanel />);

    expect(
      screen.getByText(/One reviewed Hyperion source, compiled for each chain/),
    ).toBeTruthy();
    expect(screen.queryByText(/byte-identical bytecode/)).toBeNull();
    expect(
      screen
        .getByRole("link", { name: `View ${QRL_LEG.name} HTLC ${QRL_LEG.htlc} on explorer` })
        .getAttribute("href"),
    ).toBe(`https://zondscan.com/address/${QRL_LEG.htlc}`);
    expect(
      screen
        .getByRole("link", { name: `View ${ETH_LEG.name} HTLC ${ETH_LEG.htlc} on explorer` })
        .getAttribute("href"),
    ).toBe(`https://sepolia.etherscan.io/address/${ETH_LEG.htlc}`);
  });
});
