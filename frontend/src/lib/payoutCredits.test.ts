// HTLCv3 payout credits: which payees the browser watches, which exit each
// credit gets, and the reads and calldata behind them. A Claimed leg no
// longer implies the recipient holds the funds, so a miss here shows a swap
// as paid while the amount is still sitting in the contract.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeParameters } from "@theqrl/web3-qrl-abi";
import { QRL_LEG } from "../config";
import {
  DELIVERY_GAS_LIMIT,
  DELIVERY_GAS_RESERVE,
  NATIVE_TOKEN,
  QRL_NATIVE_TOKEN,
  SETTLEMENT_GAS_BUFFER,
  assertDeliveryGasPolicy,
  buildPushCreditData,
  buildWithdrawAllData,
  buildWithdrawData,
  getCredit,
  getDeliveryGasPolicy,
  htlcInterface,
  resetDeliveryGasPolicyCache,
  settlementGasLimit,
} from "./htlc";
import { encodeQrvmHtlc } from "./qrvmHtlc";
import { creditCandidates, creditExit, creditKey, creditViews } from "./payoutCredits";
import { deriveSwapMachine, type LegStates } from "./swapMachine";
import type { ActiveSwap } from "./activeSwap";

const MAKER_ETH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TAKER_ETH = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MAKER_QRL = `Q${"c".repeat(128)}`;
const TAKER_QRL = `Q${"d".repeat(128)}`;
const HASHLOCK = `0x${"12".repeat(32)}`;
const NOW = 1_800_000_000;
const ETH_AMOUNT = 10n ** 18n;
const QRL_AMOUNT = 5n * 10n ** 18n;

function machineFor(role: ActiveSwap["role"], legs: LegStates = {}) {
  const machine = deriveSwapMachine({
    swap: {
      role,
      orderId: "order-1",
      takerToken: null,
      direction: "eth->qrl",
      ethAsset: "ETH",
      fromAmount: ETH_AMOUNT.toString(),
      toAmount: QRL_AMOUNT.toString(),
      makerEthAccount: MAKER_ETH,
      makerQrlAccount: MAKER_QRL,
      takerEthAccount: TAKER_ETH,
      takerQrlAccount: TAKER_QRL,
      preimage: null,
      hashlock: HASHLOCK,
      initiatorTimeout: NOW + 7200,
      responderTimeout: NOW + 3600,
      createdAt: NOW - 60,
    },
    legs,
    confirmed: legs,
    nowS: NOW,
  });
  if (machine === null) throw new Error("machine unexpectedly null");
  return machine;
}

describe("credit candidates", () => {
  it("watches every payee a settlement of either leg could credit", () => {
    // Per leg: the recipient a claim pays, and the initiator a refund or a
    // release pays. Missing one of the four would hide a payout that never
    // arrived, and a counterparty credit is what a push finishes.
    const expected = [
      ["eth", TAKER_ETH],
      ["eth", MAKER_ETH],
      ["qrl", MAKER_QRL],
      ["qrl", TAKER_QRL],
    ];
    for (const role of ["maker", "taker"] as const) {
      const candidates = creditCandidates(machineFor(role));
      expect(candidates.map((candidate) => [candidate.leg, candidate.account])).toEqual(expected);
      // `own` marks this browser's own role, whichever side that is.
      expect(candidates.filter((candidate) => candidate.own)).toHaveLength(2);
    }
  });

  it("keys each candidate on the asset that leg escrows", () => {
    // Credits are per token in the contract, so the key has to carry the
    // leg's own asset: the native sentinel here, the registry ERC-20 on a
    // token leg.
    const [ethCandidate, , qrlCandidate] = creditCandidates(machineFor("maker"));
    expect(ethCandidate?.token).toBe(NATIVE_TOKEN);
    expect(ethCandidate?.symbol).toBe("ETH");
    expect(qrlCandidate?.token).toBe(QRL_NATIVE_TOKEN);
    expect(qrlCandidate?.symbol).toBe(QRL_LEG.display);
  });
});

