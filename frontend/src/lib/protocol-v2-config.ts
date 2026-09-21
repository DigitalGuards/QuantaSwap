import config from "../../../config/protocol-v2.json";

const keys = [
  "version",
  "networkName",
  "ethChainId",
  "qrlChainId",
  "qrlGenesisHash",
  "ethHtlc",
  "qrlHtlc",
] as const;
if (
  !config ||
  typeof config !== "object" ||
  Array.isArray(config) ||
  Object.keys(config).length !== keys.length ||
  keys.some(
    (key) => typeof (config as Record<string, unknown>)[key] !== "string",
  )
)
  throw new Error("Invalid portable V2 deployment configuration");
export const protocolV2Config = config as Record<(typeof keys)[number], string>;
if (
  protocolV2Config.version !== "2" ||
  protocolV2Config.ethChainId !== "11155111" ||
  protocolV2Config.qrlChainId !== "3151909" ||
  protocolV2Config.qrlGenesisHash !==
    "0xd15407991193e6c23b733dc6bf9c628deaff8f9b6e252aa0d60030952b3e3ea4"
)
  throw new Error("Portable V2 deployment network mismatch");

if (
  (protocolV2Config.ethHtlc !== "" &&
    !/^0x[0-9a-fA-F]{40}$/.test(protocolV2Config.ethHtlc)) ||
  (protocolV2Config.qrlHtlc !== "" &&
    !/^Q[0-9a-fA-F]{128}$/.test(protocolV2Config.qrlHtlc))
)
  throw new Error("Invalid portable V2 HTLC address");
