import { PRIMARY_ORDERBOOK_ID, type EthAssetSymbol } from "@/config";
import type { ActiveSwap } from "@/lib/activeSwap";
import type { OrderView } from "@/lib/orderbook";
import type { FillIntentView } from "@/lib/orderbookClient";
import {
  fillDigest,
  intentDigest,
  verifyFillIntentV1,
  verifyFillV1,
  verifyOrderV1Auth,
  type SignedFillIntentV1,
  type SignedFillV1,
} from "@/lib/orderSigning";

export interface SignedTakerRecovery {
  orderDigest: string;
  intent: SignedFillIntentV1;
  intentDigest: string;
}

interface SignedTakeAccounts {
  takerEthAccount: string;
  takerQrlAccount: string;
}

const AMOUNT_RE = /^(?:0|[1-9][0-9]{0,29})$/;
const HASHLOCK_RE = /^0x[0-9a-f]{64}$/;

export function buildSignedTakerSwap({
  order,
  asset,
  accounts,
  signedIntent,
  intentDigestHex,
  releaseSecret,
  shareToken = null,
  now = Math.floor(Date.now() / 1000),
}: {
  order: OrderView;
  asset: EthAssetSymbol;
  accounts: SignedTakeAccounts;
  signedIntent: SignedFillIntentV1;
  intentDigestHex: string;
  releaseSecret: string;
  shareToken?: string | null;
  now?: number;
}): ActiveSwap {
  if (
    order.status !== "open" ||
    order.makerAuth === undefined ||
    order.orderDigest === undefined ||
    !verifyOrderV1Auth(order, now) ||
    (order.asset ?? "ETH") !== asset ||
    !AMOUNT_RE.test(order.fromAmount) ||
    !AMOUNT_RE.test(order.toAmount) ||
    BigInt(order.fromAmount) === 0n ||
    BigInt(order.toAmount) === 0n ||
    signedIntent.intent.orderDigest !== order.orderDigest ||
    signedIntent.intent.takerEthAccount !== accounts.takerEthAccount.toLowerCase() ||
    signedIntent.intent.takerQrlAccount !==
      `Q${accounts.takerQrlAccount.slice(1).toLowerCase()}` ||
    intentDigestHex !== intentDigest(signedIntent.intent, signedIntent.auth)
  ) {
    throw new Error("The signed order request does not match the displayed order.");
  }
  const prelocked = order.prelocked === true;
  if (
    prelocked &&
    (order.hashlock === null ||
      !HASHLOCK_RE.test(order.hashlock) ||
      order.initiatorTimeout === null ||
      !Number.isSafeInteger(order.initiatorTimeout))
  ) {
    throw new Error("The pre-funded order has incomplete escrow terms.");
  }
  return {
    role: "taker",
    termsBindingVersion: 1,
    orderId: order.id,
    bookId: order.bookId ?? PRIMARY_ORDERBOOK_ID,
    orderDigest: order.orderDigest,
    releaseSecret,
    intent: signedIntent,
    intentDigest: intentDigestHex,
    takerToken: null,
    shareToken,
    ...(prelocked ? { prelocked: true } : {}),
    acceptedPrelock: prelocked
      ? {
          hashlock: order.hashlock as string,
          initiatorTimeout: order.initiatorTimeout as number,
        }
      : null,
    direction: order.direction,
    ethAsset: asset,
    fromAmount: order.fromAmount,
    toAmount: order.toAmount,
    makerEthAccount: order.makerEthAccount,
    makerQrlAccount: order.makerQrlAccount,
    takerEthAccount: accounts.takerEthAccount,
    takerQrlAccount: accounts.takerQrlAccount,
    preimage: null,
    hashlock: null,
    initiatorTimeout: null,
    responderTimeout: null,
    createdAt: now,
  };
}

interface IntentSelectionOptions {
  now?: number;
  verify?: typeof verifyFillIntentV1;
  digest?: typeof intentDigest;
}

interface FillVerificationOptions {
  now?: number;
  verify?: typeof verifyFillV1;
}