describe("credit views", () => {
  const machine = machineFor("taker");
  const candidates = creditCandidates(machine);
  const reading = (global: bigint, credited: bigint) => ({ global, credited });

  it("shows only the payees this swap actually credited", () => {
    const readings = new Map([
      [creditKey("eth", NATIVE_TOKEN, TAKER_ETH), reading(ETH_AMOUNT, ETH_AMOUNT)],
      [creditKey("qrl", QRL_NATIVE_TOKEN, MAKER_QRL), reading(0n, 0n)],
    ]);
    const views = creditViews(candidates, readings);
    expect(views).toHaveLength(1);
    expect(views[0]?.display).toBe("1.0 ETH");
    expect(views[0]?.otherSwaps).toBe(0n);
    // withdraw reads msg.sender, so the exit depends on the wallet attached
    // to that leg, and never on the address the swap was agreed with.
    expect(creditExit(views[0]!, TAKER_ETH)).toBe("withdraw");
    expect(creditExit(views[0]!, MAKER_ETH)).toBe("push");
    expect(creditExit(views[0]!, null)).toBe("connect");
  });

  it("hides a ledger balance this swap did not credit", () => {
    // creditOf is a per-address ledger shared by every swap that account
    // settled. A balance with no PayoutCredited log for this hashlock
    // belongs to another swap, and this page must not offer to move it.
    const readings = new Map([
      [creditKey("eth", NATIVE_TOKEN, TAKER_ETH), reading(ETH_AMOUNT, 0n)],
    ]);
    expect(creditViews(candidates, readings)).toEqual([]);
  });

  it("reports the rest of the ledger balance separately", () => {
    const readings = new Map([
      [creditKey("eth", NATIVE_TOKEN, TAKER_ETH), reading(ETH_AMOUNT * 3n, ETH_AMOUNT)],
    ]);
    const views = creditViews(candidates, readings);
    expect(views[0]?.amount).toBe(ETH_AMOUNT);
    expect(views[0]?.display).toBe("1.0 ETH");
    expect(views[0]?.otherSwaps).toBe(ETH_AMOUNT * 2n);
    expect(views[0]?.otherSwapsDisplay).toBe("2.0 ETH");
  });

  it("caps this swap's credit at what the ledger still holds", () => {
    // A withdrawal drains the shared ledger without naming a swap, so what
    // remains collectible here is the smaller of the two figures.
    const readings = new Map([
      [creditKey("eth", NATIVE_TOKEN, TAKER_ETH), reading(ETH_AMOUNT / 4n, ETH_AMOUNT)],
    ]);
    const views = creditViews(candidates, readings);
    expect(views[0]?.amount).toBe(ETH_AMOUNT / 4n);
    expect(views[0]?.otherSwaps).toBe(0n);
  });

  it("offers only a push for a counterparty credit", () => {
    const readings = new Map([
      [creditKey("qrl", QRL_NATIVE_TOKEN, MAKER_QRL), reading(QRL_AMOUNT, QRL_AMOUNT)],
    ]);
    const views = creditViews(candidates, readings);
    expect(views).toHaveLength(1);
    expect(views[0]?.own).toBe(false);
    expect(creditExit(views[0]!, TAKER_QRL)).toBe("push");
    expect(views[0]?.display).toBe("5.0 Quanta");
  });

  it("reports nothing while every payout was delivered", () => {
    expect(creditViews(candidates, new Map())).toEqual([]);
  });
});

