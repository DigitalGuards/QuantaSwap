// The current QRL v2 testnet deployment uses 20-byte Q addresses. Web3 1.x
// intentionally moved account derivation to 64-byte Q addresses, which changes
// the wallet identity for the same extended seed and is rejected by the current
// node. This gate must change only together with the network migration, fresh
// HTLC deployment, drained maker state, and wallet recovery qualification.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { MLDSA87 } from "@theqrl/wallet.js";
import * as qrlweb3 from "@theqrl/web3";

interface QrlAccount {
  address: string;
}

interface Web3Ctor {
  new (): {
    qrl: {
      accounts: { seedToAccount(seed: string): QrlAccount };
    };
  };
}

const ns = qrlweb3 as unknown as { Web3?: Web3Ctor; default?: { Web3?: Web3Ctor } };
const Web3 = ns.Web3 ?? ns.default?.Web3;
if (Web3 === undefined) throw new Error("@theqrl/web3 did not expose Web3");

describe("QRL web3 deployment compatibility", () => {
  it("derives the current 20-byte address identically from the LP extended seed", () => {
    const wallet = MLDSA87.newWallet();
    try {
      const directAddress = wallet.getAddressStr();
      const account = new Web3().qrl.accounts.seedToAccount(wallet.getHexExtendedSeed());
      assert.match(directAddress, /^Q[0-9a-fA-F]{40}$/);
      assert.equal(account.address.toLowerCase(), directAddress.toLowerCase());
    } finally {
      (wallet as typeof wallet & { zeroize(): void }).zeroize();
    }
  });
});
