// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMetaMaskClient, type MetaMaskClient } from "@/lib/metaMask";
import { useEthWallet, type ProviderDetail } from "./useEthWallet";

vi.mock("@/lib/metaMask", () => ({ getMetaMaskClient: vi.fn() }));

const accountA = `0x${"11".repeat(20)}`;
const accountB = `0x${"22".repeat(20)}`;
const cleanups: (() => void)[] = [];

class FakeProvider {
  handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  request = vi.fn(
    async ({ method }: { method: string; params?: unknown[] | object }): Promise<unknown> => {
      if (method === "eth_requestAccounts") return [accountA];
      if (method === "eth_chainId") return "0xaa36a7";
      if (method === "wallet_switchEthereumChain") return null;
      throw new Error(`Unexpected request: ${method}`);
    },
  );
  on(event: string, handler: (...args: unknown[]) => void) {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
  }
  removeListener(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.get(event)?.delete(handler);
  }
  emit(event: string, value?: unknown) {
    for (const handler of this.handlers.get(event) ?? []) handler(value);
  }
}

function wallet(name = "MetaMask", rdns = "io.metamask") {
  const provider = new FakeProvider();
  const detail = { info: { uuid: name, name, rdns, icon: "" }, provider } satisfies ProviderDetail;
  return detail;
}

function discover(wallets: ProviderDetail[]) {
  const announce = () =>
    wallets.forEach((detail) =>
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail })),
    );
  window.addEventListener("eip6963:requestProvider", announce);
  cleanups.push(() => window.removeEventListener("eip6963:requestProvider", announce));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mockMobile() {
  const provider = new FakeProvider();
  const client = {
    connect: vi.fn(async () => ({ accounts: [accountA], chainId: "0xaa36a7" })),
    getProvider: () => provider,
    disconnect: vi.fn(async () => undefined),
  };
  vi.mocked(getMetaMaskClient).mockResolvedValue(client as unknown as MetaMaskClient);
  return { client, provider };
}

afterEach(() => {
  cleanup();
  cleanups.splice(0).forEach((dispose) => dispose());
  Reflect.deleteProperty(window, "ethereum");
  vi.clearAllMocks();
});

