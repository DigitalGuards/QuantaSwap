const { createHash } = require("node:crypto");

const QIP55_QRL_ADDRESS_RE = /^Q[0-9a-fA-F]{128}$/;
const LEGACY_QRL_ADDRESS_RE = /^Q[0-9a-fA-F]{40}$/;
const QRVM_ZERO_ADDRESS = `0x${"0".repeat(128)}`;

const TOOLING_ERROR =
  "QIP-55 deployment requires a QRL web3 build that derives and encodes 64-byte addresses";
const DEPLOYMENT_ERROR =
  "QIP-55 smoke tests require a freshly deployed uppercase Q-prefixed 64-byte HTLC address with a valid checksum";

// Current Connect checksum semantics for mixed-case QIP-55 input.
function checksummedHex(lowerHex) {
  const hash = createHash("shake256", { outputLength: 64 }).update(lowerHex).digest();
  let result = "";
  for (let index = 0; index < lowerHex.length; index += 1) {
    const char = lowerHex[index] ?? "";
    if (char >= "a" && char <= "f") {
      const byte = hash[index >> 1] ?? 0;
      const nibble = (index & 1) === 0 ? byte >> 4 : byte & 0x0f;
      result += nibble >= 8 ? char.toUpperCase() : char;
    } else {
      result += char;
    }
  }
  return result;
}

function isQip55QrlAddress(value) {
  if (typeof value !== "string" || !QIP55_QRL_ADDRESS_RE.test(value)) return false;
  const body = value.slice(1);
  const lower = body.toLowerCase();
  return body === lower || body === body.toUpperCase() || body === checksummedHex(lower);
}

function assertQip55ToolingAccount(account) {
  if (!isQip55QrlAddress(account)) throw new Error(TOOLING_ERROR);
  return `Q${checksummedHex(account.slice(1).toLowerCase())}`;
}

function assertQip55Deployment(address) {
  if (LEGACY_QRL_ADDRESS_RE.test(address) || !isQip55QrlAddress(address)) {
    throw new Error(DEPLOYMENT_ERROR);
  }
  return `Q${checksummedHex(address.slice(1).toLowerCase())}`;
}

function qrvm64Topic(word) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(word)) {
    throw new Error("QRVM64 topic source must be exactly 32 bytes");
  }
  return `${word.toLowerCase()}${"0".repeat(64)}`;
}

module.exports = {
  DEPLOYMENT_ERROR,
  QRVM_ZERO_ADDRESS,
  TOOLING_ERROR,
  assertQip55Deployment,
  assertQip55ToolingAccount,
  isQip55QrlAddress,
  qrvm64Topic,
};
