import { describe, expect, it } from "vitest";
import { errorMessage, isUserRejection } from "./errorMessage";

// The exact shape ethers v6 throws when MetaMask returns a 4001 user
// rejection (as seen in the wild): an Error whose `message` embeds the
// whole request payload, plus a `code` and nested `info.error.code`.
const ethersRejection = Object.assign(
  new Error(
    'user rejected action (action="sendTransaction", reason="rejected", ' +
      'info={ "error": { "code": 4001, "message": "ethers-user-denied: MetaMask Tx Signature: ' +
      'User denied transaction signature." }, "payload": { "method": "eth_sendTransaction", ' +
      '"params": [ { "data": "0x0ee5265c...6a5749a9", "from": "0x035f07...", "to": "0x910d5d4a...", ' +
      '"value": "0x8e1bc9bf040000" } ] } }, code=ACTION_REJECTED, version=6.17.0)',
  ),
  { code: "ACTION_REJECTED", info: { error: { code: 4001 } } },
);

describe("isUserRejection", () => {
  it("recognizes ethers ACTION_REJECTED and EIP-1193 4001", () => {
    expect(isUserRejection(ethersRejection)).toBe(true);
    expect(isUserRejection({ code: 4001 })).toBe(true);
    expect(isUserRejection({ info: { error: { code: 4001 } } })).toBe(true);
    expect(isUserRejection({ cause: { code: 4001 } })).toBe(true);
  });

  it("does not fire on real failures", () => {
    expect(isUserRejection(new Error("insufficient funds for gas"))).toBe(false);
    expect(isUserRejection({ code: -32000, message: "execution reverted" })).toBe(false);
    expect(isUserRejection("boom")).toBe(false);
    expect(isUserRejection(null)).toBe(false);
  });
});

describe("errorMessage", () => {
  it("collapses a wallet rejection to one friendly line, never the payload", () => {
    const msg = errorMessage(ethersRejection);
    expect(msg).toBe("Transaction rejected in your wallet.");
    expect(msg).not.toContain("0x");
    expect(msg).not.toContain("payload");
  });

  it("catches message-only declines from relays/extensions", () => {
    expect(errorMessage(new Error("User denied transaction signature"))).toBe(
      "Transaction rejected in your wallet.",
    );
    expect(errorMessage({ message: "user rejected the request" })).toBe(
      "Transaction rejected in your wallet.",
    );
  });

  it("prefers a nested provider data.message and a short ethers message", () => {
    expect(errorMessage({ data: { message: "nonce too low" }, message: "big blob" })).toBe(
      "nonce too low",
    );
    expect(
      errorMessage(Object.assign(new Error("verbose…"), { shortMessage: "insufficient funds" })),
    ).toBe("insufficient funds");
  });

  it("clips an overlong message instead of dumping it", () => {
    const out = errorMessage(new Error("x".repeat(500)));
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("…")).toBe(true);
  });

  it("still handles plain-object and non-object throws", () => {
    expect(errorMessage({ message: "plain provider error" })).toBe("plain provider error");
    expect(errorMessage("string error")).toBe("string error");
  });
});