describe("Ethereum wallet selection", () => {
  it.each([1, 2])(
    "opens the chooser with %i installed wallets without requesting an account",
    (count) => {
      const wallets = [wallet(), wallet("Rabby", "io.rabby")].slice(0, count);
      discover(wallets);
      const { result } = renderHook(useEthWallet);
      act(() => result.current.openPicker());
      expect(result.current.pickerOpen).toBe(true);
      expect(result.current.providers).toHaveLength(count);
      for (const detail of wallets) expect(detail.provider.request).not.toHaveBeenCalled();
      expect(getMetaMaskClient).not.toHaveBeenCalled();
    },
  );

  it("prompts only the selected wallet and keeps QRL providers out of the ETH list", async () => {
    const metamask = wallet();
    const rabby = wallet("Rabby", "io.rabby");
    discover([metamask, rabby, wallet("MyQRLWallet", "com.qrlwallet.extension")]);
    const { result } = renderHook(useEthWallet);
    act(() => result.current.openPicker());
    await act(async () => result.current.connect(rabby));
    expect(result.current.providers).toHaveLength(2);
    expect(metamask.provider.request).not.toHaveBeenCalled();
    expect(rabby.provider.request).toHaveBeenCalledOnce();
    expect(result.current.walletName).toBe("Rabby");
    expect(result.current.account).toBe(accountA);
    expect(result.current.pickerOpen).toBe(false);
  });

  it("offers an older injected provider as an explicit choice", async () => {
    const provider = new FakeProvider();
    Object.defineProperty(window, "ethereum", { configurable: true, value: provider });
    const { result } = renderHook(useEthWallet);
    act(() => result.current.openPicker());
    expect(provider.request).not.toHaveBeenCalled();
    const choice = result.current.providers[0];
    expect(choice?.info.name).toBe("Browser wallet");
    if (!choice) throw new Error("Missing legacy choice");
    await act(async () => result.current.connect(choice));
    expect(result.current.account).toBe(accountA);
  });

  it("keeps rejection errors in the chooser and allows a successful retry", async () => {
    const detail = wallet();
    detail.provider.request.mockRejectedValueOnce({ code: 4001 });
    discover([detail]);
    const { result } = renderHook(useEthWallet);
    act(() => result.current.openPicker());
    await act(async () => result.current.connect(detail));
    expect(result.current.pickerOpen).toBe(true);
    expect(result.current.error).toMatch(/Connection declined/);
    expect(result.current.pendingId).toBeNull();
    await act(async () => result.current.connect(detail));
    expect(result.current.account).toBe(accountA);
    expect(result.current.error).toBeNull();
  });

  it("ignores a canceled approval while the user connects a different wallet", async () => {
    const pending = deferred<unknown>();
    const first = wallet();
    const second = wallet("Rabby", "io.rabby");
    first.provider.request.mockReturnValueOnce(pending.promise);
    discover([first, second]);
    const { result } = renderHook(useEthWallet);
    act(() => result.current.openPicker());
    let connecting!: Promise<void>;
    act(() => {
      connecting = result.current.connect(first);
    });
    await act(async () => result.current.connect(second));
    expect(second.provider.request).not.toHaveBeenCalled();
    act(() => result.current.closePicker());
    expect(result.current.pendingId).toBeNull();
    act(() => result.current.openPicker());
    await act(async () => result.current.connect(first));
    expect(first.provider.request).toHaveBeenCalledOnce();
    expect(result.current.error).toMatch(/existing connection request/);
    await act(async () => result.current.connect(second));
    expect(result.current.walletName).toBe("Rabby");
    await act(async () => {
      pending.resolve([accountA]);
      await connecting;
    });
    expect(result.current.walletName).toBe("Rabby");
    expect(result.current.pendingId).toBeNull();
  });

  it("cleans up old listeners when switching wallets and on dapp disconnect", async () => {
    const first = wallet();
    const second = wallet("Rabby", "io.rabby");
    discover([first, second]);
    const { result } = renderHook(useEthWallet);
    await act(async () => result.current.connect(first));
    await act(async () => result.current.connect(second));
    expect(first.provider.handlers.get("accountsChanged")?.size).toBe(0);
    act(() => first.provider.emit("accountsChanged", [accountB]));
    expect(result.current.account).toBe(accountA);
    act(() => second.provider.emit("accountsChanged", [accountB]));
    expect(result.current.account).toBe(accountB);
    await act(async () => result.current.disconnect());
    act(() => second.provider.emit("accountsChanged", [accountA]));
    expect(result.current.account).toBeNull();
    expect(result.current.browserProvider).toBeNull();
    expect(second.provider.handlers.get("disconnect")?.size).toBe(0);
  });

  it.each(["accountsChanged", "disconnect"])(
    "clears the provider after wallet-side %s",
    async (event) => {
      const detail = wallet();
      const { result } = renderHook(useEthWallet);
      await act(async () => result.current.connect(detail));
      act(() => detail.provider.emit(event, []));
      expect(result.current.account).toBeNull();
      expect(result.current.browserProvider).toBeNull();
      await expect(result.current.ensureSepolia()).rejects.toThrow("not connected");
    },
  );

  it("rejects empty or malformed account responses", async () => {
    const detail = wallet();
    const { result } = renderHook(useEthWallet);
    for (const accounts of [[], ["Q" + "11".repeat(20)], null, "0x1234"]) {
      detail.provider.request.mockResolvedValueOnce(accounts);
      await act(async () => result.current.connect(detail));
      expect(result.current.account).toBeNull();
      expect(result.current.error).toMatch(/did not share/);
    }
  });

  it("requests Sepolia when the selected wallet is on another chain", async () => {
    const detail = wallet();
    const { result } = renderHook(useEthWallet);
    await act(async () => result.current.connect(detail));
    detail.provider.request.mockResolvedValueOnce("0x1");
    await act(async () => result.current.ensureSepolia());
    expect(detail.provider.request).toHaveBeenLastCalledWith({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0xaa36a7" }],
    });
  });
});

describe("MetaMask mobile connection", () => {
  it("loads on selection, requests Sepolia, and disconnects the SDK session", async () => {
    const { client, provider } = mockMobile();
    const { result } = renderHook(useEthWallet);
    expect(getMetaMaskClient).not.toHaveBeenCalled();
    await act(async () => result.current.connectMetaMask());
    expect(client.connect).toHaveBeenCalledWith({ chainIds: ["0xaa36a7"] });
    expect(result.current.account).toBe(accountA);
    expect(result.current.walletName).toBe("MetaMask");
    act(() => provider.emit("accountsChanged", [accountB]));
    expect(result.current.account).toBe(accountB);
    await act(async () => result.current.disconnect());
    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(result.current.account).toBeNull();
    expect(provider.handlers.get("accountsChanged")?.size).toBe(0);
  });

  it("reopens the chooser after a declined mobile connection", async () => {
    const { client } = mockMobile();
    client.connect.mockRejectedValueOnce({ code: 4001 });
    const { result } = renderHook(useEthWallet);
    await act(async () => result.current.connectMetaMask());
    expect(result.current.pickerOpen).toBe(true);
    expect(result.current.error).toMatch(/Connection declined/);
    expect(result.current.pendingId).toBeNull();
  });

  it("discards and closes a mobile session approved after unmount", async () => {
    const { client } = mockMobile();
    const pending = deferred<{ accounts: string[]; chainId: string }>();
    client.connect.mockReturnValueOnce(pending.promise);
    const { result, unmount } = renderHook(useEthWallet);
    let connecting!: Promise<void>;
    await act(async () => {
      connecting = result.current.connectMetaMask();
    });
    unmount();
    await act(async () => {
      pending.resolve({ accounts: [accountA], chainId: "0xaa36a7" });
      await connecting;
    });
    expect(client.disconnect).toHaveBeenCalledOnce();
  });
});
