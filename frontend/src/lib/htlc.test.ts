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
  qrvm64Topic,
  shortAddr,
  swapEventKindFromTopic,
} from "./htlc";
import { canonicalQip55QrlAddress } from "./qip55";
import { encodeQrvmHtlc } from "./qrvmHtlc";

const HASHLOCK = `0x${"12".repeat(32)}`;
const PREIMAGE = `0x${"34".repeat(32)}`;
const RECIPIENT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN = "0xcccccccccccccccccccccccccccccccccccccccc";
const AMOUNT = 25_000_000n; // 25 USDC in 6-decimal base units
const TIMEOUT = 1_800_007_200;

describe("address prefix bridging", () => {
  const qAddress = `Q${"ab".repeat(64)}`;
  const qrvmAddress = `0x${"ab".repeat(64)}`;
  const ethAddress = `0x${"ab".repeat(20)}`;

  it("qToHex converts QIP-55 addresses and preserves QRVM and Ethereum hex", () => {
    expect(qToHex(qAddress)).toBe(qrvmAddress);
    expect(qToHex(qrvmAddress)).toBe(qrvmAddress);
    expect(qToHex(ethAddress)).toBe(ethAddress);
  });

  it("hexToQ is the inverse for a 64-byte QRVM address", () => {
    const checksumAddress = canonicalQip55QrlAddress(qAddress);
    expect(hexToQ(qrvmAddress)).toBe(checksumAddress);
    expect(hexToQ(qAddress)).toBe(checksumAddress);
    expect(hexToQ(qToHex(qAddress))).toBe(checksumAddress);
  });

  it.each([
    `Z${"ab".repeat(64)}`,
    "Qabc123",
    "0xabc123",
    `Q${"ab".repeat(20)}`,
    `Q${"ab".repeat(63)}`,
    `Q${"ab".repeat(65)}`,
    `Q${"gg".repeat(64)}`,
  ])("rejects obsolete or malformed address %s", (address) => {
    expect(() => qToHex(address)).toThrow(/address/);
    expect(() => hexToQ(address)).toThrow(/64-byte address/);
  });
});

describe("calldata encoding", () => {
  const iface = new Interface(HTLC_ABI);

  it("routes QIP-55 recipients through the full-width QRVM codec", () => {
    expect(buildLockNativeData("qrl", HASHLOCK, `Q${"bb".repeat(64)}`, TIMEOUT)).toBe(
      encodeQrvmHtlc("lockNative", [HASHLOCK, `Q${"bb".repeat(64)}`, TIMEOUT]),
    );
  });

  it("calldata selectors and layout stay pinned to the deployed ABI", () => {
    // Exact bytes: a change here means the frontend no longer talks to the
    // deployed contracts and must be a conscious, reviewed decision.
    expect(buildLockNativeData("eth", HASHLOCK, RECIPIENT, TIMEOUT)).toBe(
      "0xad4c2381" +
        "12".repeat(32) +
        "000000000000000000000000" +
        "bb".repeat(20) +
        TIMEOUT.toString(16).padStart(64, "0"),
    );
    expect(buildClaimData("eth", HASHLOCK, PREIMAGE)).toBe(
      "0x84cc9dfb" + "12".repeat(32) + "34".repeat(32),
    );
    expect(buildRefundData("eth", HASHLOCK)).toBe("0x7249fbb6" + "12".repeat(32));
  });

  it("keeps Ethereum 20-byte calldata encoding available", () => {
    expect(buildLockNativeData("eth", HASHLOCK, RECIPIENT, TIMEOUT)).toBe(
      iface.encodeFunctionData("lockNative", [HASHLOCK, RECIPIENT, TIMEOUT]),
    );
    expect(buildLockTokenData(HASHLOCK, RECIPIENT, TOKEN, AMOUNT, TIMEOUT)).toBe(
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

describe("QRVM64 event topics", () => {
  it("left-aligns a 32-byte signature or indexed hash in a 64-byte word", () => {
    expect(qrvm64Topic(HASHLOCK)).toBe(`0x${"12".repeat(32)}${"00".repeat(32)}`);
  });

  it("rejects non-32-byte topic sources", () => {
    expect(() => qrvm64Topic(`0x${"12".repeat(64)}`)).toThrow(/exactly 32 bytes/);
  });

  it("matches QRL event signatures only in their exact 64-byte topic form", () => {
    const signature = new Interface(HTLC_ABI).getEvent("Locked")?.topicHash;
    expect(signature).toBeDefined();
    expect(swapEventKindFromTopic("qrl", qrvm64Topic(signature as string))).toBe("locked");
    expect(swapEventKindFromTopic("qrl", signature as string)).toBeUndefined();
    expect(swapEventKindFromTopic("eth", signature as string)).toBe("locked");
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
    expect(
      shortAddr(`Q${"11111111"}${"2".repeat(52)}${"33333333"}${"4".repeat(52)}${"55555555"}`),
    ).toBe("Q11111111...33333333...55555555");
  });
});
