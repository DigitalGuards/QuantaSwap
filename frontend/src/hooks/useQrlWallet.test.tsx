// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@qrlwallet/connect", () => {
  class QRLConnectMock {
    private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();

    disconnect = vi.fn(async () => undefined);
    getAccounts = vi.fn(() => [] as string[]);
    getChannelId = vi.fn(() => "relay-channel");
    getConnectionURI = vi.fn(async () => "qrlconnect://relay-channel");
    getStatus = vi.fn(() => "disconnected");
    hasStoredSession = vi.fn(() => false);
    isConnected = vi.fn(() => false);
    isMobile = vi.fn(() => false);
    newConnection = vi.fn(async () => "qrlconnect://fresh-channel");
    request = vi.fn(async () => [] as string[]);

    on(event: string, handler: (...args: unknown[]) => void) {
      const listeners = this.handlers.get(event) ?? new Set();
      listeners.add(handler);
      this.handlers.set(event, listeners);
    }

    off(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.get(event)?.delete(handler);
    }
  }

  return {
    QRLConnect: QRLConnectMock,
    QRL_CONNECT_PROVIDER_INFO: {
      uuid: "qrl-connect",
      name: "MyQRLWallet",
      icon: "data:image/png;base64,",
      rdns: "com.qrlwallet.connect",
    },
    attemptWalletRedirect: vi.fn(async () => false),
    getAppStoreUrl: vi.fn(() => "https://qrlwallet.com"),
  };
});

import { useQrlWallet } from "./useQrlWallet";

type ProviderRequest = { method: string; params?: unknown[] | object };
type ProviderHandler = (...args: unknown[]) => void;

class FakeQrlProvider {
  private readonly handlers = new Map<string, Set<ProviderHandler>>();

  constructor(private readonly requestAccounts: () => Promise<unknown>) {}

  request = vi.fn(async ({ method }: ProviderRequest) => {
    if (method === "qrl_requestAccounts") return this.requestAccounts();
    throw new Error(`Unexpected provider method: ${method}`);
  });

  on(event: string, handler: ProviderHandler) {
    const listeners = this.handlers.get(event) ?? new Set();
    listeners.add(handler);
    this.handlers.set(event, listeners);
  }

  emit(event: string, value: unknown) {
    for (const handler of this.handlers.get(event) ?? []) handler(value);
  }
}

afterEach(() => {
  cleanup();
});

describe("useQrlWallet extension lifecycle", () => {
  it("connects, clears revoked permission, reconnects, and preserves a 4100 message", async () => {
    const mixedCaseAccount = `Q${"aB".repeat(20)}`;
    const canonicalAccount = mixedCaseAccount.toLowerCase().replace(/^q/, "Q");
    const unauthorized = {
      code: 4100,
      message: `The requested account ${canonicalAccount} has not been authorized by the user.`,
    };
    const requestAccounts = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce([mixedCaseAccount])
      .mockResolvedValueOnce([canonicalAccount])
      .mockRejectedValueOnce(unauthorized);
    const provider = new FakeQrlProvider(requestAccounts);
    const detail = {
      info: {
        uuid: "myqrlwallet-extension",
        name: "MyQRLWallet Extension",
        icon: "data:image/png;base64,",
        rdns: "com.qrlwallet.extension",
      },
      provider,
    };
    const announce = () => {
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", { detail }),
      );
    };
    window.addEventListener("eip6963:requestProvider", announce);

    const { result, unmount } = renderHook(() => useQrlWallet());

    await waitFor(() => {
      expect(result.current.wallets).toEqual([
        expect.objectContaining({
          uuid: detail.info.uuid,
          kind: "extension",
          rdns: detail.info.rdns,
        }),
      ]);
    });

    await act(async () => {
      await result.current.connectWallet(detail.info.uuid);
    });

    expect(result.current.account).toBe(mixedCaseAccount);
    expect(result.current.status).toBe("connected");
    expect(result.current.kind).toBe("extension");
    expect(result.current.rdns).toBe(detail.info.rdns);
    expect(result.current.error).toBeNull();

    act(() => {
      provider.emit("accountsChanged", []);
    });

    await waitFor(() => {
      expect(result.current.account).toBeNull();
      expect(result.current.status).toBe("disconnected");
      expect(result.current.kind).toBeNull();
      expect(result.current.rdns).toBeNull();
    });

    await act(async () => {
      await result.current.connectWallet(detail.info.uuid);
    });

    expect(result.current.account).toBe(canonicalAccount);
    expect(result.current.status).toBe("connected");
    expect(result.current.kind).toBe("extension");

    act(() => {
      provider.emit("accountsChanged", []);
    });
    await waitFor(() => expect(result.current.status).toBe("disconnected"));

    await act(async () => {
      await result.current.connectWallet(detail.info.uuid);
    });

    expect(result.current.account).toBeNull();
    expect(result.current.status).toBe("disconnected");
    expect(result.current.kind).toBeNull();
    expect(result.current.error).toBe(unauthorized.message);
    expect(requestAccounts).toHaveBeenCalledTimes(3);

    window.removeEventListener("eip6963:requestProvider", announce);
    unmount();
  });
});
