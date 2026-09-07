// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const createClient = vi.hoisted(() => vi.fn());
vi.mock("@metamask/connect-evm", () => ({ createEVMClient: createClient }));

beforeEach(() => {
  vi.resetModules();
  createClient.mockReset();
});

describe("MetaMask mobile adapter", () => {
  it("initializes once on demand with the existing Sepolia proxy and analytics disabled", async () => {
    const client = {};
    createClient.mockResolvedValue(client);
    const { getMetaMaskClient } = await import("./metaMask");
    expect(createClient).not.toHaveBeenCalled();
    expect(await getMetaMaskClient()).toBe(client);
    expect(await getMetaMaskClient()).toBe(client);
    expect(createClient).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledWith({
      dapp: {
        name: "QuantaSwap",
        url: window.location.origin,
        iconUrl: new URL("/apple-touch-icon.png", window.location.origin).href,
      },
      api: {
        supportedNetworks: { "0xaa36a7": new URL("/rpc/sepolia", window.location.origin).href },
      },
      ui: { preferExtension: false },
      analytics: { enabled: false },
      skipAutoAnnounce: true,
    });
  });

  it("allows retry after initialization fails", async () => {
    createClient
      .mockRejectedValueOnce(new Error("Connection unavailable"))
      .mockResolvedValueOnce({});
    const { getMetaMaskClient } = await import("./metaMask");
    await expect(getMetaMaskClient()).rejects.toThrow("Connection unavailable");
    await expect(getMetaMaskClient()).resolves.toEqual({});
    expect(createClient).toHaveBeenCalledTimes(2);
  });
});
