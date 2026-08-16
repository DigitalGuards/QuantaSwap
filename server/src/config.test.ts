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
    assert.deepEqual(config.federationPeers, []);
    assert.deepEqual(config.corsOrigins, []);
    assert.equal(config.federationDataFile, `${config.dataFile}.federation`);
  });

  it("accepts the explicit container boundary", () => {
    const config = readConfig({
      ORDERBOOK_HOST: "0.0.0.0",
      ORDERBOOK_DATA: "/var/lib/quantaswap-orderbook/orders.json",
      ORDERBOOK_TRUST_PROXY: "none",
      ORDERBOOK_FEDERATION_DATA: "/var/lib/quantaswap-orderbook/federation.json",
      ORDERBOOK_FEDERATION_PEERS: "https://book-a.example/api,http://book-b:8091/api/",
      ORDERBOOK_CORS_ORIGINS: "https://swap.example,http://127.0.0.1:5173",
      PORT: "9000",
    });
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.port, 9000);
    assert.equal(config.proxyTrust, "none");
    assert.equal(config.federationDataFile, "/var/lib/quantaswap-orderbook/federation.json");
    assert.deepEqual(config.federationPeers, [
      "https://book-a.example/api",
      "http://book-b:8091/api",
    ]);
    assert.deepEqual(config.corsOrigins, ["https://swap.example", "http://127.0.0.1:5173"]);
  });

  it("fails fast on ambiguous or unsafe values", () => {
    assert.throws(() => readConfig({ PORT: "0" }), /PORT must be between/);
    assert.throws(() => readConfig({ PRESENCE_TTL_S: "NaN" }), /must be an integer/);
    assert.throws(
      () => readConfig({ ORDERBOOK_TRUST_PROXY: "true" }),
      /must be none, loopback, or all/,
    );
    assert.throws(() => readConfig({ ORDERBOOK_DATA: "  " }), /non-empty value/);
    assert.throws(
      () => readConfig({ ORDERBOOK_FEDERATION_PEERS: "file:///tmp/book" }),
      /plain HTTP\(S\)/,
    );
    assert.throws(
      () => readConfig({ ORDERBOOK_FEDERATION_PEERS: "https://user:pass@example.com/api" }),
      /plain HTTP\(S\)/,
    );
    assert.throws(
      () =>
        readConfig({
          ORDERBOOK_FEDERATION_PEERS:
            "https://book.example/api,https://book.example/api/",
        }),
      /equivalent duplicate URLs/,
    );
    assert.throws(
      () => readConfig({ ORDERBOOK_CORS_ORIGINS: "https://swap.example/path" }),
      /exact HTTP\(S\) origins/,
    );
    assert.throws(
      () => readConfig({ ORDERBOOK_CORS_ORIGINS: "https://a.example,,https://b.example" }),
      /without empty entries/,
    );
  });
});