export function sameSignedIntent(
  left: SignedFillIntentV1,
  right: SignedFillIntentV1,
): boolean {
  return (
    left.intent.orderDigest === right.intent.orderDigest &&
    left.intent.takerEthAccount === right.intent.takerEthAccount &&
    left.intent.takerQrlAccount === right.intent.takerQrlAccount &&
    left.intent.releaseCommitment === right.intent.releaseCommitment &&
    left.auth.version === right.auth.version &&
    left.auth.scheme === right.auth.scheme &&
    left.auth.issuedAt === right.auth.issuedAt &&
    left.auth.expiresAt === right.auth.expiresAt &&
    left.auth.nonce === right.auth.nonce &&
    left.auth.signature === right.auth.signature &&
    left.auth.publicKey === right.auth.publicKey &&
    left.auth.descriptor === right.auth.descriptor
  );
}

/** Choose from signed time and digest so every honest mirror reaches one result. */
export function selectEarliestFillIntent(
  order: OrderView,
  candidates: readonly FillIntentView[],
  options: IntentSelectionOptions = {},
): FillIntentView | null {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const verify = options.verify ?? verifyFillIntentV1;
  const digest = options.digest ?? intentDigest;
  const valid = candidates.filter((candidate) => {
    try {
      return (
        candidate.auth.issuedAt <= now &&
        candidate.intentDigest === digest(candidate.intent, candidate.auth) &&
        verify(candidate.intent, candidate.auth, order, { now })
      );
    } catch {
      return false;
    }
  });
  valid.sort(
    (left, right) =>
      left.auth.issuedAt - right.auth.issuedAt ||
      left.intentDigest.localeCompare(right.intentDigest),
  );
  return valid[0] ?? null;
}

/**
 * Authenticate the maker's terminal FillV1 before the taker can fund.
 * Expired intent proofs remain valid historical inputs once the maker has
 * signed a fill, while the fill's own respondBy deadline stays a hard gate.
 */
export function verifyTakerFill(
  order: OrderView,
  recovery: SignedTakerRecovery,
  options: FillVerificationOptions = {},
): { signed: SignedFillV1; digest: string } | null {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const verify = options.verify ?? verifyFillV1;
  if (order.released === true) {
    throw new Error("This signed fill was released. Funding is blocked.");
  }
  if (order.equivocated === true || order.cancelProof !== undefined) {
    throw new Error("The maker published conflicting terminal messages. Funding is blocked.");
  }
  if (order.fill === undefined && order.fillAuth === undefined) return null;
  if (
    order.status !== "locking" ||
    order.makerAuth === undefined ||
    order.fill === undefined ||
    order.fillAuth === undefined ||
    order.selectedIntent === undefined
  ) {
    throw new Error("The order contains an incomplete FillV1. Funding is blocked.");
  }
  if (now >= order.fillAuth.expiresAt) {
    throw new Error("The maker response deadline passed before funding. Request a fresh order.");
  }
  if (
    order.orderDigest !== recovery.orderDigest ||
    recovery.intentDigest !== intentDigest(recovery.intent.intent, recovery.intent.auth)
  ) {
    throw new Error("The fill does not match the locally saved order request.");
  }
  if (
    order.selectedIntent.intentDigest !== recovery.intentDigest ||
    !sameSignedIntent(order.selectedIntent, recovery.intent)
  ) {
    throw new Error("The maker selected a different taker request.");
  }
  if (
    !verify(order.fill, order.fillAuth, order, recovery.intent, {
      now,
      allowExpired: true,
    })
  ) {
    throw new Error("The maker FillV1 proof is invalid. Funding is blocked.");
  }
  const digest = fillDigest(order.fill, order.makerAuth, order.fillAuth);
  if (order.fillDigest !== undefined && order.fillDigest !== digest) {
    throw new Error("The order book returned a mismatched FillV1 digest.");
  }
  return { signed: { fill: order.fill, auth: order.fillAuth }, digest };
}

type LockCallback<T> = () => Promise<T>;

interface LockManagerPort {
  request<T>(name: string, callback: LockCallback<T>): Promise<T>;
}

function browserLockManager(): LockManagerPort | undefined {
  try {
    return typeof navigator === "undefined" ? undefined : navigator.locks;
  } catch {
    return undefined;
  }
}

/** Serialize maker selection across tabs when the browser exposes Web Locks. */
export function withOrderSelectionLock<T>(
  orderId: string,
  callback: LockCallback<T>,
  lockManager: LockManagerPort | null | undefined = browserLockManager(),
): Promise<T> {
  if (lockManager === undefined || lockManager === null) {
    return Promise.reject(
      new Error(
        "This browser cannot safely select a signed fill because Web Locks are unavailable.",
      ),
    );
  }
  return lockManager.request(`quantaswap-fill-${orderId}`, callback);
}
