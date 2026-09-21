import {
  ML_DSA_87_SIGNATURE_BYTES,
  SCHEME_TAG_TYPED,
  computeTypedDataDigest,
} from "@qrlwallet/connect";
import { cryptoSignSignature } from "@theqrl/mldsa87";
import { ExtendedSeed, MLDSA87 } from "@theqrl/wallet.js";
import { canonicalQip55QrlAddress } from "./qip55.js";
import {
  deriveLegacyV1QrlAddress,
  officialQrlDigest,
  type ProtocolTypedDataPayload,
} from "./protocol-signing.js";

export const LEGACY_V1_TEST_EXTENDED_SEED = `0x010000${"07".repeat(48)}`;
export const LEGACY_V1_ZOND_CONTEXT = new TextEncoder().encode("ZOND");

export interface LegacyV1Identity {
  descriptor: string;
  publicKey: string;
  legacyAddress: string;
  currentAddress: string;
}

function hex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function withLegacyV1Wallet<T>(
  run: (
    wallet: ReturnType<typeof MLDSA87.newWalletFromExtendedSeed>,
    secretKey: Uint8Array,
  ) => T,
  extendedSeedHex = LEGACY_V1_TEST_EXTENDED_SEED,
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

export function legacyV1Identity(
  extendedSeedHex = LEGACY_V1_TEST_EXTENDED_SEED,
): LegacyV1Identity {
  return withLegacyV1Wallet((wallet) => {
    const descriptor = hex(wallet.getDescriptor().toBytes());
    const publicKey = hex(wallet.getPK());
    return {
      descriptor,
      publicKey,
      legacyAddress: deriveLegacyV1QrlAddress(descriptor, publicKey),
      currentAddress: canonicalQip55QrlAddress(wallet.getAddressStr()),
    };
  }, extendedSeedHex);
}

export function signLegacyV1Auth(
  payload: ProtocolTypedDataPayload,
  scheme: OrderSigningScheme,
  unsigned: Pick<ProtocolAuthV1, "issuedAt" | "expiresAt" | "nonce">,
  extendedSeedHex = LEGACY_V1_TEST_EXTENDED_SEED,
): ProtocolAuthV1 {
  return withLegacyV1Wallet((wallet, secretKey) => {
    const descriptor = hex(wallet.getDescriptor().toBytes());
    const publicKey = hex(wallet.getPK());
    const signature = new Uint8Array(ML_DSA_87_SIGNATURE_BYTES);
    cryptoSignSignature(
      signature,
      scheme === "qrl-sign-typed-v1"
        ? computeTypedDataDigest(payload)
        : officialQrlDigest(payload),
      secretKey,
      false,
      scheme === "qrl-sign-typed-v1"
        ? SCHEME_TAG_TYPED
        : LEGACY_V1_ZOND_CONTEXT,
    );
    return {
      version: "1",
      scheme,
      ...unsigned,
      signature: hex(signature),
      publicKey,
      descriptor,
    };
  }, extendedSeedHex);
}

// Frozen V1 fixture types remain independent of the active V2 protocol.
type OrderSigningScheme = "qrl-sign-typed-v1" | "qrl-eip712-v4";
interface ProtocolAuthV1 {
  version: "1";
  scheme: OrderSigningScheme;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  signature: string;
  publicKey: string;
  descriptor: string;
}
