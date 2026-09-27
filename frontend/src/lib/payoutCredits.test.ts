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
import {
  creditAction,
  creditCandidates,
  creditKey,
  creditViews,
} from "./payoutCredits";
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
  it("watches both payees of both legs, whichever role this is", () => {
    // The maker is the ETH-leg initiator (refund payee) and the QRL-leg
    // recipient (claim payee); the taker is the mirror. A maker that
    // sponsors the taker's claim has to see the taker's credit to push it.
    const maker = creditCandidates(machineFor("maker"));
    expect(
      maker.map((candidate) => [candidate.leg, candidate.account, candidate.own]),
    ).toEqual([
      ["eth", TAKER_ETH, false],
      ["eth", MAKER_ETH, true],
      ["qrl", MAKER_QRL, true],
    ]);
    const taker = creditCandidates(machineFor("taker"));
    expect(
      taker.map((candidate) => [candidate.leg, candidate.account, candidate.own]),
    ).toEqual([
      ["eth", TAKER_ETH, true],
      ["qrl", MAKER_QRL, false],
      ["qrl", TAKER_QRL, true],
    ]);
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

  it("shows only the payees that actually hold a credit", () => {
    const amounts = new Map([
      [creditKey("eth", NATIVE_TOKEN, TAKER_ETH), ETH_AMOUNT],
      [creditKey("qrl", QRL_NATIVE_TOKEN, MAKER_QRL), 0n],
    ]);
    const views = creditViews(candidates, amounts);
    expect(views).toHaveLength(1);
    expect(views[0]?.display).toBe("1.0 ETH");
    expect(creditAction(views[0]!)).toBe("withdraw");
  });

  it("offers only a push for a counterparty credit", () => {
    const amounts = new Map([[creditKey("qrl", QRL_NATIVE_TOKEN, MAKER_QRL), QRL_AMOUNT]]);
    const views = creditViews(candidates, amounts);
    expect(views).toHaveLength(1);
    expect(views[0]?.own).toBe(false);
    expect(creditAction(views[0]!)).toBe("push");
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
});
