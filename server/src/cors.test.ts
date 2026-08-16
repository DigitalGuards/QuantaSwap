import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { corsHeaders, preflightHeaders } from "./cors.js";

const ALLOWED = ["https://swap.example"];

describe("order-book CORS policy", () => {
  it("allows public reads without credentials", () => {
    assert.deepEqual(corsHeaders(undefined, "public-read", ALLOWED), {
      "Access-Control-Allow-Origin": "*",
    });
    assert.equal("Access-Control-Allow-Credentials" in corsHeaders(undefined, "public-read", ALLOWED), false);
  });

  it("echoes only an exact configured mutation origin", () => {
    assert.deepEqual(corsHeaders("https://swap.example", "configured-origin", ALLOWED), {
      "Access-Control-Allow-Origin": "https://swap.example",
      Vary: "Origin",
    });
    assert.deepEqual(corsHeaders("https://attacker.example", "configured-origin", ALLOWED), {});
    assert.deepEqual(corsHeaders("https://swap.example.evil", "configured-origin", ALLOWED), {});
  });

  it("accepts only the protocol's explicit preflight methods and headers", () => {
    const headers = preflightHeaders(
      "https://swap.example",
      "POST",
      "Content-Type, X-Share-Token",
      ALLOWED,
    );
    assert.equal(headers?.["Access-Control-Allow-Origin"], "https://swap.example");
    assert.equal(headers?.["Access-Control-Allow-Credentials"], undefined);
    assert.equal(
      preflightHeaders("https://swap.example", "DELETE", "Content-Type", ALLOWED),
      null,
    );
    assert.equal(
      preflightHeaders("https://swap.example", "POST", "Authorization", ALLOWED),
      null,
    );
    assert.equal(
      preflightHeaders("https://attacker.example", "POST", "Content-Type", ALLOWED),
      null,
    );
  });
});
