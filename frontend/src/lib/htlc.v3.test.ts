import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeParameters } from "@theqrl/web3-qrl-abi";
import { QRL_LEG } from "../config";
import { getBlockNumber, getLegState, getSwapEvents, htlcInterface, qrvm64Topic } from "./htlc";
import { assertQrlNetwork } from "./qrlNetwork";
import { encodeQrvmHtlc } from "./qrvmHtlc";

vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return { ...actual, QRL_LEG: { ...actual.QRL_LEG, htlc: `Q${"ab".repeat(64)}` } };
});
afterEach(() => vi.unstubAllGlobals());

const hash = `0x${"12".repeat(32)}`;
function networkFetch(result: unknown, chain = QRL_LEG.chainIdHex) {
  return vi.fn(async (_url: unknown, init: RequestInit) => {
    const { method } = JSON.parse(init.body as string) as { method: string };
    return {
      ok: true,
      json: async () => ({
        result:
          method === "qrl_chainId"
            ? chain
            : method === "qrl_getBlockByNumber"
              ? { number: "0x0", hash: QRL_LEG.genesisHash }
              : result,
      }),
    };
  });
}

describe("v3 RPC identity and HTLC reads", () => {
  it.each([null, [], {}, { error: { message: 3 } }, { result: {} }])(
    "rejects malformed RPC envelopes and block quantities: %j",
    async (body) => {
      vi.stubGlobal("fetch", () =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve<unknown>(body),
        }),
      );
      await expect(getBlockNumber("eth")).rejects.toThrow();
    },
  );

  it("validates Ethereum decoded tuples and bounds their numeric fields", async () => {
    for (const [status, timeout] of [
      [1, 1_800_000_000n],
      [4, 1_800_000_000n],
      [1, 2n ** 53n],
    ] as const) {
      const raw = htlcInterface.encodeFunctionResult("getSwap", [
        [
          `0x${"ab".repeat(20)}`,
          `0x${"cd".repeat(20)}`,
          `0x${"00".repeat(20)}`,
          123n,
          timeout,
          status,
          hash,
        ],
      ]);
      vi.stubGlobal("fetch", networkFetch(raw));
      const result = getLegState("eth", hash);
      if (status === 1 && timeout < 2n ** 53n) {
        await expect(result).resolves.toMatchObject({
          status: 1,
          amount: 123n,
          timeout: 1_800_000_000,
        });
      } else {
        await expect(result).rejects.toThrow();
      }
    }
  });
  it("checks chain and genesis before a full-width getSwap call", async () => {
    const raw = encodeParameters(
      ["address", "address", "address", "uint256", "uint256", "uint8", "bytes32"],
      [QRL_LEG.htlc, QRL_LEG.htlc, `Q${"0".repeat(128)}`, "123", "1800000000", "1", hash],
    );
    const fetchMock = networkFetch(raw);
    vi.stubGlobal("fetch", fetchMock);
    expect(await getLegState("qrl", hash, "0x10")).toMatchObject({
      status: 1,
      amount: 123n,
      initiator: `0x${"ab".repeat(64)}`,
    });
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body as string)).toMatchObject({
      method: "qrl_call",
      params: [{ to: QRL_LEG.htlc, data: encodeQrvmHtlc("getSwap", [hash]) }, "0x10"],
    });
  });

  it("refuses reads from a mismatched chain before sending contract calldata", async () => {
    const fetchMock = networkFetch("0x", "0x539");
    vi.stubGlobal("fetch", fetchMock);
    await expect(getLegState("qrl", hash)).rejects.toThrow(/identity mismatch/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a matching chain ID with an incorrect genesis or block number", async () => {
    for (const genesis of [
      { number: "0x0", hash: `0x${"0".repeat(64)}` },
      { number: "0x1", hash: QRL_LEG.genesisHash },
    ]) {
      await expect(
        assertQrlNetwork(async (method) =>
          method === "qrl_chainId" ? QRL_LEG.chainIdHex : genesis,
        ),
      ).rejects.toThrow(/genesis/);
    }
  });

  it("uses full-width indexed log topics and recognizes the deployed event", async () => {
    const signature = htlcInterface.getEvent("Locked")!.topicHash;
    const fetchMock = networkFetch([
      { topics: [qrvm64Topic(signature), qrvm64Topic(hash)], transactionHash: hash },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    expect(await getSwapEvents("qrl", hash)).toEqual([{ kind: "locked", txHash: hash }]);
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body as string).params[0].topics).toEqual([
      null,
      qrvm64Topic(hash),
    ]);
  });
});
