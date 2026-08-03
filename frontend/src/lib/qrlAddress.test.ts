import { describe, expect, it, vi } from "vitest";
import {
  getAuthorizedQrlAccount,
  isHexAddress,
  isQrlAddress,
  requireQrlAccount,
} from "./qrlAddress";

const ACCOUNT = `Q${"12".repeat(20)}`;

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
    const request = vi.fn().mockResolvedValue([`Z${"12".repeat(20)}`]);
    await expect(
      getAuthorizedQrlAccount({ getAccounts: () => "corrupt", request }),
    ).rejects.toThrow(/account cache/);
    expect(request).not.toHaveBeenCalled();

    await expect(
      getAuthorizedQrlAccount({ getAccounts: () => [], request }),
    ).rejects.toThrow(/invalid QRL account/);
  });

  it("validates every account in a provider response", () => {
    expect(requireQrlAccount([ACCOUNT])).toBe(ACCOUNT);
    expect(() => requireQrlAccount([ACCOUNT, "Qshort"])).toThrow(/invalid QRL account/);
    expect(() => requireQrlAccount([])).toThrow(/invalid QRL account/);
  });
});

describe("current address predicates", () => {
  it("accepts only Q plus 40 hex or 0x plus 40 hex", () => {
    expect(isQrlAddress(ACCOUNT)).toBe(true);
    expect(isQrlAddress(`Z${ACCOUNT.slice(1)}`)).toBe(false);
    expect(isQrlAddress(`${ACCOUNT}00`)).toBe(false);
    expect(isHexAddress(`0x${ACCOUNT.slice(1)}`)).toBe(true);
    expect(isHexAddress(ACCOUNT.slice(1))).toBe(false);
  });
});
