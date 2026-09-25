import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserProvider } from "ethers";
import { ETH_LEG, QRL_LEG } from "../config";
import { makeLegSender, makePreflightedClaimSender, type LegSenderHandles } from "./legSender";

vi.mock("../config", async importOriginal => {
  const actual = await importOriginal<typeof import("../config")>();
  return { ...actual, QRL_LEG: { ...actual.QRL_LEG, htlc: `Q${"ab".repeat(64)}` },
    ETH_LEG: { ...actual.ETH_LEG, htlc: `0x${"34".repeat(20)}` } };
});

const DATA = `0x${"12".repeat(68)}`;
const ETH_ACCOUNT = "0x1111111111111111111111111111111111111111";
const QRL_ACCOUNT = `Q${"2".repeat(128)}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("secret-bearing claim preflight", () => {
  it("simulates from the actual Ethereum signer before sending", async () => {
    const wait = vi.fn().mockResolvedValue(undefined);
    const sendTransaction = vi.fn().mockResolvedValue({ wait });
    const signer = { getAddress: vi.fn().mockResolvedValue(ETH_ACCOUNT), sendTransaction };
    const rpcSend = vi.fn().mockResolvedValue("0x");
    const provider = {
      getSigner: vi.fn().mockResolvedValue(signer),
      send: rpcSend,
    } as unknown as BrowserProvider;
    const ensureSepolia = vi.fn().mockResolvedValue(undefined);
    const send = makePreflightedClaimSender({
      browserProvider: provider,
      ensureSepolia,
      qrlAccount: null,
      qrlTransport: null,
      qrlRequest: vi.fn(),
    });

    await send("eth", DATA, 0n);

    expect(rpcSend).toHaveBeenCalledWith("eth_call", [
      { from: ETH_ACCOUNT, to: ETH_LEG.htlc, data: DATA, value: "0x0" },
      "latest",
    ]);
    expect(rpcSend.mock.invocationCallOrder[0]!).toBeLessThan(
      sendTransaction.mock.invocationCallOrder[0]!,
    );
    expect(sendTransaction).toHaveBeenCalledWith({ to: ETH_LEG.htlc, data: DATA, value: 0n });
    expect(wait).toHaveBeenCalledOnce();
  });

  it("does not ask the Ethereum wallet to send when simulation reverts", async () => {
    const sendTransaction = vi.fn();
    const provider = {
      getSigner: vi.fn().mockResolvedValue({
        getAddress: vi.fn().mockResolvedValue(ETH_ACCOUNT),
        sendTransaction,
      }),
      send: vi.fn().mockRejectedValue(new Error("recipient transfer reverted")),
    } as unknown as BrowserProvider;
    const send = makePreflightedClaimSender({
      browserProvider: provider,
      ensureSepolia: vi.fn().mockResolvedValue(undefined),
      qrlAccount: null,
      qrlTransport: null,
      qrlRequest: vi.fn(),
    });

    await expect(send("eth", DATA, 0n)).rejects.toThrow(/preflight rejected/);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("blocks legacy Q40 accounts before claim simulation or signing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const qrlRequest = vi.fn().mockResolvedValue("0xtx");
    const handles: LegSenderHandles = {
      browserProvider: null,
      ensureSepolia: vi.fn(),
      qrlAccount: `Q${"2".repeat(40)}`,
      qrlTransport: "extension",
      qrlRequest,
    };

    await expect(makePreflightedClaimSender(handles)("qrl", DATA, 0n)).rejects.toThrow(
      /64-byte address/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(qrlRequest).not.toHaveBeenCalled();
  });

  it("refuses a provider on the previous network before simulation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const qrlRequest = vi.fn(async ({ method }: { method: string }) => method === "qrl_chainId" ? "0x539" : { number: "0x0", hash: QRL_LEG.genesisHash });
    const send = makePreflightedClaimSender({
      browserProvider: null,
      ensureSepolia: vi.fn(),
      qrlAccount: QRL_ACCOUNT,
      qrlTransport: "extension",
      qrlRequest,
    });

    await expect(send("qrl", DATA, 0n)).rejects.toThrow(/identity mismatch/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(qrlRequest).toHaveBeenCalledTimes(2);
  });
});

describe("qualified QRL sends", () => {
  it.each([false, true])("pins the chain and rechecks after gas estimation, provider changed: %s", async change => {
    let providerChain = QRL_LEG.chainIdHex;
    const qrlRequest = vi.fn(async ({ method }: { method: string }): Promise<unknown> => {
      if (method === "qrl_chainId") return providerChain;
      if (method === "qrl_getBlockByNumber") return { number: "0x0", hash: QRL_LEG.genesisHash };
      if (method === "qrl_sendTransaction") return `0x${"12".repeat(32)}`;
      throw new Error("Unexpected wallet request");
    });
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      const { method } = JSON.parse(init.body as string);
      if (method === "qrl_estimateGas" && change) providerChain = "0x539";
      return { ok: true, json: async () => ({ result: method === "qrl_chainId" ? QRL_LEG.chainIdHex : method === "qrl_getBlockByNumber" ? { number: "0x0", hash: QRL_LEG.genesisHash } : "0x10000" }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const handles: LegSenderHandles = { browserProvider: null, ensureSepolia: vi.fn(), qrlAccount: QRL_ACCOUNT, qrlTransport: "extension", qrlRequest };
    const result = makeLegSender(handles)("qrl", DATA, 1n);
    if (change) await expect(result).rejects.toThrow(/identity mismatch/);
    else await result;
    const sends = qrlRequest.mock.calls.filter(([args]) => args.method === "qrl_sendTransaction");
    expect(sends).toHaveLength(change ? 0 : 1);
    if (!change) expect(qrlRequest).toHaveBeenCalledWith({ method: "qrl_sendTransaction", params: [expect.objectContaining({ chainId: QRL_LEG.chainIdHex, from: QRL_ACCOUNT, to: QRL_LEG.htlc })] });
  });
});
