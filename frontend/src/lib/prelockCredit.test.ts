// The credit ledger entry a prelock release leaves behind. Getting the key
// wrong here points the whole recovery path at the wrong balance: the wrong
// token reads zero and retires a record with funds still in the contract, and
// the wrong account offers to move somebody else's money.

import { describe, expect, it } from "vitest";
import { QRL_LEG } from "../config";
import { NATIVE_TOKEN, QRL_NATIVE_TOKEN } from "./htlc";
import { prelockCreditTarget } from "../components/PostOrderCard";

const ETH_ACCOUNT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const QRL_ACCOUNT = `Q${"c".repeat(128)}`;
const HASHLOCK = `0x${"12".repeat(32)}`;

describe("prelockCreditTarget", () => {
  it("keys a native Ethereum escrow on the initiator and the native sentinel", () => {
    // release() pays the initiator, which is this wallet: that is the account
    // a deferred payout is credited to.
    expect(
      prelockCreditTarget({ leg: "eth", hashlock: HASHLOCK }, "ETH", {
        eth: ETH_ACCOUNT,
        qrl: QRL_ACCOUNT,
      }),
    ).toEqual({
      id: `eth:${HASHLOCK}`,
      leg: "eth",
      hashlock: HASHLOCK,
      token: NATIVE_TOKEN,
      account: ETH_ACCOUNT,
      symbol: "ETH",
      decimals: 18,
    });
  });

  it("keys a token escrow on that token, because credits are per asset", () => {
    const target = prelockCreditTarget({ leg: "eth", hashlock: HASHLOCK }, "USDC", {
      eth: ETH_ACCOUNT,
      qrl: QRL_ACCOUNT,
    });
    expect(target?.token).not.toBe(NATIVE_TOKEN);
    expect(target?.symbol).toBe("USDC");
    expect(target?.decimals).toBe(6);
  });

  it("keys a QRL escrow on the native sentinel and the Q address", () => {
    const target = prelockCreditTarget({ leg: "qrl", hashlock: HASHLOCK }, "ETH", {
      eth: ETH_ACCOUNT,
      qrl: QRL_ACCOUNT,
    });
    expect(target?.token).toBe(QRL_NATIVE_TOKEN);
    expect(target?.account).toBe(QRL_ACCOUNT);
    expect(target?.symbol).toBe(QRL_LEG.display);
    expect(target?.decimals).toBe(18);
  });

  it("has no target while the wallet for that leg is absent", () => {
    // Nothing to read a credit for, and nothing that could sign a collection.
    expect(
      prelockCreditTarget({ leg: "qrl", hashlock: HASHLOCK }, "ETH", {
        eth: ETH_ACCOUNT,
        qrl: null,
      }),
    ).toBeNull();
  });
});
