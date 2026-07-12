// Pins the wire format the frontend produces for the deployed, immutable
// HTLCs: address prefix bridging and exact calldata. A drift here would
// send funds into reverts (best case) on contracts that can never change.

import { describe, expect, it } from "vitest";
import { Interface, id } from "ethers";
import {
  HTLC_ABI,
  buildApproveData,
  buildClaimData,
  buildLockNativeData,
  buildLockTokenData,
  buildRefundData,
  confirmedBlock,
  hexToQ,
  qToHex,
  shortAddr,
} from "./htlc";

const HASHLOCK = `0x${"12".repeat(32)}`;
const PREIMAGE = `0x${"34".repeat(32)}`;
const RECIPIENT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN = "0xcccccccccccccccccccccccccccccccccccccccc";
const AMOUNT = 25_000_000n; // 25 USDC in 6-decimal base units
const TIMEOUT = 1_800_007_200;

describe("address prefix bridging", () => {
  it("qToHex strips Q and Z prefixes, passes hex through", () => {
    expect(qToHex("Qabc123")).toBe("0xabc123");
    expect(qToHex("Zabc123")).toBe("0xabc123");
    expect(qToHex("0xabc123")).toBe("0xabc123");
  });

  it("hexToQ is the inverse for hex input", () => {
    expect(hexToQ("0xabc123")).toBe("Qabc123");
    expect(hexToQ("Qabc123")).toBe("Qabc123");
    expect(hexToQ(qToHex("Qabc123"))).toBe("Qabc123");
  });
});

describe("calldata encoding", () => {
  const iface = new Interface(HTLC_ABI);

  it("lockNative accepts Q-prefixed recipients and encodes the hex form", () => {
    const fromQ = buildLockNativeData(HASHLOCK, `Q${RECIPIENT.slice(2)}`, TIMEOUT);
    const fromHex = buildLockNativeData(HASHLOCK, RECIPIENT, TIMEOUT);
    expect(fromQ).toBe(fromHex);
    expect(fromQ).toBe(iface.encodeFunctionData("lockNative", [HASHLOCK, RECIPIENT, TIMEOUT]));
  });

  it("calldata selectors and layout stay pinned to the deployed ABI", () => {
    // Exact bytes: a change here means the frontend no longer talks to the
    // deployed contracts and must be a conscious, reviewed decision.
    expect(buildLockNativeData(HASHLOCK, RECIPIENT, TIMEOUT)).toBe(
      "0xad4c2381" +
        "12".repeat(32) +
        "000000000000000000000000" +
        "bb".repeat(20) +
        TIMEOUT.toString(16).padStart(64, "0"),
    );
    expect(buildClaimData(HASHLOCK, PREIMAGE)).toBe("0x84cc9dfb" + "12".repeat(32) + "34".repeat(32));
    expect(buildRefundData(HASHLOCK)).toBe("0x7249fbb6" + "12".repeat(32));
  });

  it("lockToken accepts Q-prefixed recipients and encodes the hex form", () => {
    const fromQ = buildLockTokenData(HASHLOCK, `Q${RECIPIENT.slice(2)}`, TOKEN, AMOUNT, TIMEOUT);
    const fromHex = buildLockTokenData(HASHLOCK, RECIPIENT, TOKEN, AMOUNT, TIMEOUT);
    expect(fromQ).toBe(fromHex);
    expect(fromQ).toBe(
      iface.encodeFunctionData("lockToken", [HASHLOCK, RECIPIENT, TOKEN, AMOUNT, TIMEOUT]),
    );
  });

  it("lockToken and approve selectors derive from their canonical signatures", () => {
    // The selectors are recomputed from the signatures here so a drifted
    // ABI string in htlc.ts cannot silently change the wire format.
    expect(id("lockToken(bytes32,address,address,uint256,uint256)").slice(0, 10)).toBe("0xecac467d");
    expect(id("approve(address,uint256)").slice(0, 10)).toBe("0x095ea7b3");
    expect(buildLockTokenData(HASHLOCK, RECIPIENT, TOKEN, AMOUNT, TIMEOUT).slice(0, 10)).toBe(
      "0xecac467d",
    );
    expect(buildApproveData(RECIPIENT, AMOUNT).slice(0, 10)).toBe("0x095ea7b3");
  });

  it("lockToken and approve calldata layout stay pinned to the deployed ABI", () => {
    expect(buildLockTokenData(HASHLOCK, RECIPIENT, TOKEN, AMOUNT, TIMEOUT)).toBe(
      "0xecac467d" +
        "12".repeat(32) +
        "000000000000000000000000" +
        "bb".repeat(20) +
        "000000000000000000000000" +
        "cc".repeat(20) +
        AMOUNT.toString(16).padStart(64, "0") +
        TIMEOUT.toString(16).padStart(64, "0"),
    );
    expect(buildApproveData(TOKEN, 0n)).toBe(
      "0x095ea7b3" + "000000000000000000000000" + "cc".repeat(20) + "0".repeat(64),
    );
  });
});

describe("confirmed-snapshot depth arithmetic", () => {
  // Pins what the `confirmations` config values actually mean: the block
  // the irreversible-response gates read counterparty locks at. A silent
  // change here changes the protocol's reorg margin.
  it("confirmations 0 reads the head block itself (zero reorg margin)", () => {
    expect(confirmedBlock(1000, 0)).toBe(1000);
  });

  it("confirmations N reads N blocks behind the head", () => {
    expect(confirmedBlock(1000, 1)).toBe(999);
    expect(confirmedBlock(1000, 3)).toBe(997);
  });

  it("clamps at genesis instead of going negative", () => {
    expect(confirmedBlock(2, 5)).toBe(0);
  });
});

describe("shortAddr", () => {
  it("truncates long addresses and passes short strings through", () => {
    expect(shortAddr(RECIPIENT)).toBe("0xbbbbbb…bbbb");
    expect(shortAddr("Qabc")).toBe("Qabc");
  });
});
