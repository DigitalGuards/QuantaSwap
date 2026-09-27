// Guards against the QRVM-512 wide-key defect, asserted over compiled ABIs.
//
// Legacy QRVM-512 codegen truncates a wide key in a compiler-generated mapping
// getter, so no contract that ships to the QRL target may expose one. A source
// regex for `mapping(address ...) public` cannot carry that: it misses a nested
// mapping whose inner key is the address, a public struct or array that holds
// addresses, and anything spelled across lines. The compiled ABI is the actual
// external surface, so the guard pins it.
//
// Every function whose signature mentions an address is listed per contract.
// Adding a public state variable keyed by, or holding, an address adds an ABI
// entry and fails this check with the new signature named, which is the point.

const EXPECTED_ADDRESS_SURFACE = {
  // contracts/hyperion (both targets)
  HTLC: [
    "assign(bytes32,address)",
    "getSwap(bytes32)",
    "lockNative(bytes32,address,uint256)",
    "lockToken(bytes32,address,address,uint256,uint256)",
    "lockTokenOpen(bytes32,address,uint256,uint256)",
  ],
  HTLCv3: [
    "assign(bytes32,address)",
    "creditOf(address,address)",
    "getSwap(bytes32)",
    "lockNative(bytes32,address,uint256)",
    "lockToken(bytes32,address,address,uint256,uint256)",
    "lockTokenOpen(bytes32,address,uint256,uint256)",
    "outstandingCredit(address)",
    "pushCredit(address,address)",
    "selfDeliver(address,address,uint256)",
    "withdraw(address,address,uint256)",
    "withdrawAll(address,address)",
  ],
  // contracts/testnet
  TestStable: [
    "allowance(address,address)",
    "approve(address,uint256)",
    "balanceOf(address)",
    "transfer(address,uint256)",
    "transferFrom(address,address,uint256)",
  ],
  // contracts/test: the shared token shape, plus each mock's own knobs
  MockERC20: [
    "allowance(address,address)",
    "approve(address,uint256)",
    "balanceOf(address)",
    "mint(address,uint256)",
    "seedAllowance(address,address,uint256)",
    "transfer(address,uint256)",
    "transferFrom(address,address,uint256)",
  ],
  NoReturnToken: [
    "allowance(address,address)",
    "approve(address,uint256)",
    "balanceOf(address)",
    "mint(address,uint256)",
    "transfer(address,uint256)",
    "transferFrom(address,address,uint256)",
  ],
  FalseToken: [
    "approve(address,uint256)",
    "balanceOf(address)",
    "transfer(address,uint256)",
    "transferFrom(address,address,uint256)",
  ],
  ApprovalRaceToken: [
    "allowance(address,address)",
    "approve(address,uint256)",
    "balanceOf(address)",
    "mint(address,uint256)",
    "transfer(address,uint256)",
    "transferFrom(address,address,uint256)",
  ],
  BlocklistToken: [
    "allowance(address,address)",
    "approve(address,uint256)",
    "balanceOf(address)",
    "blocked(address)",
    "mint(address,uint256)",
    "setBlocked(address,bool)",
    "transfer(address,uint256)",
    "transferFrom(address,address,uint256)",
  ],
  FeeToken: [
    "allowance(address,address)",
    "approve(address,uint256)",
    "balanceOf(address)",
    "mint(address,uint256)",
    "transfer(address,uint256)",
    "transferFrom(address,address,uint256)",
  ],
  FalseTransferToken: [
    "allowance(address,address)",
    "approve(address,uint256)",
    "balanceOf(address)",
    "mint(address,uint256)",
    "transfer(address,uint256)",
    "transferFrom(address,address,uint256)",
  ],
  RevertingTransferToken: [
    "allowance(address,address)",
    "approve(address,uint256)",
    "balanceOf(address)",
    "mint(address,uint256)",
    "transfer(address,uint256)",
    "transferFrom(address,address,uint256)",
  ],
  ReturnBombToken: [
    "allowance(address,address)",
    "approve(address,uint256)",
    "balanceOf(address)",
    "mint(address,uint256)",
    "transfer(address,uint256)",
    "transferFrom(address,address,uint256)",
  ],
  SilentSuccessToken: [
    "allowance(address,address)",
    "approve(address,uint256)",
    "balanceOf(address)",
    "mint(address,uint256)",
    "transfer(address,uint256)",
    "transferFrom(address,address,uint256)",
  ],
  SilentNoReturnToken: [
    "allowance(address,address)",
    "approve(address,uint256)",
    "balanceOf(address)",
    "mint(address,uint256)",
    "transfer(address,uint256)",
    "transferFrom(address,address,uint256)",
  ],
  LyingBalanceToken: [
    "allowance(address,address)",
    "approve(address,uint256)",
    "balanceOf(address)",
    "transfer(address,uint256)",
    "transferFrom(address,address,uint256)",
  ],
  RevertBombBalanceToken: [
    "allowance(address,address)",
    "approve(address,uint256)",
    "balanceOf(address)",
    "mint(address,uint256)",
    "transfer(address,uint256)",
    "transferFrom(address,address,uint256)",
  ],
  GasBurnToken: [
    "allowance(address,address)",
    "approve(address,uint256)",
    "balanceOf(address)",
    "mint(address,uint256)",
    "transfer(address,uint256)",
    "transferFrom(address,address,uint256)",
  ],
  NonPayableRecipient: [
    "pull(address,address,address,uint256)",
    "pullAll(address,address,address)",
  ],
  GasGuzzlerRecipient: ["pull(address,address,address,uint256)"],
  ReentrantRecipient: [
    "configure(address,uint8,bool,bytes32,bytes32,address)",
    "pull(address,address,uint256)",
  ],
};

function signatureOf(entry) {
  return `${entry.name}(${entry.inputs.map((input) => input.type).join(",")})`;
}

function mentionsAddress(entry) {
  const parts = [...entry.inputs, ...(entry.outputs || [])];
  const scan = (list) =>
    list.some(
      (item) =>
        item.type.startsWith("address") ||
        item.type.includes("address") ||
        (item.components ? scan(item.components) : false)
    );
  return scan(parts);
}

// Returns the sorted signatures of every function whose inputs or outputs
// mention an address, anywhere including inside a struct.
function addressSurface(abi) {
  return abi
    .filter((entry) => entry.type === "function" && mentionsAddress(entry))
    .map(signatureOf)
    .sort();
}

// Throws unless `abi`'s address-touching function surface is exactly the pinned
// list for `contractName`.
function assertAddressSurface(contractName, abi) {
  const expected = Object.hasOwn(EXPECTED_ADDRESS_SURFACE, contractName)
    ? EXPECTED_ADDRESS_SURFACE[contractName]
    : undefined;
  const actual = addressSurface(abi);
  if (!expected) {
    throw new Error(
      `${contractName} has no pinned address surface; add it to scripts/abi-guards.js ` +
        `(found: ${actual.join(", ") || "none"})`
    );
  }
  const added = actual.filter((sig) => !expected.includes(sig));
  const removed = expected.filter((sig) => !actual.includes(sig));
  if (added.length > 0 || removed.length > 0) {
    throw new Error(
      `${contractName} address surface changed; a compiler-generated getter over a wide key ` +
        `would truncate it on QRVM-512. added: [${added.join(", ")}] removed: [${removed.join(", ")}]`
    );
  }
}

module.exports = { EXPECTED_ADDRESS_SURFACE, addressSurface, assertAddressSurface, signatureOf };
