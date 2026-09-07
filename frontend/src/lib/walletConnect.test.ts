// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const initialize = vi.hoisted(() => vi.fn());
vi.mock("@walletconnect/ethereum-provider", () => ({
  EthereumProvider: { init: initialize },
}));

beforeEach(() => {
  vi.resetModules();
  initialize.mockReset();
  vi.stubEnv("VITE_WALLETCONNECT_PROJECT_ID", "0".repeat(32));
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("WalletConnect adapter", () => {
  it("loads once on demand with Sepolia, the app's origin, and the ecosystem theme", async () => {
    const client = {};
    initialize.mockResolvedValue(client);
    const { getWalletConnectClient } = await import("./walletConnect");
    expect(initialize).not.toHaveBeenCalled();
    expect(await getWalletConnectClient()).toBe(client);
    expect(await getWalletConnectClient()).toBe(client);
    expect(initialize).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "0".repeat(32),
        chains: [11155111],
        rpcMap: {
          11155111: new URL("/rpc/sepolia", window.location.origin).href,
        },
        metadata: expect.objectContaining({
          name: "QuantaSwap",
          url: window.location.origin,
        }),
        telemetryEnabled: false,
        showQrModal: true,
        qrModalOptions: expect.objectContaining({
          themeMode: "dark",
          themeVariables: expect.objectContaining({
            "--wcm-accent-color": "#ddc9a6",
          }),
        }),
      }),
    );
  });

  it.each(["", "not-a-project-id"])(
    "stays unavailable for invalid configuration: %s",
    async (id) => {
      vi.stubEnv("VITE_WALLETCONNECT_PROJECT_ID", id);
      const { getWalletConnectClient, isWalletConnectConfigured } = await import("./walletConnect");
      expect(isWalletConnectConfigured()).toBe(false);
      await expect(getWalletConnectClient()).rejects.toThrow("unavailable");
      expect(initialize).not.toHaveBeenCalled();
    },
  );

  it("allows initialization to be retried after failure", async () => {
    initialize.mockRejectedValueOnce(new Error("Relay unavailable")).mockResolvedValueOnce({});
    const { getWalletConnectClient } = await import("./walletConnect");
    await expect(getWalletConnectClient()).rejects.toThrow("Relay unavailable");
    await expect(getWalletConnectClient()).resolves.toEqual({});
  });

  it("restores only an explicitly remembered choice while configuration is present", async () => {
    const { rememberWalletConnect, shouldRestoreWalletConnect } = await import("./walletConnect");
    expect(shouldRestoreWalletConnect()).toBe(false);
    rememberWalletConnect(true);
    expect(shouldRestoreWalletConnect()).toBe(true);
    vi.stubEnv("VITE_WALLETCONNECT_PROJECT_ID", "");
    expect(shouldRestoreWalletConnect()).toBe(false);
    rememberWalletConnect(false);
    vi.stubEnv("VITE_WALLETCONNECT_PROJECT_ID", "0".repeat(32));
    expect(shouldRestoreWalletConnect()).toBe(false);
  });

  it("allows connection without persistence when browser storage is blocked", async () => {
    const { rememberWalletConnect, shouldRestoreWalletConnect } = await import("./walletConnect");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Blocked");
    });
    expect(() => rememberWalletConnect(true)).not.toThrow();
    expect(shouldRestoreWalletConnect()).toBe(false);
  });
});
