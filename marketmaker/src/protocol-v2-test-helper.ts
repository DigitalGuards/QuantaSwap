import { protocolMessageBytes } from "./protocol-v2-wire.js";
import {
  ML_DSA_87_SIGNATURE_BYTES,
  SCHEME_TAG_MSG,
  computeMessageDigest,
} from "@qrlwallet/connect";
import { cryptoSignSignature } from "@theqrl/mldsa87";
import { ExtendedSeed, MLDSA87 } from "@theqrl/wallet.js";
import { canonicalQip55QrlAddress } from "./qip55.js";
import {
  deriveLegacyV1QrlAddress,
  type OrderSigningScheme,
  type ProtocolAuthV1,
  type ProtocolTypedDataPayload,
} from "./protocol-signing.js";

export const V2_TEST_EXTENDED_SEED = `0x010000${"07".repeat(48)}`;

export interface ProtocolV2Identity {
  descriptor: string;
  publicKey: string;
  legacyAddress: string;
  currentAddress: string;
}

function hex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function withProtocolV2Wallet<T>(
  run: (
    wallet: ReturnType<typeof MLDSA87.newWalletFromExtendedSeed>,
    secretKey: Uint8Array,
  ) => T,
  extendedSeedHex = V2_TEST_EXTENDED_SEED,
): T {
  const extendedSeed = ExtendedSeed.from(extendedSeedHex);
  const wallet = MLDSA87.newWalletFromExtendedSeed(extendedSeed);
  (extendedSeed as typeof extendedSeed & { zeroize(): void }).zeroize();
  const secretKey = wallet.getSK();
  try {
    return run(wallet, secretKey);
  } finally {
    secretKey.fill(0);
    (wallet as typeof wallet & { zeroize(): void }).zeroize();
  }
}

export function protocolV2Identity(
  extendedSeedHex = V2_TEST_EXTENDED_SEED,
): ProtocolV2Identity {
  return withProtocolV2Wallet((wallet) => {
    const descriptor = hex(wallet.getDescriptor().toBytes());
    const publicKey = hex(wallet.getPK());
    return {
      descriptor,
      publicKey,
      legacyAddress: deriveLegacyV1QrlAddress(descriptor, publicKey),
      currentAddress: `Q${canonicalQip55QrlAddress(wallet.getAddressStr()).slice(1).toLowerCase()}`,
    };
  }, extendedSeedHex);
}

export function signProtocolV2Auth(
  payload: ProtocolTypedDataPayload,
  scheme: OrderSigningScheme,
  unsigned: Pick<ProtocolAuthV1, "issuedAt" | "expiresAt" | "nonce">,
  extendedSeedHex = V2_TEST_EXTENDED_SEED,
): ProtocolAuthV1 {
  return withProtocolV2Wallet((wallet, secretKey) => {
    const descriptor = hex(wallet.getDescriptor().toBytes());
    const publicKey = hex(wallet.getPK());
    const signature = new Uint8Array(ML_DSA_87_SIGNATURE_BYTES);
    cryptoSignSignature(
      signature,
      computeMessageDigest(protocolMessageBytes(payload)),
      secretKey,
      false,
      SCHEME_TAG_MSG,
    );
    return {
      version: "2",
      scheme,
      ...unsigned,
      signature: hex(signature),
      publicKey,
      descriptor,
    };
  }, extendedSeedHex);
}
