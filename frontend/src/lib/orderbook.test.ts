// The share-link fragment is the only place a private order's capability
// secret travels; a parser that accepted junk (or a builder that drifted
// from the parser) would brick every share link silently.

import { describe, expect, it } from "vitest";
import { parseShareToken, shareFragment } from "./orderbook";

describe("share-link fragment", () => {
  const TOKEN = "ab".repeat(32);

  it("round-trips a 32-byte hex token", () => {
    expect(parseShareToken(shareFragment(TOKEN))).toBe(TOKEN);
  });

  it("rejects malformed fragments", () => {
    expect(parseShareToken("")).toBeNull();
    expect(parseShareToken("#k=")).toBeNull();
    expect(parseShareToken(`#k=${"zz".repeat(32)}`)).toBeNull();
    expect(parseShareToken(`#k=${"ab".repeat(31)}`)).toBeNull();
    expect(parseShareToken(`#key=${TOKEN}`)).toBeNull();
    expect(parseShareToken(`#k=${TOKEN}x`)).toBeNull();
  });

  it("rejects uppercase hex (tokens are minted lowercase)", () => {
    expect(parseShareToken(`#k=${"AB".repeat(32)}`)).toBeNull();
  });
});
