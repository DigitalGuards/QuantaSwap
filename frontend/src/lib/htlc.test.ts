// Pins the wire format the frontend produces for the deployed, immutable
// HTLCs: address prefix bridging and exact calldata. A drift here would
// send funds into reverts (best case) on contracts that can never change.

import { describe, expect, it } from "vitest";
import { Interface } from "ethers";
import {
  HTLC_ABI,
  buildClaimData,
  buildLockNativeData,
  buildRefundData,
  hexToQ,
  qToHex,
  shortAddr,
} from "./htlc";

const HASHLOCK = `0x${"12".repeat(32)}`;
const PREIMAGE = `0x${"34".repeat(32)}`;
const RECIPIENT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
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
});

describe("shortAddr", () => {
  it("truncates long addresses and passes short strings through", () => {
    expect(shortAddr(RECIPIENT)).toBe("0xbbbbbb…bbbb");
    expect(shortAddr("Qabc")).toBe("Qabc");
  });
});
