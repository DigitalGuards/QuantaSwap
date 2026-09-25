// The wallet and web3 account factories must bind one seed to the same
// canonical QIP-55 identity before any network access.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { MLDSA87 } from "@theqrl/wallet.js";
import * as qrlweb3 from "@theqrl/web3";
import { canonicalQip55QrlAddress } from "./qip55.js";

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
  it("derives one canonical Q128 account from wallet.js and web3", () => {
    const wallet = MLDSA87.newWallet();
    try {
      const directAddress = canonicalQip55QrlAddress(wallet.getAddressStr());
      const account = new Web3().qrl.accounts.seedToAccount(wallet.getHexExtendedSeed());
      const web3Address = canonicalQip55QrlAddress(account.address);
      assert.match(directAddress, /^Q[0-9a-fA-F]{128}$/);
      assert.equal(web3Address, directAddress);
    } finally {
      (wallet as typeof wallet & { zeroize(): void }).zeroize();
    }
  });
});
