// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@qrlwallet/connect-ui", () => {
  class QrlPairingModal extends HTMLElement {
    disconnectedCallback() {
      this.dispatchEvent(new CustomEvent("qrl-cancel"));
    }
  }
  return {
    QrlPairingModal,
    defineQrlPairingModal() {
      if (!customElements.get("qrl-pairing-modal")) {
        customElements.define("qrl-pairing-modal", QrlPairingModal);
      }
    },
  };
});

import { PairingModal } from "./PairingModal";

afterEach(cleanup);

describe("PairingModal lifecycle", () => {
  it("preserves an approved connection when React removes the pairing dialog", () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <PairingModal
        uri="qrlconnect://test"
        statusDetail="connected"
        onCancel={onCancel}
        onNewConnection={vi.fn()}
      />,
    );

    rerender(<></>);

    expect(onCancel).not.toHaveBeenCalled();
  });

  it("forwards an explicit cancel while the pairing dialog is mounted", () => {
    const onCancel = vi.fn();
    const { container } = render(
      <PairingModal
        uri="qrlconnect://test"
        statusDetail="waiting"
        onCancel={onCancel}
        onNewConnection={vi.fn()}
      />,
    );

    container
      .querySelector("qrl-pairing-modal")!
      .dispatchEvent(new CustomEvent("qrl-cancel"));

    expect(onCancel).toHaveBeenCalledOnce();
  });
});
