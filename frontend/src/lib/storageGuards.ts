import { isRecord, isString, isSafeUint } from "@/utils/guards";
import type {
  ActiveSwap,
  MyOrderRef,
  PrelockRef,
  PrelockStage,
  SignedOrderStage,
} from "./activeSwap";
import {
  optionalField,
  isBoolean,
  isNullableString,
  isNullableUint,
  isDirection,
  isAsset,
  isVisibility,
  isMakerAuth,
  isCreateOrderBody,
  isPrelockAnchor,
  isSignedIntent,
  isSignedFill,
  isSignedCancel,
  isFillBody,
  isFillIntentView,
} from "./wireGuards";

export function isActiveSwap(value: unknown): value is ActiveSwap {
  return (
    isRecord(value) &&
    (value.role === "maker" || value.role === "taker" || value.role === "sandbox") &&
    isDirection(value.direction) &&
    isAsset(value.ethAsset) &&
    isNullableString(value.orderId) &&
    isNullableString(value.takerToken) &&
    isNullableString(value.preimage) &&
    isNullableString(value.hashlock) &&
    isNullableUint(value.initiatorTimeout) &&
    isNullableUint(value.responderTimeout) &&
    isSafeUint(value.createdAt) &&
    [
      value.fromAmount,
      value.toAmount,
      value.makerEthAccount,
      value.makerQrlAccount,
      value.takerEthAccount,
      value.takerQrlAccount,
    ].every(isString) &&
    optionalField(value, "termsBindingVersion", (version) => version === 1) &&
    optionalField(value, "bookId", isString) &&
    optionalField(value, "orderDigest", isString) &&
    optionalField(value, "releaseSecret", isString) &&
    optionalField(value, "intent", isSignedIntent) &&
    optionalField(value, "intentDigest", isString) &&
    optionalField(value, "fill", isSignedFill) &&
    optionalField(value, "fillDigest", isString) &&
    optionalField(value, "shareToken", isNullableString) &&
    optionalField(value, "prelocked", isBoolean) &&
    optionalField(value, "acceptedPrelock", (anchor) => anchor === null || isPrelockAnchor(anchor))
  );
}

function isPrelockRef(value: unknown): value is PrelockRef {
  return (
    isRecord(value) &&
    isString(value.preimage) &&
    (value.leg === "eth" || value.leg === "qrl") &&
    isPrelockAnchor(value)
  );
}

export function isMyOrderRef(value: unknown): value is MyOrderRef {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.token) &&
    (value.direction === null || isDirection(value.direction)) &&
    isAsset(value.asset) &&
    isNullableString(value.fromAmount) &&
    isNullableString(value.toAmount) &&
    isNullableString(value.shareToken) &&
    (value.prelock === null || isPrelockRef(value.prelock)) &&
    optionalField(value, "bookId", isString) &&
    optionalField(value, "orderAuth", isMakerAuth) &&
    optionalField(value, "orderDigest", isString) &&
    optionalField(value, "selectedIntent", isFillIntentView) &&
    optionalField(value, "fillPreimage", isString) &&
    optionalField(value, "fillDraft", isFillBody) &&
    optionalField(value, "fillRespondBy", isSafeUint) &&
    optionalField(value, "fill", isSignedFill) &&
    optionalField(value, "fillDigest", isString) &&
    optionalField(value, "cancel", isSignedCancel) &&
    optionalField(value, "cancelDigest", isString)
  );
}

export function isSignedOrderStage(value: unknown): value is SignedOrderStage {
  return (
    isRecord(value) &&
    isCreateOrderBody(value.order) &&
    isMakerAuth(value.auth) &&
    isString(value.makerToken) &&
    optionalField(value, "shareToken", isString) &&
    isString(value.orderDigest) &&
    isString(value.bookId) &&
    isSafeUint(value.createdAt)
  );
}

export function isPrelockStage(value: unknown): value is PrelockStage {
  return (
    isRecord(value) &&
    isPrelockRef(value) &&
    isDirection(value.direction) &&
    isAsset(value.asset) &&
    isString(value.fromAmount) &&
    isString(value.toAmount) &&
    isVisibility(value.visibility) &&
    isNullableString(value.allowedTakerEth) &&
    isNullableString(value.allowedTakerQrl) &&
    isSafeUint(value.createdAt)
  );
}
