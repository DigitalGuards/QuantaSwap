const assert = require("node:assert/strict");
const test = require("node:test");
const { InvalidSeedError, Web3 } = require("@theqrl/web3");
const { normalizeQrlHexseed } = require("./qrl-seed");

// @theqrl/web3 2.0.0 parses a seed only with a lowercase 0x prefix and throws
// InvalidSeedError on the bare hex and on 0X, both of which 1.0.3 signed with.
// The deploy, smoke and measurement scripts read QRL_HEXSEED or a seed file
// as the operator wrote it, so they settle the spelling first.
const body = `010000${"c3".repeat(48)}`;
const canonical = `0x${body}`;

test("hands web3 the 0x spelling of every accepted form", () => {
  const web3 = new Web3();
  assert.throws(() => web3.qrl.accounts.seedToAccount(body), InvalidSeedError);
  const expected = web3.qrl.accounts.seedToAccount(canonical).address;
  for (const spelling of [body, `0X${body}`, ` ${canonical}\n`, canonical]) {
    const seed = normalizeQrlHexseed(spelling);
    assert.equal(seed, canonical);
    assert.equal(web3.qrl.accounts.seedToAccount(seed).address, expected);
  }
  // The hex digits keep their case, which web3 parses as well.
  const upper = normalizeQrlHexseed(body.toUpperCase());
  assert.equal(upper, `0x${body.toUpperCase()}`);
  assert.equal(web3.qrl.accounts.seedToAccount(upper).address, expected);
});

test("leaves any other value for web3 to refuse", () => {
  for (const value of [
    "test-only-unused-seed",
    `0x${body.slice(2)}`,
    `${canonical}00`,
    `0x${"zz".repeat(51)}`,
    `0x0x${body}`,
  ]) {
    assert.equal(normalizeQrlHexseed(value), value);
  }
});
