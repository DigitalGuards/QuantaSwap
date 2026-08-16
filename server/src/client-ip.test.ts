import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { resolveClientIp } from "./client-ip.js";

describe("order-book proxy trust", () => {
  it("ignores spoofable forwarding headers from direct clients", () => {
    assert.equal(
      resolveClientIp("198.51.100.2", { "x-forwarded-for": "203.0.113.9" }, "loopback"),
      "198.51.100.2",
    );
    assert.equal(
      resolveClientIp("198.51.100.2", { "cf-connecting-ip": "203.0.113.8" }, "none"),
      "198.51.100.2",
    );
  });

  it("accepts validated forwarding headers from a loopback proxy", () => {
    assert.equal(
      resolveClientIp(
        "::ffff:127.0.0.1",
        { "x-forwarded-for": "203.0.113.9, 127.0.0.1" },
        "loopback",
      ),
      "203.0.113.9",
    );
    assert.equal(
      resolveClientIp("127.0.0.1", { "cf-connecting-ip": "2001:db8::1" }, "loopback"),
      "2001:db8::1",
    );
  });

  it("requires an explicit all mode for a container-network proxy", () => {
    assert.equal(
      resolveClientIp("172.18.0.1", { "x-forwarded-for": "203.0.113.9" }, "all"),
      "203.0.113.9",
    );
  });

  it("rejects malformed forwarded addresses", () => {
    assert.equal(
      resolveClientIp("127.0.0.1", { "x-forwarded-for": "not-an-ip" }, "loopback"),
      "127.0.0.1",
    );
  });
});
