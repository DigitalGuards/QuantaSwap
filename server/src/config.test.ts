import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readConfig } from "./config.js";

describe("order-book runtime configuration", () => {
  it("keeps the loopback-safe native defaults", () => {
    const config = readConfig({});
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 8091);
    assert.equal(config.proxyTrust, "loopback");
    assert.equal(config.presenceTtlS, 90);
  });

  it("accepts the explicit container boundary", () => {
    const config = readConfig({
      ORDERBOOK_HOST: "0.0.0.0",
      ORDERBOOK_DATA: "/var/lib/quantaswap-orderbook/orders.json",
      ORDERBOOK_TRUST_PROXY: "none",
      PORT: "9000",
    });
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.port, 9000);
    assert.equal(config.proxyTrust, "none");
  });

  it("fails fast on ambiguous or unsafe values", () => {
    assert.throws(() => readConfig({ PORT: "0" }), /PORT must be between/);
    assert.throws(() => readConfig({ PRESENCE_TTL_S: "NaN" }), /must be an integer/);
    assert.throws(
      () => readConfig({ ORDERBOOK_TRUST_PROXY: "true" }),
      /must be none, loopback, or all/,
    );
    assert.throws(() => readConfig({ ORDERBOOK_DATA: "  " }), /non-empty value/);
  });
});
