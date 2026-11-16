// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ApprovalHint } from "./ApprovalHint";

afterEach(cleanup);

const hint = (): Element => {
  const el = document.querySelector("qrl-approval-hint");
  if (el === null) throw new Error("no hint element");
  return el;
};

describe("ApprovalHint", () => {
  it("hands the wallet and the open request to the element", () => {
    const { rerender } = render(
      <ApprovalHint wallet={{ name: "MetaMask", icon: null, kind: "extension" }} pending={false} />,
    );
    expect(hint().getAttribute("wallet-name")).toBe("MetaMask");
    expect(hint().getAttribute("kind")).toBe("extension");
    expect(hint().hasAttribute("pending")).toBe(false);

    rerender(
      <ApprovalHint wallet={{ name: "MyQRLWallet", icon: null, kind: "paired" }} pending={true} />,
    );
    expect(hint().getAttribute("wallet-name")).toBe("MyQRLWallet");
    expect(hint().getAttribute("kind")).toBe("paired");
    expect(hint().hasAttribute("pending")).toBe(true);
  });

  it("stays neutral while the wallet is unknown and leaves the page cleanly", () => {
    const { unmount } = render(<ApprovalHint wallet={null} pending={true} />);
    expect(hint().getAttribute("wallet-name")).toBe("");
    expect(hint().hasAttribute("pending")).toBe(true);
    unmount();
    expect(document.querySelector("qrl-approval-hint")).toBeNull();
  });
});
