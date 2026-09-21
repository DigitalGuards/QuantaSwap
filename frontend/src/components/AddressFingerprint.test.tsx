// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AddressFingerprint, ChainAddressPair } from "./AddressFingerprint";

const ETH_ADDRESS = `0x${"12".repeat(20)}`;
const QRL_ADDRESS =
  `Q${"11111111"}${"2".repeat(52)}${"33333333"}` +
  `${"4".repeat(52)}${"55555555"}`;

afterEach(cleanup);

describe("AddressFingerprint", () => {
  it("renders the QRL first, middle, and final fingerprint with the complete identity available", () => {
    render(<AddressFingerprint address={QRL_ADDRESS} />);

    const identity = screen.getByLabelText(QRL_ADDRESS);
    expect(identity.textContent).toBe("Q11111111...33333333...55555555");
    expect(identity.getAttribute("title")).toBe(QRL_ADDRESS);
    expect(identity.textContent).not.toBe(QRL_ADDRESS);
  });

  it("keeps the existing compact Ethereum identity", () => {
    render(<AddressFingerprint address={ETH_ADDRESS} />);

    expect(screen.getByLabelText(ETH_ADDRESS).textContent).toBe("0x121212…1212");
  });
});

describe("ChainAddressPair", () => {
  it("shows ETH and QRL as separate identity rows", () => {
    render(<ChainAddressPair ethAddress={ETH_ADDRESS} qrlAddress={QRL_ADDRESS} />);

    expect(screen.queryByText("ETH")).not.toBeNull();
    expect(screen.queryByText("QRL")).not.toBeNull();
    expect(screen.getByLabelText(ETH_ADDRESS).getAttribute("title")).toBe(ETH_ADDRESS);
    expect(screen.getByLabelText(QRL_ADDRESS).textContent).toBe(
      "Q11111111...33333333...55555555",
    );
  });
});
