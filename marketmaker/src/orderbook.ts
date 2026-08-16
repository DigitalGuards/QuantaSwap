// Order book API client, mirroring frontend/src/lib/orderbook.ts. Nothing
// returned here is trusted for fund movement.

import type { AssetSymbol } from "./assets.js";
import { isDeepStrictEqual } from "node:util";
import type { Direction, FillIntentAuthV1, SelectedFillIntentV1 } from "./policy.js";
import type {
  FillIntentV1Body,
  SignedCancelV1,
  SignedFillV1,
  SignedOrderV1,
} from "./protocol-signing.js";
import {
  computeCancelDigest,
  computeFillDigest,
  computeOrderDigest,
  deriveOrderV1Id,
} from "./protocol-signing.js";

export type OrderStatus = "open" | "accepted" | "locking" | "cancelled";

export interface OrderView {
  id: string;
  direction: Direction;
  /** ETH-leg asset symbol; absent on books predating stable pairs
   *  (means ETH). Untrusted like everything else here: the maker
   *  verifies the escrowed token on chain against its own registry. */
  asset?: AssetSymbol;
  fromAmount: string;
  toAmount: string;
  makerEthAccount: string;
  makerQrlAccount: string;
  status: OrderStatus;
  takerEthAccount: string | null;
  takerQrlAccount: string | null;
  hashlock: string | null;
  initiatorTimeout: number | null;
  responderTimeout: number | null;
  /** The taker released this take (walked away with an authorized
   *  release); optional for books predating the flag. */
  released?: boolean;
  /** The maker heartbeated recently; optional for books predating it. */
  makerSeen?: boolean;
  visibility?: "public" | "private";
  allowedTakerEth?: string;
  allowedTakerQrl?: string;
  prelocked?: boolean;
  makerAuth?: SignedOrderV1["auth"];
  orderDigest?: string;
  fill?: SignedFillV1["fill"];
  fillAuth?: SignedFillV1["auth"];
  fillDigest?: string;
  selectedIntent?: SelectedFillIntentV1;
  cancelProof?: SignedCancelV1["cancel"];
  cancelAuth?: SignedCancelV1["auth"];
  cancelDigest?: string;
  equivocated?: boolean;
  conflictDigests?: string[];
  createdAt: number;
  updatedAt: number;
}

export class OrderGoneError extends Error {}
export class OrderBookUnavailableError extends Error {}
class OrderBookResponseError extends Error {}

const BYTES32_RE = /^0x[0-9a-f]{64}$/;
const ETH_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const QRL_ADDRESS_RE = /^Q[0-9a-f]{40}$/;
const HEX_RE = /^0x[0-9a-f]+$/;
const DESCRIPTOR_RE = /^0x[0-9a-f]{6}$/;
const ORDER_ID_RE = /^[0-9a-f]{64}$/;
const MAKER_TOKEN_RE = /^[0-9a-f]{64}$/;
const AMOUNT_RE = /^(?:0|[1-9][0-9]{0,29})$/;
const MAX_BOOK_RESPONSE_BYTES = 2 * 1024 * 1024;

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} is malformed`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const expected = new Set(keys);
  if (
    Object.keys(value).length !== expected.size ||
    Object.keys(value).some((key) => !expected.has(key))
  ) {
    throw new Error(`${field} has unsupported or missing fields`);
  }
}

function stringMatching(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${field} is malformed`);
  }
  return value;
}

function safeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} is malformed`);
  }
  return value;
}

function nullableString(
  value: unknown,
  pattern: RegExp,
  field: string,
): string | null {
  if (value === null) return null;
  return stringMatching(value, pattern, field);
}

function sameJson(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

const ORDER_VIEW_KEYS = new Set([
  "id",
  "direction",
  "asset",
  "fromAmount",
  "toAmount",
  "makerEthAccount",
  "makerQrlAccount",
  "status",
  "takerEthAccount",
  "takerQrlAccount",
  "hashlock",
  "initiatorTimeout",
  "responderTimeout",
  "released",
  "makerSeen",
  "visibility",
  "allowedTakerEth",
  "allowedTakerQrl",
  "prelocked",
  "createdAt",
  "updatedAt",
  "makerAuth",
  "orderDigest",
  "fill",
  "fillAuth",
  "fillDigest",
  "selectedIntent",
  "cancelProof",
  "cancelAuth",
  "cancelDigest",
  "equivocated",
  "conflictDigests",
]);

function parsePortableBase(raw: unknown, expected: SignedOrderV1): OrderView {
  const row = record(raw, "order response");
  if (Object.keys(row).some((key) => !ORDER_VIEW_KEYS.has(key))) {
    throw new Error("order response has unsupported fields");
  }
  const direction = row["direction"];
  if (direction !== "eth->qrl" && direction !== "qrl->eth") {
    throw new Error("order response direction is malformed");
  }
  const asset = row["asset"];
  if (asset !== "ETH" && asset !== "USDC" && asset !== "tUSDT") {
    throw new Error("order response asset is malformed");
  }
  const status = row["status"];
  if (status !== "open" && status !== "accepted" && status !== "locking" && status !== "cancelled") {
    throw new Error("order response status is malformed");
  }
  const visibility = row["visibility"];
  if (visibility !== "public" && visibility !== "private") {
    throw new Error("order response visibility is malformed");
  }
  const initiatorTimeout = row["initiatorTimeout"] === null
    ? null
    : safeInteger(row["initiatorTimeout"], "order response initiatorTimeout");
  const responderTimeout = row["responderTimeout"] === null
    ? null
    : safeInteger(row["responderTimeout"], "order response responderTimeout");
  const parsed: OrderView = {
    id: stringMatching(row["id"], ORDER_ID_RE, "order response id"),
    direction,
    asset,
    fromAmount: stringMatching(row["fromAmount"], AMOUNT_RE, "order response fromAmount"),
    toAmount: stringMatching(row["toAmount"], AMOUNT_RE, "order response toAmount"),
    makerEthAccount: stringMatching(
      row["makerEthAccount"],
      ETH_ADDRESS_RE,
      "order response makerEthAccount",
    ),
    makerQrlAccount: stringMatching(
      row["makerQrlAccount"],
      QRL_ADDRESS_RE,
      "order response makerQrlAccount",
    ),
    status,
    takerEthAccount: nullableString(
      row["takerEthAccount"],
      ETH_ADDRESS_RE,
      "order response takerEthAccount",
    ),
    takerQrlAccount: nullableString(
      row["takerQrlAccount"],
      QRL_ADDRESS_RE,
      "order response takerQrlAccount",
    ),
    hashlock: nullableString(row["hashlock"], BYTES32_RE, "order response hashlock"),
    initiatorTimeout,
    responderTimeout,
    visibility,
    createdAt: safeInteger(row["createdAt"], "order response createdAt"),
    updatedAt: safeInteger(row["updatedAt"], "order response updatedAt"),
    ...(row["released"] === undefined ? {} : { released: row["released"] === true }),
    ...(row["makerSeen"] === undefined ? {} : { makerSeen: row["makerSeen"] === true }),
    ...(row["prelocked"] === undefined ? {} : { prelocked: row["prelocked"] === true }),
    ...(row["allowedTakerEth"] === undefined
      ? {}
      : {
          allowedTakerEth: stringMatching(
            row["allowedTakerEth"],
            ETH_ADDRESS_RE,
            "order response allowedTakerEth",
          ),
        }),
    ...(row["allowedTakerQrl"] === undefined
      ? {}
      : {
          allowedTakerQrl: stringMatching(
            row["allowedTakerQrl"],
            QRL_ADDRESS_RE,
            "order response allowedTakerQrl",
          ),
        }),
  };
  if (
    row["released"] !== undefined && typeof row["released"] !== "boolean" ||
    row["makerSeen"] !== undefined && typeof row["makerSeen"] !== "boolean" ||
    row["prelocked"] !== undefined && typeof row["prelocked"] !== "boolean"
  ) {
    throw new Error("order response boolean projection is malformed");
  }
  const digest = computeOrderDigest(expected.order, expected.auth);
  if (
    parsed.id !== deriveOrderV1Id(expected.order.makerQrlAccount, expected.auth.nonce) ||
    parsed.direction !== expected.order.direction ||
    parsed.asset !== expected.order.asset ||
    parsed.fromAmount !== expected.order.fromAmount ||
    parsed.toAmount !== expected.order.toAmount ||
    parsed.makerEthAccount !== expected.order.makerEthAccount ||
    parsed.makerQrlAccount !== expected.order.makerQrlAccount ||
    parsed.visibility !== expected.order.visibility ||
    parsed.allowedTakerEth !== expected.order.allowedTakerEth ||
    parsed.allowedTakerQrl !== expected.order.allowedTakerQrl ||
    !sameJson(row["makerAuth"], expected.auth) ||
    row["orderDigest"] !== digest
  ) {
    throw new Error("order response does not authenticate the expected OrderV1");
  }
  if (
    expected.order.prelock === undefined
      ? parsed.prelocked === true
      : parsed.prelocked !== true ||
        parsed.hashlock !== expected.order.prelock.hashlock ||
        parsed.initiatorTimeout !== expected.order.prelock.initiatorTimeout
  ) {
    throw new Error("order response changed the signed prelock");
  }
  parsed.makerAuth = expected.auth;
  parsed.orderDigest = digest;
  return parsed;
}

function assertUnconflicted(row: Record<string, unknown>, view: OrderView): void {
  if (
    row["equivocated"] === true ||
    row["fill"] !== undefined && row["cancelProof"] !== undefined ||
    Array.isArray(row["conflictDigests"]) && row["conflictDigests"].length > 0
  ) {
    throw new Error("order response contains terminal conflict evidence");
  }
  if (row["equivocated"] !== undefined && typeof row["equivocated"] !== "boolean") {
    throw new Error("order response equivocation flag is malformed");
  }
  if (row["conflictDigests"] !== undefined && !Array.isArray(row["conflictDigests"])) {
    throw new Error("order response conflict digests are malformed");
  }
  view.equivocated = false;
}

function authenticateOpenView(raw: unknown, expected: SignedOrderV1): OrderView {
  const row = record(raw, "order response");
  const view = parsePortableBase(row, expected);
  assertUnconflicted(row, view);
  if (
    view.status !== "open" ||
    view.takerEthAccount !== null ||
    view.takerQrlAccount !== null ||
    (expected.order.prelock === undefined &&
      (view.hashlock !== null || view.initiatorTimeout !== null)) ||
    view.responderTimeout !== null ||
    view.released === true ||
    row["fill"] !== undefined ||
    row["fillAuth"] !== undefined ||
    row["fillDigest"] !== undefined ||
    row["selectedIntent"] !== undefined ||
    row["cancelProof"] !== undefined ||
    row["cancelAuth"] !== undefined ||
    row["cancelDigest"] !== undefined
  ) {
    throw new Error("order response is not the expected open OrderV1");
  }
  return view;
}

function authenticateFillView(
  raw: unknown,
  expectedOrder: SignedOrderV1,
  expectedFill: SignedFillV1,
  expectedIntent: SelectedFillIntentV1,
): OrderView {
  const row = record(raw, "order response");
  const view = parsePortableBase(row, expectedOrder);
  assertUnconflicted(row, view);
  const fillDigest = computeFillDigest(expectedFill.fill, expectedOrder.auth, expectedFill.auth);
  const selectedIntent = parseIntentRow(row["selectedIntent"], 0);
  if (
    view.status !== "locking" ||
    !sameJson(row["fill"], expectedFill.fill) ||
    !sameJson(row["fillAuth"], expectedFill.auth) ||
    row["fillDigest"] !== fillDigest ||
    selectedIntent.intentDigest !== expectedIntent.intentDigest ||
    !sameJson(selectedIntent.intent, expectedIntent.intent) ||
    !sameJson(selectedIntent.auth, expectedIntent.auth) ||
    view.takerEthAccount !== expectedFill.fill.takerEthAccount ||
    view.takerQrlAccount !== expectedFill.fill.takerQrlAccount ||
    view.hashlock !== expectedFill.fill.hashlock ||
    view.initiatorTimeout !== expectedFill.fill.initiatorTimeout ||
    view.responderTimeout !== expectedFill.fill.responderTimeout ||
    row["cancelProof"] !== undefined ||
    row["cancelAuth"] !== undefined ||
    row["cancelDigest"] !== undefined
  ) {
    throw new Error("order response does not authenticate the expected FillV1");
  }
  view.fill = expectedFill.fill;
  view.fillAuth = expectedFill.auth;
  view.fillDigest = fillDigest;
  view.selectedIntent = selectedIntent;
  return view;
}

function authenticateCancelView(
  raw: unknown,
  expectedOrder: SignedOrderV1,
  expectedCancel: SignedCancelV1,
): OrderView {
  const row = record(raw, "order response");
  const view = parsePortableBase(row, expectedOrder);
  assertUnconflicted(row, view);
  const cancelDigest = computeCancelDigest(
    expectedCancel.cancel,
    expectedOrder.auth,
    expectedCancel.auth,
  );
  if (
    view.status !== "cancelled" ||
    view.released === true ||
    !sameJson(row["cancelProof"], expectedCancel.cancel) ||
    !sameJson(row["cancelAuth"], expectedCancel.auth) ||
    row["cancelDigest"] !== cancelDigest ||
    row["fill"] !== undefined ||
    row["fillAuth"] !== undefined ||
    row["fillDigest"] !== undefined ||
    row["selectedIntent"] !== undefined
  ) {
    throw new Error("order response does not authenticate the expected CancelV1");
  }
  view.cancelProof = expectedCancel.cancel;
  view.cancelAuth = expectedCancel.auth;
  view.cancelDigest = cancelDigest;
  return view;
}

function parseIntent(value: unknown, index: number): FillIntentV1Body {
  const field = `fill intent ${index}.intent`;
  const body = record(value, field);
  exactKeys(
    body,
    ["orderDigest", "takerEthAccount", "takerQrlAccount", "releaseCommitment"],
    field,
  );
  return {
    orderDigest: stringMatching(body["orderDigest"], BYTES32_RE, `${field}.orderDigest`),
    takerEthAccount: stringMatching(
      body["takerEthAccount"],
      ETH_ADDRESS_RE,
      `${field}.takerEthAccount`,
    ),
    takerQrlAccount: stringMatching(
      body["takerQrlAccount"],
      QRL_ADDRESS_RE,
      `${field}.takerQrlAccount`,
    ),
    releaseCommitment: stringMatching(
      body["releaseCommitment"],
      BYTES32_RE,
      `${field}.releaseCommitment`,
    ),
  };
}

function parseIntentAuth(value: unknown, index: number): FillIntentAuthV1 {
  const field = `fill intent ${index}.auth`;
  const auth = record(value, field);
  exactKeys(
    auth,
    [
      "version",
      "scheme",
      "issuedAt",
      "expiresAt",
      "nonce",
      "signature",
      "publicKey",
      "descriptor",
    ],
    field,
  );
  if (auth["version"] !== "1") throw new Error(`${field}.version is malformed`);
  const scheme = auth["scheme"];
  if (scheme !== "qrl-sign-typed-v1" && scheme !== "qrl-eip712-v4") {
    throw new Error(`${field}.scheme is malformed`);
  }
  const issuedAt = safeInteger(auth["issuedAt"], `${field}.issuedAt`);
  const expiresAt = safeInteger(auth["expiresAt"], `${field}.expiresAt`);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 120) {
    throw new Error(`${field} lifetime is malformed`);
  }
  return {
    version: "1",
    scheme,
    issuedAt,
    expiresAt,
    nonce: stringMatching(auth["nonce"], BYTES32_RE, `${field}.nonce`),
    signature: stringMatching(auth["signature"], HEX_RE, `${field}.signature`),
    publicKey: stringMatching(auth["publicKey"], HEX_RE, `${field}.publicKey`),
    descriptor: stringMatching(auth["descriptor"], DESCRIPTOR_RE, `${field}.descriptor`),
  };
}

function parseIntentRow(value: unknown, index: number): SelectedFillIntentV1 {
  const field = `fill intent ${index}`;
  const row = record(value, field);
  exactKeys(row, ["intentDigest", "intent", "auth", "receivedAt"], field);
  return {
    intentDigest: stringMatching(row["intentDigest"], BYTES32_RE, `${field}.intentDigest`),
    intent: parseIntent(row["intent"], index),
    auth: parseIntentAuth(row["auth"], index),
    receivedAt: safeInteger(row["receivedAt"], `${field}.receivedAt`),
  };
}

async function readBookJson(res: Response): Promise<unknown> {
  const mediaType = res.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new OrderBookResponseError("order book response is not application/json");
  }
  const advertised = res.headers.get("content-length");
  if (advertised !== null) {
    const length = Number(advertised);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BOOK_RESPONSE_BYTES) {
      throw new OrderBookResponseError("order book response exceeds the size limit");
    }
  }
  if (res.body === null) {
    throw new OrderBookResponseError("order book response body is missing");
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_BOOK_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new OrderBookResponseError("order book response exceeds the size limit");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new OrderBookResponseError("order book response contains invalid JSON");
  }
}

export class OrderBookClient {
  constructor(
    private readonly base: string,
    /** Per-call deadline. The tick calls the book FIRST every order, so a
     *  stalling or hostile book must never be able to hang here. */
    private readonly timeoutMs = 20_000,
  ) {}

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      throw new OrderBookUnavailableError("order book transport is unavailable", {
        cause: error,
      });
    }
    if (res.status >= 500) {
      await res.body?.cancel().catch(() => undefined);
      throw new OrderBookUnavailableError(`order book is unavailable (HTTP ${res.status})`);
    }
    let payload: unknown;
    try {
      payload = await readBookJson(res);
    } catch (error) {
      if (error instanceof OrderBookResponseError) throw error;
      throw new OrderBookUnavailableError("order book response transport failed", {
        cause: error,
      });
    }
    const payloadRecord = record(payload, "order book response");
    const error = typeof payloadRecord["error"] === "string" ? payloadRecord["error"] : undefined;
    if (res.status === 404) throw new OrderGoneError(error ?? "order not found");
    if (!res.ok) {
      throw new Error(error ?? `order book request failed (HTTP ${res.status})`);
    }
    return payload as T;
  }

  async get(id: string): Promise<OrderView> {
    return (await this.api<{ order: OrderView }>("GET", `/orders/${id}`)).order;
  }

  async create(body: {
    direction: Direction;
    asset: AssetSymbol;
    fromAmount: string;
    toAmount: string;
    makerEthAccount: string;
    makerQrlAccount: string;
  }): Promise<{ order: OrderView; makerToken: string }> {
    return this.api("POST", "/orders", body);
  }

  async createSigned(
    proof: SignedOrderV1,
    makerToken: string,
  ): Promise<{ order: OrderView; makerToken: string }> {
    if (proof.order.visibility !== "public") {
      throw new Error("headless market maker supports public signed orders only");
    }
    const canonicalToken = stringMatching(makerToken, MAKER_TOKEN_RE, "signed create makerToken");
    const payload = await this.api<unknown>("POST", "/orders/signed", {
      ...proof,
      makerToken: canonicalToken,
    });
    const response = record(payload, "signed create response");
    exactKeys(response, ["order", "makerToken"], "signed create response");
    const returnedToken = stringMatching(
      response["makerToken"],
      MAKER_TOKEN_RE,
      "signed create response makerToken",
    );
    if (returnedToken !== canonicalToken) {
      throw new Error("signed create response changed the committed maker capability");
    }
    return {
      order: authenticateOpenView(response["order"], proof),
      makerToken: returnedToken,
    };
  }

  async getSigned(
    id: string,
    order: SignedOrderV1,
    terminal?: { fill: SignedFillV1; intent: SelectedFillIntentV1 } | { cancel: SignedCancelV1 },
  ): Promise<OrderView> {
    const payload = await this.api<unknown>("GET", `/orders/${id}`);
    const response = record(payload, "signed get response");
    exactKeys(response, ["order"], "signed get response");
    const rawOrder = record(response["order"], "signed get response order");
    if (rawOrder["status"] === "open") {
      return authenticateOpenView(rawOrder, order);
    }
    if (terminal !== undefined && "fill" in terminal) {
      return authenticateFillView(rawOrder, order, terminal.fill, terminal.intent);
    }
    if (terminal !== undefined) {
      return authenticateCancelView(rawOrder, order, terminal.cancel);
    }
    return authenticateOpenView(rawOrder, order);
  }

  async intents(id: string): Promise<SelectedFillIntentV1[]> {
    const payload = await this.api<{ intents?: unknown }>("GET", `/orders/${id}/intents`);
    if (!Array.isArray(payload.intents)) throw new Error("fill intent response is malformed");
    return payload.intents.map(parseIntentRow);
  }

  async fill(
    id: string,
    proof: SignedFillV1,
    selected: SelectedFillIntentV1,
    order: SignedOrderV1,
    token?: string,
  ): Promise<OrderView> {
    const body = {
      ...proof,
      intent: selected.intent,
      intentAuth: selected.auth,
      ...(token === undefined ? {} : { token }),
    };
    const payload = await this.api<unknown>("POST", `/orders/${id}/fill`, body);
    const response = record(payload, "signed fill response");
    exactKeys(response, ["order"], "signed fill response");
    return authenticateFillView(response["order"], order, proof, selected);
  }

  async cancelSigned(
    id: string,
    proof: SignedCancelV1,
    order: SignedOrderV1,
    token?: string,
  ): Promise<OrderView> {
    const payload = await this.api<unknown>("POST", `/orders/${id}/cancel/signed`, {
      ...proof,
      ...(token === undefined ? {} : { token }),
    });
    const response = record(payload, "signed cancellation response");
    exactKeys(response, ["order"], "signed cancellation response");
    return authenticateCancelView(response["order"], order, proof);
  }

  async announceHashlock(
    id: string,
    body: { token: string; hashlock: string; initiatorTimeout: number; responderTimeout: number },
  ): Promise<OrderView> {
    return (await this.api<{ order: OrderView }>("POST", `/orders/${id}/hashlock`, body)).order;
  }

  async cancel(id: string, token: string): Promise<OrderView> {
    return (await this.api<{ order: OrderView }>("POST", `/orders/${id}/cancel`, { token })).order;
  }

  /** Maker liveness ping; keeps our listings in the matchable set. */
  async heartbeat(id: string, token: string): Promise<OrderView> {
    return (await this.api<{ order: OrderView }>("POST", `/orders/${id}/heartbeat`, { token }))
      .order;
  }
}
