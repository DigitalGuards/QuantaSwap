// QRL extended seed spelling for the operator scripts. The market maker
// applies the same rule in marketmaker/src/config.ts.

/** A 51-byte QRL extended seed in any spelling @theqrl/web3 1.0.3 parsed. */
const QRL_HEXSEED_SPELLING = /^(?:0[xX])?([0-9a-fA-F]{102})$/;

/**
 * Spell a QRL extended seed the one way @theqrl/web3 2.0.0 parses it: with a
 * lowercase 0x prefix. 2.0.0 throws InvalidSeedError on the bare hex and on
 * 0X, both of which 1.0.3 signed with. Surrounding whitespace is dropped and
 * the hex digits keep their case. Any other value comes back unchanged, so
 * web3 refuses it as it did before. The value never enters a message here.
 */
function normalizeQrlHexseed(value) {
  const match = QRL_HEXSEED_SPELLING.exec(String(value).trim());
  return match ? `0x${match[1]}` : value;
}

module.exports = { normalizeQrlHexseed };
