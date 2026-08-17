// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEthWallet } from "./useEthWallet";

type ProviderRequest = { method: string; params?: unknown[] | object };
type ProviderHandler = (...args: unknown[]) => void;

class FakeEthProvider {
  private readonly handlers = new Map<string, Set<ProviderHandler>>();

  constructor(private readonly requestAccounts: () => Promise<unknown>) {}

  request = vi.fn(async ({ method }: ProviderRequest) => {
    if (method === "eth_requestAccounts") return this.requestAccounts();
    if (method === "eth_chainId") return "0xaa36a7";
    throw new Error(`Unexpected provider method: ${method}`);
  });

  on(event: string, handler: ProviderHandler) {
    const listeners = this.handlers.get(event) ?? new Set();
    listeners.add(handler);
    this.handlers.set(event, listeners);
  }

  removeListener(event: string, handler: ProviderHandler) {
    this.handlers.get(event)?.delete(handler);
  }

  listenerCount(event: string) {
    return this.handlers.get(event)?.size ?? 0;
  }

  emit(event: string, value: unknown) {
    for (const handler of this.handlers.get(event) ?? []) handler(value);
  }
}

afterEach(() => {
  cleanup();
});

describe("useEthWallet provider lifecycle", () => {
  it("clears a rejection after accounts change and after a successful reconnect", async () => {
    const accountA = `0x${"11".repeat(20)}`;
    const accountB = `0x${"22".repeat(20)}`;
    const rejected = { code: 4001, message: "User rejected the request." };
    const requestAccounts = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce([accountA])
      .mockRejectedValueOnce(rejected)
      .mockRejectedValueOnce(rejected)
      .mockResolvedValueOnce([accountA]);
    const provider = new FakeEthProvider(requestAccounts);
    const detail = {
      info: {
        uuid: "ethereum-wallet",
        name: "Ethereum Wallet",
        icon: "data:image/png;base64,",
        rdns: "io.example.wallet",
      },
      provider,
    };
    const announce = () => {
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", { detail }),
      );
    };
    window.addEventListener("eip6963:requestProvider", announce);

    const { result, unmount } = renderHook(() => useEthWallet());

    await waitFor(() => expect(result.current.providers).toHaveLength(1));

    await act(async () => {
      await result.current.connect(result.current.providers[0]);
    });
    expect(result.current.account).toBe(accountA);
    expect(result.current.error).toBeNull();

    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.error).toBe("Transaction rejected in your wallet.");

    act(() => {
      provider.emit("accountsChanged", [accountB]);
    });
    await waitFor(() => {
      expect(result.current.account).toBe(accountB);
      expect(result.current.error).toBeNull();
    });

    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.error).toBe("Transaction rejected in your wallet.");

    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.account).toBe(accountA);
    expect(result.current.error).toBeNull();
    expect(requestAccounts).toHaveBeenCalledTimes(4);

    window.removeEventListener("eip6963:requestProvider", announce);
    unmount();
  });

  it("ignores a previous provider after switching and detaches on disconnect", async () => {
    const accountA = `0x${"11".repeat(20)}`;
    const staleAccount = `0x${"22".repeat(20)}`;
    const accountB = `0x${"33".repeat(20)}`;
    const providerA = new FakeEthProvider(vi.fn(async () => [accountA]));
    const providerB = new FakeEthProvider(vi.fn(async () => [accountB]));
    const detailA = {
      info: {
        uuid: "ethereum-wallet-a",
        name: "Ethereum Wallet A",
        icon: "data:image/png;base64,",
        rdns: "io.example.wallet-a",
      },
      provider: providerA,
    };
    const detailB = {
      info: {
        uuid: "ethereum-wallet-b",
        name: "Ethereum Wallet B",
        icon: "data:image/png;base64,",
        rdns: "io.example.wallet-b",
      },
      provider: providerB,
    };
    const announce = () => {
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", { detail: detailA }),
      );
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", { detail: detailB }),
      );
    };
    window.addEventListener("eip6963:requestProvider", announce);

    const { result, unmount } = renderHook(() => useEthWallet());
    await waitFor(() => expect(result.current.providers).toHaveLength(2));

    await act(async () => {
      await result.current.connect(result.current.providers[0]);
    });
    expect(result.current.account).toBe(accountA);
    expect(providerA.listenerCount("accountsChanged")).toBe(1);

    await act(async () => {
      await result.current.connect(result.current.providers[1]);
    });
    expect(result.current.account).toBe(accountB);
    expect(providerA.listenerCount("accountsChanged")).toBe(0);
    expect(providerB.listenerCount("accountsChanged")).toBe(1);

    act(() => {
      providerA.emit("accountsChanged", [staleAccount]);
    });
    expect(result.current.account).toBe(accountB);

    act(() => {
      result.current.disconnect();
      providerB.emit("accountsChanged", [staleAccount]);
    });
    expect(result.current.account).toBeNull();
    expect(providerB.listenerCount("accountsChanged")).toBe(0);

    window.removeEventListener("eip6963:requestProvider", announce);
    unmount();
  });
});
