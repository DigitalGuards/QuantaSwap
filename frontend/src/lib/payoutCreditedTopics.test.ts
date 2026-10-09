// The QRL-leg PayoutCredited filter, pinned against a real log.
//
// Fixture: HTLCv3 on the private QRL v3 devnet (chain 3151909), transaction
// 0x3791b66310c199f9807e12b5c8a0794e57b3df4f4e87dae95305d1e86dcab6a3. Every
// topic on QRVM-512 is a 64-byte word, which is what makes this worth pinning:
// a 32-byte value sits in the high half with 32 zero bytes after it, while a
// 64-byte address fills the word. Left-padding an address the way the Ethereum
// codec does, or forgetting to lowercase a checksummed Q address, silently
// matches nothing, and a filter that matches nothing reads as a delivered
// payout.

import { describe, expect, it } from "vitest";
import { Interface } from "ethers";
import { HTLC_ABI, QRL_NATIVE_TOKEN, creditFilterTopics, decodeCreditedAmount } from "./htlc";

/** The account credited in that swap, as the chain reports it. */
const ACCOUNT_HEX =
  "64f616d40a895750df633414e9dafad5426444fcd5acec79e01640a1278648c8" +
  "b949633f721a2503dc54c51026f3ea08e5123faa5b2e458d412c3dc822af900f";
const HASHLOCK = "0xcf36ed676a65c67d7a9cb2bdb006cdf1fc116bb305ca283f538256ba4ca3e1b9";
const AMOUNT = 11_000n;

/** The four topics that log actually carries. */
const OBSERVED = {
  topic0: "0xf2697db9906dec024a78bb07c851ec99b2ff405724ae7ed468537578f6030109" + "0".repeat(64),
  token: `0x${"0".repeat(128)}`,
  account: `0x${ACCOUNT_HEX}`,
  hashlock: `0x${HASHLOCK.slice(2)}${"0".repeat(64)}`,
};

describe("PayoutCredited filter on the QRL leg", () => {
  it("matches the topics of a real devnet log", () => {
    // The Q address as a wallet shows it, mixed case from the QIP-55
    // checksum. The filter has to lowercase it, because a topic is compared
    // byte for byte.
    const checksummed = `Q${ACCOUNT_HEX.toUpperCase()}`;
    const topics = creditFilterTopics("qrl", QRL_NATIVE_TOKEN, checksummed, HASHLOCK);
    expect(topics).toEqual([OBSERVED.topic0, OBSERVED.token, OBSERVED.account, OBSERVED.hashlock]);
    for (const topic of topics) expect(topic).toHaveLength(2 + 128);
    expect(topics.join("")).toBe(topics.join("").toLowerCase());
  });

  it("pins the event signature the topic is derived from", () => {
    // A change to the event's parameter list moves topic0 and silently
    // matches nothing, so the signature hash is pinned to the deployment.
    const frag = new Interface(HTLC_ABI).getEvent("PayoutCredited");
    expect(frag?.topicHash).toBe(
      "0xf2697db9906dec024a78bb07c851ec99b2ff405724ae7ed468537578f6030109",
    );
    expect(frag?.format("sighash")).toBe("PayoutCredited(address,address,bytes32,uint256)");
  });

  it("puts a 32-byte value in the high half and fills a word with an address", () => {
    const topics = creditFilterTopics("qrl", QRL_NATIVE_TOKEN, `Q${ACCOUNT_HEX}`, HASHLOCK);
    // The hashlock keeps its 32 trailing zero bytes.
    expect(topics[3]?.slice(-64)).toBe("0".repeat(64));
    expect(topics[3]?.slice(2, 66)).toBe(HASHLOCK.slice(2));
    // The address occupies the whole word, with nothing padded in front.
    expect(topics[2]?.slice(2)).toBe(ACCOUNT_HEX);
    expect(topics[2]?.startsWith(`0x${"0".repeat(24)}`)).toBe(false);
  });

  it("decodes the amount from one 64-byte data word", () => {
    const data = `0x${AMOUNT.toString(16).padStart(128, "0")}`;
    expect(decodeCreditedAmount("qrl", data)).toBe(AMOUNT);
    // An Ethereum-width word on the QRL leg is a malformed answer.
    expect(decodeCreditedAmount("qrl", `0x${AMOUNT.toString(16).padStart(64, "0")}`)).toBeNull();
  });

  it("uses Ethereum widths on the Ethereum leg", () => {
    const ethTopics = creditFilterTopics(
      "eth",
      `0x${"0".repeat(40)}`,
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      HASHLOCK,
    );
    for (const topic of ethTopics) expect(topic).toHaveLength(2 + 64);
    expect(ethTopics[3]).toBe(HASHLOCK);
    expect(ethTopics[2]).toBe(`0x${"0".repeat(24)}${"a".repeat(40)}`);
    expect(decodeCreditedAmount("eth", `0x${AMOUNT.toString(16).padStart(64, "0")}`)).toBe(AMOUNT);
  });
});
