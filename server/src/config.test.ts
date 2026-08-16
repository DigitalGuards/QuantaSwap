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
    assert.deepEqual(config.federationPeerIds, []);
    assert.deepEqual(config.federationPeerTokens, []);
    assert.equal(config.federationReadToken, null);
    assert.equal(config.federationAllowInsecurePeerTokens, false);
    assert.deepEqual(config.corsOrigins, []);
    assert.equal(config.federationDataFile, `${config.dataFile}.federation`);
  });

  it("accepts the explicit container boundary", () => {
    const config = readConfig({
      ORDERBOOK_HOST: "0.0.0.0",
      ORDERBOOK_DATA: "/var/lib/quantaswap-orderbook/orders.json",
      ORDERBOOK_TRUST_PROXY: "none",
      ORDERBOOK_FEDERATION_DATA: "/var/lib/quantaswap-orderbook/federation.json",
      ORDERBOOK_FEDERATION_PEERS: "https://book-a.example/api,https://book-b.example/api/",
      ORDERBOOK_FEDERATION_PEER_IDS: "foundation,community-1",
      ORDERBOOK_FEDERATION_PEER_TOKENS: `${"11".repeat(32)},${"22".repeat(32)}`,
      ORDERBOOK_FEDERATION_READ_TOKEN: "33".repeat(32),
      ORDERBOOK_CORS_ORIGINS: "https://swap.example,http://127.0.0.1:5173",
      PORT: "9000",
    });
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.port, 9000);
    assert.equal(config.proxyTrust, "none");
    assert.equal(config.federationDataFile, "/var/lib/quantaswap-orderbook/federation.json");
    assert.deepEqual(config.federationPeers, [
      "https://book-a.example/api",
      "https://book-b.example/api",
    ]);
    assert.deepEqual(config.federationPeerIds, ["foundation", "community-1"]);
    assert.deepEqual(config.federationPeerTokens, ["11".repeat(32), "22".repeat(32)]);
    assert.equal(config.federationReadToken, "33".repeat(32));
    assert.equal(config.federationAllowInsecurePeerTokens, false);
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
      () =>
        readConfig({
          ORDERBOOK_DATA: "./data/orders.json",
          ORDERBOOK_FEDERATION_DATA: "data/../data/orders.json",
        }),
      /must be different files/,
    );
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
      () =>
        readConfig({
          ORDERBOOK_FEDERATION_PEERS: "https://book-a.example/api,https://book-b.example/api",
          ORDERBOOK_FEDERATION_PEER_IDS: "only-one",
        }),
      /one id for every peer/,
    );
    assert.throws(
      () =>
        readConfig({
          ORDERBOOK_FEDERATION_PEERS: "https://book.example/api",
          ORDERBOOK_FEDERATION_PEER_IDS: "Internal Host",
        }),
      /lowercase letters/,
    );
    assert.throws(
      () =>
        readConfig({
          ORDERBOOK_FEDERATION_PEERS: "https://book-a.example/api,https://book-b.example/api",
          ORDERBOOK_FEDERATION_PEER_IDS: "community,community",
        }),
      /contains duplicates/,
    );
    assert.throws(
      () =>
        readConfig({
          ORDERBOOK_FEDERATION_PEERS: "https://book-a.example/api,https://book-b.example/api",
          ORDERBOOK_FEDERATION_PEER_TOKENS: "11".repeat(32),
        }),
      /one token for every peer/,
    );
    assert.throws(
      () => readConfig({ ORDERBOOK_FEDERATION_READ_TOKEN: "secret" }),
      /32 bytes of lowercase hex/,
    );
    assert.throws(
      () =>
        readConfig({
          ORDERBOOK_FEDERATION_PEERS: "http://book.example/api",
          ORDERBOOK_FEDERATION_PEER_TOKENS: "11".repeat(32),
        }),
      /require HTTPS peers/,
    );
    assert.throws(
      () =>
        readConfig({
          ORDERBOOK_FEDERATION_ALLOW_INSECURE_PEER_TOKENS: "1",
        }),
      /must be true or false/,
    );
    assert.throws(
      () =>
        readConfig({
          ORDERBOOK_FEDERATION_PEERS: Array.from(
            { length: 17 },
            (_value, index) => `https://book-${index}.example/api`,
          ).join(","),
        }),
      /more than 16 peers/,
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

  it("allows authenticated HTTP only with the explicit disposable-lab opt-in", () => {
    const config = readConfig({
      ORDERBOOK_FEDERATION_PEERS: "http://book:8091/api",
      ORDERBOOK_FEDERATION_PEER_TOKENS: "11".repeat(32),
      ORDERBOOK_FEDERATION_ALLOW_INSECURE_PEER_TOKENS: "true",
    });
    assert.deepEqual(config.federationPeers, ["http://book:8091/api"]);
    assert.deepEqual(config.federationPeerTokens, ["11".repeat(32)]);
    assert.equal(config.federationAllowInsecurePeerTokens, true);
  });
});