describe("credit calldata", () => {
  it("encodes withdrawAll, withdraw and pushCredit on both legs", () => {
    expect(buildWithdrawAllData("eth", NATIVE_TOKEN, TAKER_ETH)).toBe(
      htlcInterface.encodeFunctionData("withdrawAll", [NATIVE_TOKEN, TAKER_ETH]),
    );
    expect(buildWithdrawData("eth", NATIVE_TOKEN, TAKER_ETH, 7n)).toBe(
      htlcInterface.encodeFunctionData("withdraw", [NATIVE_TOKEN, TAKER_ETH, 7n]),
    );
    expect(buildPushCreditData("eth", NATIVE_TOKEN, TAKER_ETH)).toBe(
      htlcInterface.encodeFunctionData("pushCredit", [NATIVE_TOKEN, TAKER_ETH]),
    );
    expect(buildWithdrawAllData("qrl", QRL_NATIVE_TOKEN, TAKER_QRL)).toBe(
      encodeQrvmHtlc("withdrawAll", [QRL_NATIVE_TOKEN, TAKER_QRL]),
    );
    expect(buildPushCreditData("qrl", QRL_NATIVE_TOKEN, TAKER_QRL)).toBe(
      encodeQrvmHtlc("pushCredit", [QRL_NATIVE_TOKEN, TAKER_QRL]),
    );
  });

  it("refuses a QRL destination on the Ethereum leg", () => {
    expect(() => buildWithdrawAllData("eth", NATIVE_TOKEN, TAKER_QRL)).toThrow(
      /20-byte Ethereum recipient/,
    );
  });
});

describe("credit and gas-policy reads", () => {
  beforeEach(() => {
    resetDeliveryGasPolicyCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const qrlFetch = (result: unknown) =>
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const { method } = JSON.parse(init.body as string) as { method: string };
      return {
        ok: true,
        json: async () => ({
          result:
            method === "qrl_chainId"
              ? QRL_LEG.chainIdHex
              : method === "qrl_getBlockByNumber"
                ? { number: "0x0", hash: QRL_LEG.genesisHash }
                : result,
        }),
      };
    });

  it("reads a QRL credit as a full-width uint256", async () => {
    const fetchMock = qrlFetch(encodeParameters(["uint256"], [QRL_AMOUNT.toString()]));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getCredit("qrl", QRL_NATIVE_TOKEN, TAKER_QRL)).toBe(QRL_AMOUNT);
    const call = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
    expect(JSON.parse(call.body as string)).toMatchObject({
      method: "qrl_call",
      params: [
        {
          to: QRL_LEG.htlc,
          data: encodeQrvmHtlc("creditOf", [QRL_NATIVE_TOKEN, TAKER_QRL]),
        },
        "latest",
      ],
    });
  });

  it("reads an Ethereum credit through the HTLC interface", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          result: htlcInterface.encodeFunctionResult("creditOf", [ETH_AMOUNT]),
        }),
      })),
    );
    expect(await getCredit("eth", NATIVE_TOKEN, TAKER_ETH)).toBe(ETH_AMOUNT);
  });

  it("reads the delivery gas policy the settlement rule is built from", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          result: htlcInterface.encodeFunctionResult("deliveryGasPolicy", [
            DELIVERY_GAS_LIMIT,
            DELIVERY_GAS_RESERVE,
          ]),
        }),
      })),
    );
    expect(await getDeliveryGasPolicy("eth")).toEqual({
      gasLimit: DELIVERY_GAS_LIMIT,
      gasReserve: DELIVERY_GAS_RESERVE,
    });
    await expect(assertDeliveryGasPolicy("eth")).resolves.toBeUndefined();
    expect(settlementGasLimit(21_000n)).toBe(21_000n + SETTLEMENT_GAS_BUFFER);
    expect(SETTLEMENT_GAS_BUFFER).toBe(250_000n);
  });

  it("fails closed on a contract that publishes a different budget", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          result: htlcInterface.encodeFunctionResult("deliveryGasPolicy", [50_000n, 50_000n]),
        }),
      })),
    );
    await expect(assertDeliveryGasPolicy("eth")).rejects.toThrow(/was not built for/);
  });

  it("treats an unreadable policy as unknown and settles anyway", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })),
    );
    await expect(assertDeliveryGasPolicy("eth")).resolves.toBeUndefined();
  });

  it.each(["eth", "qrl"] as const)("rejects malformed delivery policies on %s", async (leg) => {
    vi.stubGlobal("fetch", qrlFetch("0x01"));
    await expect(assertDeliveryGasPolicy(leg)).rejects.toThrow(/Invalid ABI|64-byte word/);
  });

  it("rejects malformed policy response envelopes", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve<unknown>(null),
      }),
    );
    await expect(assertDeliveryGasPolicy("eth")).rejects.toThrow(/Invalid RPC response/);
  });
});
