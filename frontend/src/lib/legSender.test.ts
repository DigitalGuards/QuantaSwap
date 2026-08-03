import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserProvider } from "ethers";
import { ETH_LEG, QRL_LEG } from "../config";
import { makePreflightedClaimSender, type LegSenderHandles } from "./legSender";

const DATA = `0x${"12".repeat(68)}`;
const ETH_ACCOUNT = "0x1111111111111111111111111111111111111111";
const QRL_ACCOUNT = "Q2222222222222222222222222222222222222222";

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

  it("requires qrl_call and strict extension gas estimation before sending", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x186a0" }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const qrlRequest = vi.fn().mockResolvedValue("0xtx");
    const handles: LegSenderHandles = {
      browserProvider: null,
      ensureSepolia: vi.fn(),
      qrlAccount: QRL_ACCOUNT,
      qrlTransport: "extension",
      qrlRequest,
    };

    await makePreflightedClaimSender(handles)("qrl", DATA, 0n);

    const firstBody = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as {
      method: string;
      params: unknown[];
    };
    const secondBody = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string) as {
      method: string;
    };
    expect(firstBody).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "qrl_call",
      params: [{ from: QRL_ACCOUNT, to: QRL_LEG.htlc, data: DATA }, "latest"],
    });
    expect(secondBody.method).toBe("qrl_estimateGas");
    expect(qrlRequest).toHaveBeenCalledWith({
      method: "qrl_sendTransaction",
      params: [
        expect.objectContaining({
          from: QRL_ACCOUNT,
          to: QRL_LEG.htlc,
          data: DATA,
          gas: 130_000,
          gasLimit: 130_000,
          type: "0x2",
        }),
      ],
    });
  });

  it("never uses the extension fallback when strict estimation fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "estimate unavailable" } }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const qrlRequest = vi.fn();
    const send = makePreflightedClaimSender({
      browserProvider: null,
      ensureSepolia: vi.fn(),
      qrlAccount: QRL_ACCOUNT,
      qrlTransport: "extension",
      qrlRequest,
    });

    await expect(send("qrl", DATA, 0n)).rejects.toThrow(/gas estimation failed/);
    expect(qrlRequest).not.toHaveBeenCalled();
  });
});
