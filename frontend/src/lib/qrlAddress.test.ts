import { describe, expect, it, vi } from "vitest";
import {
  bindAuthorizedMessageSigner,
  formatQrlAddressFingerprint,
  hexToQ,
  getAuthorizedQrlAccount,
  isHexAddress,
  isQrlAddress,
  requireQrlAccount,
} from "./qrlAddress";

const ACCOUNT = `Q${"12".repeat(64)}`;

describe("authorized message signer binding", () => {
  const authorized = hexToQ(`0x${"ab".repeat(64)}`);
  it("uses the exact authorized checksum for the same full identity", () => {
    const request = {
      method: "qrl_signMessage",
      params: [`Q${authorized.slice(1).toLowerCase()}`, "0x1234"],
    };
    expect(bindAuthorizedMessageSigner(request, authorized)).toEqual({
      method: "qrl_signMessage",
      params: [authorized, "0x1234"],
    });
    expect(request.params[0]).not.toBe(authorized);
  });
  it.each([null, `Q${"cd".repeat(64)}`, `Q${"ab".repeat(20)}`])(
    "rejects missing, different, and legacy account identities",
    (account) => {
      expect(() =>
        bindAuthorizedMessageSigner(
          { method: "qrl_signMessage", params: [authorized, "0x1234"] },
          account,
        ),
      ).toThrow(/authorized QRL account/);
    },
  );
  it("rejects a malformed mixed-case signer instead of repairing it", () => {
    const malformed = authorized.replace(/[a-fA-F]/, (character) =>
      character === character.toLowerCase()
        ? character.toUpperCase()
        : character.toLowerCase(),
    );
    expect(() =>
      bindAuthorizedMessageSigner(
        { method: "qrl_signMessage", params: [malformed, "0x1234"] },
        authorized,
      ),
    ).toThrow(/authorized QRL account/);
  });
  it("leaves other requests unchanged", () => {
    const request = { method: "qrl_chainId" };
    expect(bindAuthorizedMessageSigner(request, null)).toBe(request);
  });
});

describe("hexToQ checksum enforcement", () => {
  const lower = "ab".repeat(64);
  it("accepts uniform-case QRVM aliases", () => {
    expect(hexToQ(`0x${lower}`)).toMatch(/^Q[0-9a-fA-F]{128}$/);
    expect(hexToQ(`0x${lower.toUpperCase()}`)).toMatch(/^Q[0-9a-fA-F]{128}$/);
  });
  it("rejects an invalid-checksum mixed-case QRVM alias instead of laundering it", () => {
    const mixed = `Ab${lower.slice(2)}`;
    const canonicalBody = hexToQ(`0x${lower}`).slice(1);
    if (mixed !== canonicalBody) {
      expect(() => hexToQ(`0x${mixed}`)).toThrow(/checksum/);
    }
  });
  it("round-trips the canonical checksummed form", () => {
    const canonical = hexToQ(`0x${lower}`);
    expect(hexToQ(`0x${canonical.slice(1)}`)).toBe(canonical);
  });
});

describe("QRL wallet account authorization", () => {
  it("uses the authorized cache on reconnect without prompting", async () => {
    const request = vi.fn();
    await expect(
      getAuthorizedQrlAccount({ getAccounts: () => [ACCOUNT], request }),
    ).resolves.toBe(ACCOUNT);
    expect(request).not.toHaveBeenCalled();
  });

  it("requests authorization when a fresh pairing has no cached account", async () => {
    const request = vi.fn().mockResolvedValue([ACCOUNT]);
    await expect(
      getAuthorizedQrlAccount({ getAccounts: () => [], request }),
    ).resolves.toBe(ACCOUNT);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith({ method: "qrl_requestAccounts" });
  });

  it("rejects malformed caches and wallet responses", async () => {
    const request = vi.fn().mockResolvedValue([`Z${"12".repeat(64)}`]);
    await expect(
      getAuthorizedQrlAccount({ getAccounts: () => "corrupt", request }),
    ).rejects.toThrow(/account cache/);
    expect(request).not.toHaveBeenCalled();

    await expect(
      getAuthorizedQrlAccount({ getAccounts: () => [], request }),
    ).rejects.toThrow(/invalid QRL account/);
  });

  it("requires exactly one valid account in a provider response", () => {
    expect(requireQrlAccount([ACCOUNT])).toBe(ACCOUNT);
    expect(() => requireQrlAccount([ACCOUNT, `Q${"34".repeat(64)}`])).toThrow(
      /invalid QRL account/,
    );
    expect(() => requireQrlAccount([ACCOUNT, "Qshort"])).toThrow(/invalid QRL account/);
    expect(() => requireQrlAccount([])).toThrow(/invalid QRL account/);
  });
});

describe("QRL address display fingerprint", () => {
  it.each([
    `Q${"11111111"}${"2".repeat(52)}${"33333333"}${"4".repeat(52)}${"55555555"}`,
    `Q${"11111111"}${"2".repeat(8)}${"33333333"}${"4".repeat(8)}${"55555555"}`,
  ])("shows the first, middle, and final 8 hex characters", (address) => {
    expect(formatQrlAddressFingerprint(address)).toBe("Q11111111...33333333...55555555");
  });

  it("preserves checksum case", () => {
    const address = `QaBcDeF01${"2".repeat(52)}AbCdEf09${"4".repeat(52)}FfEeDdCc`;
    expect(formatQrlAddressFingerprint(address)).toBe("QaBcDeF01...AbCdEf09...FfEeDdCc");
  });

  it.each([
    "",
    "not-an-address",
    "Q1234",
    `q${"1".repeat(128)}`,
    `Q${"1".repeat(127)}`,
    `Q${"1".repeat(129)}`,
  ])(
    "leaves invalid and short values unchanged",
    (address) => {
      expect(formatQrlAddressFingerprint(address)).toBe(address);
    },
  );
});

describe("QIP-55 address predicates", () => {
  it("accepts uppercase Q plus 128 hex while Ethereum remains 20 bytes", () => {
    expect(isQrlAddress(ACCOUNT)).toBe(true);
    expect(isQrlAddress(`Z${ACCOUNT.slice(1)}`)).toBe(false);
    expect(isQrlAddress(`${ACCOUNT}00`)).toBe(false);
    expect(isQrlAddress(`Q${"12".repeat(20)}`)).toBe(false);
    expect(isHexAddress(`0x${"12".repeat(20)}`)).toBe(true);
    expect(isHexAddress(`0x${ACCOUNT.slice(1)}`)).toBe(false);
    expect(isHexAddress(ACCOUNT.slice(1))).toBe(false);
  });
});
