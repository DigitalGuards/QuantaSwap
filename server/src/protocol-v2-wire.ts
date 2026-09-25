import { protocolV2Config } from "./protocol-v2-config.js";
// Portable V2 uses canonical UTF-8 JSON bytes, not a typed-data wallet RPC.
// Keep this file byte-identical across browser, server and market maker.
export type WireField = { readonly name: string; readonly type: string };
export interface ProtocolV2Payload {
  types: Record<string, readonly WireField[]>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}

export const ORDER_V2_DOMAIN = {
  name: "QuantaSwap",
  version: "2",
  ethChainId: protocolV2Config.ethChainId,
  ethHtlc:
    protocolV2Config.ethHtlc === ""
      ? ""
      : `eip155:${protocolV2Config.ethChainId}:${protocolV2Config.ethHtlc.toLowerCase()}`,
  qrlChainId: protocolV2Config.qrlChainId,
  qrlGenesisHash: protocolV2Config.qrlGenesisHash,
  // Set only after the fresh v3 contract has been independently qualified.
  qrlHtlc:
    protocolV2Config.qrlHtlc === ""
      ? ""
      : `Q${protocolV2Config.qrlHtlc.slice(1).toLowerCase()}`,
} as const;

export const ORDER_V2_DEPLOYMENT = {
  ethChainId: ORDER_V2_DOMAIN.ethChainId,
  ethHtlc: ORDER_V2_DOMAIN.ethHtlc,
  qrlChainId: ORDER_V2_DOMAIN.qrlChainId,
  qrlHtlc: ORDER_V2_DOMAIN.qrlHtlc,
};

export const PROTOCOL_V2_FIELDS: Record<string, readonly WireField[]> = {
  OrderV2: [
    { name: "direction", type: "string" },
    { name: "asset", type: "string" },
    { name: "fromAmount", type: "uint256" },
    { name: "toAmount", type: "uint256" },
    { name: "makerEthAccount", type: "string" },
    { name: "makerQrlAccount", type: "string" },
    { name: "visibility", type: "string" },
    { name: "allowedTakerEth", type: "string" },
    { name: "allowedTakerQrl", type: "string" },
    { name: "prelocked", type: "bool" },
    { name: "hashlock", type: "bytes32" },
    { name: "initiatorTimeout", type: "uint64" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "bytes32" },
    { name: "makerTokenCommitment", type: "bytes32" },
    { name: "shareTokenCommitment", type: "bytes32" },
    { name: "ethChainId", type: "uint256" },
    { name: "ethHtlc", type: "string" },
    { name: "qrlChainId", type: "uint256" },
    { name: "qrlHtlc", type: "string" },
  ],
  FillIntentV2: [
    { name: "orderDigest", type: "bytes32" },
    { name: "requestNonce", type: "bytes32" },
    { name: "takerEthAccount", type: "string" },
    { name: "takerQrlAccount", type: "string" },
    { name: "releaseCommitment", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "ethChainId", type: "uint256" },
    { name: "ethHtlc", type: "string" },
    { name: "qrlChainId", type: "uint256" },
    { name: "qrlHtlc", type: "string" },
  ],
  FillV2: [
    { name: "orderDigest", type: "bytes32" },
    { name: "orderNonce", type: "bytes32" },
    { name: "intentDigest", type: "bytes32" },
    { name: "fillNonce", type: "bytes32" },
    { name: "takerEthAccount", type: "string" },
    { name: "takerQrlAccount", type: "string" },
    { name: "releaseCommitment", type: "bytes32" },
    { name: "hashlock", type: "bytes32" },
    { name: "initiatorTimeout", type: "uint64" },
    { name: "responderTimeout", type: "uint64" },
    { name: "issuedAt", type: "uint64" },
    { name: "respondBy", type: "uint64" },
    { name: "ethChainId", type: "uint256" },
    { name: "ethHtlc", type: "string" },
    { name: "qrlChainId", type: "uint256" },
    { name: "qrlHtlc", type: "string" },
  ],
  CancelV2: [
    { name: "orderDigest", type: "bytes32" },
    { name: "orderNonce", type: "bytes32" },
    { name: "cancelNonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "reasonCode", type: "uint8" },
    { name: "ethChainId", type: "uint256" },
    { name: "ethHtlc", type: "string" },
    { name: "qrlChainId", type: "uint256" },
    { name: "qrlHtlc", type: "string" },
  ],
};

const DOMAIN_KEYS = [
  "name",
  "version",
  "ethChainId",
  "ethHtlc",
  "qrlChainId",
  "qrlGenesisHash",
  "qrlHtlc",
] as const;
const UINT_RE = /^(?:0|[1-9][0-9]*)$/;
const MESSAGE_PREFIX = "QuantaSwap Protocol V2\0";

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    throw new Error("Protocol V2 contains missing or unsupported fields");
  }
}

export function assertV2Deployment(): void {
  if (
    !/^eip155:11155111:0x[0-9a-f]{40}$/.test(ORDER_V2_DOMAIN.ethHtlc) ||
    /^eip155:11155111:0x0{40}$/.test(ORDER_V2_DOMAIN.ethHtlc) ||
    !/^Q[0-9a-f]{128}$/.test(ORDER_V2_DOMAIN.qrlHtlc) ||
    /^Q0+$/.test(ORDER_V2_DOMAIN.qrlHtlc)
  ) {
    throw new Error("Portable V2 requires a qualified v3 HTLC deployment");
  }
}

export function protocolMessageBytes(payload: ProtocolV2Payload): Uint8Array {
  const fields = PROTOCOL_V2_FIELDS[payload.primaryType];
  if (!fields) throw new Error("Unsupported portable V2 primary type");
  exactKeys(payload.domain, DOMAIN_KEYS);
  exactKeys(
    payload.message,
    fields.map((field) => field.name),
  );
  exactKeys(payload.types, [payload.primaryType]);
  if (
    JSON.stringify(payload.types[payload.primaryType]) !==
    JSON.stringify(fields)
  ) {
    throw new Error("Portable V2 field schema mismatch");
  }
  const domain = DOMAIN_KEYS.map((key) => {
    const value = payload.domain[key];
    if (typeof value !== "string" || value !== ORDER_V2_DOMAIN[key]) {
      throw new Error("Portable V2 deployment domain mismatch");
    }
    return [key, value];
  });
  const values = fields.map((field) => {
    let value = payload.message[field.name];
    if (field.type.startsWith("uint")) {
      if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0))
          throw new Error("Invalid portable V2 integer");
        value = String(value);
      }
      if (
        typeof value !== "string" ||
        !UINT_RE.test(value) ||
        BigInt(value) >= 1n << BigInt(field.type.slice(4))
      )
        throw new Error("Invalid portable V2 unsigned integer");
    } else if (field.type === "bool") {
      if (typeof value !== "boolean")
        throw new Error("Invalid portable V2 boolean");
    } else if (field.type === "bytes32") {
      if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value))
        throw new Error("Invalid portable V2 bytes32");
    } else if (typeof value !== "string" || !/^[\x20-\x7e]*$/.test(value)) {
      throw new Error("Invalid portable V2 ASCII string");
    }
    return [field.name, value];
  });
  return new TextEncoder().encode(
    MESSAGE_PREFIX + JSON.stringify(["2", payload.primaryType, domain, values]),
  );
}
