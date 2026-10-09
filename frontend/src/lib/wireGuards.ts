import { isArray, isRecord, isSafeUint, isString } from "@/utils/guards";
import type { CreateOrderBody, MakerOrderAuthV1 } from "./orderbook";
import type { FillIntentView } from "./orderbookClient";
import type {
  ProtocolAuthV1,
  FillIntentV1Body,
  FillV1Body,
  CancelV1Body,
  SignedFillIntentV1,
  SignedFillV1,
  SignedCancelV1,
} from "./orderSigning";

export function optionalField(
  record: Record<string, unknown>,
  key: string,
  guard: (value: unknown) => boolean,
): boolean {
  return !(key in record) || guard(record[key]);
}

export const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
export const isNullableString = (value: unknown): value is string | null =>
  value === null || isString(value);
export const isNullableUint = (value: unknown): value is number | null =>
  value === null || isSafeUint(value);
export const isStringArray = (value: unknown): value is string[] =>
  isArray(value) && value.every(isString);
export const isDirection = (value: unknown): value is "eth->qrl" | "qrl->eth" =>
  value === "eth->qrl" || value === "qrl->eth";
export const isAsset = (value: unknown): value is "ETH" | "USDC" | "tUSDT" =>
  value === "ETH" || value === "USDC" || value === "tUSDT";
export const isVisibility = (value: unknown): value is "public" | "private" =>
  value === "public" || value === "private";

/** Shape checks precede the protocol's semantic and cryptographic checks. */
export function isProtocolAuth(value: unknown): value is ProtocolAuthV1 {
  return (
    isRecord(value) &&
    value.version === "2" &&
    value.scheme === "qrl-sign-message-v2" &&
    isSafeUint(value.issuedAt) &&
    isSafeUint(value.expiresAt) &&
    [value.nonce, value.signature, value.publicKey, value.descriptor].every(isString)
  );
}

export function isMakerAuth(value: unknown): value is MakerOrderAuthV1 {
  return (
    isRecord(value) &&
    isString(value.makerTokenCommitment) &&
    isString(value.shareTokenCommitment) &&
    isProtocolAuth(value)
  );
}

export function isPrelockAnchor(
  value: unknown,
): value is { hashlock: string; initiatorTimeout: number } {
  return isRecord(value) && isString(value.hashlock) && isSafeUint(value.initiatorTimeout);
}

export function isCreateOrderBody(value: unknown): value is CreateOrderBody {
  return (
    isRecord(value) &&
    isDirection(value.direction) &&
    isAsset(value.asset) &&
    [value.fromAmount, value.toAmount, value.makerEthAccount, value.makerQrlAccount].every(
      isString,
    ) &&
    optionalField(value, "visibility", isVisibility) &&
    optionalField(value, "allowedTakerEth", isString) &&
    optionalField(value, "allowedTakerQrl", isString) &&
    optionalField(value, "prelock", isPrelockAnchor)
  );
}

export function isFillIntentBody(value: unknown): value is FillIntentV1Body {
  return (
    isRecord(value) &&
    [
      value.orderDigest,
      value.takerEthAccount,
      value.takerQrlAccount,
      value.releaseCommitment,
    ].every(isString)
  );
}

export function isFillBody(value: unknown): value is FillV1Body {
  return (
    isRecord(value) &&
    isFillIntentBody(value) &&
    isString(value.intentDigest) &&
    isString(value.hashlock) &&
    isSafeUint(value.initiatorTimeout) &&
    isSafeUint(value.responderTimeout)
  );
}

export function isCancelBody(value: unknown): value is CancelV1Body {
  return isRecord(value) && isString(value.orderDigest) && isSafeUint(value.reasonCode);
}

export function isSignedIntent(value: unknown): value is SignedFillIntentV1 {
  return isRecord(value) && isFillIntentBody(value.intent) && isProtocolAuth(value.auth);
}

export function isFillIntentView(value: unknown): value is FillIntentView {
  return (
    isRecord(value) &&
    isSignedIntent(value) &&
    isString(value.intentDigest) &&
    isSafeUint(value.receivedAt)
  );
}

export function isSignedFill(value: unknown): value is SignedFillV1 {
  return isRecord(value) && isFillBody(value.fill) && isProtocolAuth(value.auth);
}

export function isSignedCancel(value: unknown): value is SignedCancelV1 {
  return isRecord(value) && isCancelBody(value.cancel) && isProtocolAuth(value.auth);
}
