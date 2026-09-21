// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QRL_LEG } from "@/config";
import { Header } from "./Header";

const ETH_ADDRESS = `0x${"12".repeat(20)}`;
const QRL_ADDRESS =
  `Q${"11111111"}${"2".repeat(52)}${"33333333"}` +
  `${"4".repeat(52)}${"55555555"}`;

afterEach(cleanup);

describe("Header connected-wallet identities", () => {
  it("renders a compact QRL identity with the complete address in the explorer link", () => {
    render(
      <MemoryRouter>
        <Header
          ethAccount={ETH_ADDRESS}
          onConnectEth={vi.fn()}
          onDisconnectEth={vi.fn()}
          qrlAccount={QRL_ADDRESS}
          qrlStatus="connected"
          onConnectQrl={vi.fn()}
          onDisconnectQrl={vi.fn()}
        />
      </MemoryRouter>,
    );

    const qrlLink = screen.getByRole("link", {
      name: `View QRL wallet ${QRL_ADDRESS} on Zondscan`,
    });
    expect(qrlLink.getAttribute("href")).toBe(`${QRL_LEG.explorerAddress}${QRL_ADDRESS}`);
    expect(qrlLink.textContent).toContain("QRL");
    expect(qrlLink.textContent).toContain("Q11111111...33333333...55555555");
    expect(qrlLink.textContent).not.toContain(QRL_ADDRESS);
  });
});
