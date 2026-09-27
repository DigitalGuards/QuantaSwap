import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { clientSourceKey, resolveClientIp } from "./client-ip.js";

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
    // An IPv6 client is keyed by its /64, so one assignment is one source.
    assert.equal(
      resolveClientIp("127.0.0.1", { "cf-connecting-ip": "2001:db8::1" }, "loopback"),
      "2001:db8:0:0::/64",
    );
  });

  it("requires an explicit all mode for a container-network proxy", () => {
    assert.equal(
      resolveClientIp("172.18.0.1", { "x-forwarded-for": "203.0.113.9" }, "all"),
      "203.0.113.9",
    );
  });

  it("keys IPv6 sources by their /64 and leaves IPv4 alone", () => {
    assert.equal(clientSourceKey("203.0.113.9"), "203.0.113.9");
    assert.equal(clientSourceKey("unknown"), "unknown");
    // Case, zero compression and the trailing dotted-quad form all reduce to
    // the same key, so one holder cannot spell its way into several budgets.
    assert.equal(clientSourceKey("2001:db8::1"), "2001:db8:0:0::/64");
    assert.equal(clientSourceKey("2001:0DB8:0:0:1:2:3:4"), "2001:db8:0:0::/64");
    assert.equal(clientSourceKey("2001:db8::1.2.3.4"), "2001:db8:0:0::/64");
    assert.equal(
      clientSourceKey("2001:db8:1:2:3:4:5:6"),
      "2001:db8:1:2::/64",
    );
    // Addresses in different /64s stay different sources.
    assert.notEqual(
      clientSourceKey("2001:db8:1::5"),
      clientSourceKey("2001:db8:2::5"),
    );
    assert.equal(clientSourceKey("::1"), "0:0:0:0::/64");
    // An IPv4-mapped literal is an IPv4 source, not one more address in ::/64,
    // which is where every one of them would otherwise be counted together.
    assert.equal(clientSourceKey("::ffff:203.0.113.5"), "203.0.113.5");
    assert.notEqual(
      clientSourceKey("::ffff:203.0.113.5"),
      clientSourceKey("::ffff:198.51.100.5"),
    );
  });

  it("reduces an IPv4-mapped address to its IPv4 source", () => {
    assert.equal(
      resolveClientIp("::ffff:203.0.113.9", {}, "none"),
      "203.0.113.9",
    );
    assert.equal(
      resolveClientIp("2001:db8:aa:bb:cc::9", {}, "none"),
      "2001:db8:aa:bb::/64",
    );
  });

  it("rejects malformed forwarded addresses", () => {
    assert.equal(
      resolveClientIp("127.0.0.1", { "x-forwarded-for": "not-an-ip" }, "loopback"),
      "127.0.0.1",
    );
  });
});
