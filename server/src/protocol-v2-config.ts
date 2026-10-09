import { hasStringFields } from "./guards.js";
import { readFileSync } from "node:fs";
const config: unknown = JSON.parse(
  readFileSync(
    new URL("../../config/protocol-v2.json", import.meta.url),
    "utf8",
  ),
);

const keys = [
  "version",
  "networkName",
  "ethChainId",
  "qrlChainId",
  "qrlGenesisHash",
  "htlcInterface",
  "ethHtlc",
  "qrlHtlc",
] as const;
if (
  !hasStringFields(config, keys) ||
  Object.keys(config).length !== keys.length
) {
  throw new Error("Invalid portable V2 deployment configuration");
}
export const protocolV2Config = config;

/** HTLC contract interface this build is written against. HTLCv3 adds the
 *  payout credit ledger (withdraw, withdrawAll, pushCredit, creditOf,
 *  deliveryGasPolicy), and a failed delivery leaves the amount as a credit
 *  while the claim stands. A client compiled for v3 refuses a v2 profile,
 *  because portable wire V2 signs both HTLC addresses into every order and
 *  the settlement gas rule differs. */
export const HTLC_INTERFACE = "v3";
if (
  protocolV2Config.version !== "2" ||
  protocolV2Config.ethChainId !== "11155111" ||
  protocolV2Config.qrlChainId !== "3151909" ||
  protocolV2Config.qrlGenesisHash !==
    "0xd15407991193e6c23b733dc6bf9c628deaff8f9b6e252aa0d60030952b3e3ea4"
)
  throw new Error("Portable V2 deployment network mismatch");

if (protocolV2Config.htlcInterface !== HTLC_INTERFACE)
  throw new Error(
    `This build settles against HTLC interface ${HTLC_INTERFACE}; the deployment profile declares ${protocolV2Config.htlcInterface}`,
  );

if (
  (protocolV2Config.ethHtlc !== "" &&
    !/^0x[0-9a-fA-F]{40}$/.test(protocolV2Config.ethHtlc)) ||
  (protocolV2Config.qrlHtlc !== "" &&
    !/^Q[0-9a-fA-F]{128}$/.test(protocolV2Config.qrlHtlc))
)
  throw new Error("Invalid portable V2 HTLC address");
