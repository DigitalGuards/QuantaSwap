// @vitest-environment jsdom
// A build can be served under a sub-path, which is how the release that
// created a swap record stays reachable after a contract cutover: swap state
// is scoped to the origin and namespaced on both HTLC addresses, so a build of
// the previous release at /v2/ reads exactly the records that deployment
// wrote, and nothing of this one's.
//
// Every absolute link and the router basename have to agree with that path, or
// a share link points at a page that cannot resolve it.

import { describe, expect, it } from "vitest";
import {
  BASE_PATH,
  LEGACY_RELEASE_PATH,
  ROUTER_BASENAME,
  absoluteAppUrl,
  normalizeBasePath,
} from "../config";

describe("base path", () => {
  it("normalises a sub-path to one leading and one trailing slash", () => {
    expect(normalizeBasePath("/v2")).toBe("/v2/");
    expect(normalizeBasePath("/v2/")).toBe("/v2/");
    expect(normalizeBasePath(" /v2/ ")).toBe("/v2/");
    expect(normalizeBasePath("/releases/htlcv2/")).toBe("/releases/htlcv2/");
  });

  it("treats the site root as the default", () => {
    for (const raw of ["/", "", undefined, null, 7]) {
      expect(normalizeBasePath(raw)).toBe("/");
    }
  });

  it("refuses anything that is not a plain absolute path", () => {
    // A relative value, an origin, or a query would silently produce links
    // that resolve somewhere else.
    for (const raw of [
      "v2/",
      "//evil.example/",
      "https://evil.example/v2/",
      "/v2/?x=1",
      "/v2/#k",
      "/../v2/",
      "/v2 /",
    ]) {
      expect(() => normalizeBasePath(raw), raw).toThrow(/absolute path/);
    }
  });

  it("derives the router basename from the base path", () => {
    // react-router wants no trailing slash, and an empty string at the root.
    expect(BASE_PATH).toBe("/");
    expect(ROUTER_BASENAME).toBe("");
  });

  it("builds absolute links inside this build", () => {
    const origin = window.location.origin;
    expect(absoluteAppUrl("o/abc")).toBe(`${origin}/o/abc`);
    expect(absoluteAppUrl("/o/abc")).toBe(`${origin}/o/abc`);
  });

  it("links to no previous release until one is configured", () => {
    // A default of /v2/ would point at a 404 on every deployment that has
    // not put a build there yet, and it would do it to someone looking for
    // locked funds. The operator sets VITE_LEGACY_RELEASE_PATH when the path
    // is actually served.
    expect(LEGACY_RELEASE_PATH).toBe("");
  });
});
