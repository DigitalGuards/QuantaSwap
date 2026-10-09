import { isArray, isRecord } from "./utils/guards";
/// <reference types="vite/client" />
import deployment from "../../config/protocol-v2.json";

// `confirmations`: extra block depth a counterparty lock must reach
// before this client acts on it irreversibly (taker locking, maker
// revealing the secret). 0 acts as soon as the lock is included at the
// head block: a deliberate testnet-speed choice that accepts depth-1
// reorg risk (worst case, the maker's claim broadcast publishes the
// preimage while the taker's lock reorgs away; see lib/htlc.ts).
// Production MUST gate on the `finalized` tag instead (ARCHITECTURE
// section 2 sizes the timelock margins for full ~13 min finality).
export const QRL_LEG = {
  key: "qrl" as const,
  name: "QRL Testnet v3 (Private)",
  asset: "QRL",
  // Unit label for amount displays. Ecosystem convention: amounts show as
  // "Quanta"; "QRL" stays the ticker in pair labels (QRL/USDC) and the
  // protocol-level `asset` identifier above.
  display: "Quanta",
  chainIdHex: `0x${BigInt(deployment.qrlChainId).toString(16)}`,
  genesisHash: deployment.qrlGenesisHash,
  htlc: deployment.qrlHtlc,
  rpc: "/rpc/qrl",
  confirmations: 0,
  explorerTx: "https://zondscan.com/tx/",
  explorerAddress: "https://zondscan.com/address/",
};

export const ETH_LEG = {
  key: "eth" as const,
  name: "Sepolia",
  // The chain's native coin; ERC-20 legs carry their asset on the order
  // and the persisted swap (see lib/assetRegistry.ts).
  asset: "ETH",
  display: "ETH",
  chainIdHex: `0x${BigInt(deployment.ethChainId).toString(16)}`,
  htlc: deployment.ethHtlc,
  rpc: "/rpc/sepolia",
  confirmations: 0,
  explorerTx: "https://sepolia.etherscan.io/tx/",
  explorerAddress: "https://sepolia.etherscan.io/address/",
};

// New deployments never adopt prior-chain swap secrets, orders, or stages.
export const DEPLOYMENT_STORAGE_PREFIX = `quantaswap.v3.${deployment.qrlChainId}.${deployment.qrlGenesisHash}.${deployment.ethHtlc.toLowerCase()}.${deployment.qrlHtlc.toLowerCase()}`;

// The ETH-leg asset model: the Sepolia leg can escrow native ETH or a
// registry ERC-20 (USDC, tUSDT); the QRL leg is always native QRL.
export {
  ETH_ASSETS,
  ETH_ASSET_SYMBOLS,
  ethAssetByAddress,
  ethAssetSymbolOrNull,
  type EthAsset,
  type EthAssetQuirks,
  type EthAssetSymbol,
} from "./lib/assetRegistry";

// Separate proxy for eth_getLogs only: publicnode's free tier refuses log
// scans ("archive request"), so event lookups go to the EF's ethpandaops
// endpoint, which serves them from genesis. Everything else stays on the
// main Sepolia RPC.
export const ETH_LOGS_RPC = "/rpc/sepolia-logs";

export type LegKey = "qrl" | "eth";

export const legByKey = (key: LegKey) => (key === "qrl" ? QRL_LEG : ETH_LEG);

// Demo timelocks. Real protocol-mode matching will size these per pair;
// the invariant is initiator >= 2x responder.
export const INITIATOR_TIMEOUT_S = 2 * 3600;
export const RESPONDER_TIMEOUT_S = 1 * 3600;

// Order-book mirrors. The primary stays same-origin (nginx in deployments,
// Vite proxy in development). Additional public mirrors are an optional JSON
// build variable, for example:
// VITE_ORDERBOOK_MIRRORS='[{"id":"community","apiBase":"https://book.example/api"}]'
export interface OrderbookMirror {
  id: string;
  apiBase: string;
}

export const PRIMARY_ORDERBOOK_ID = "primary";

const MIRROR_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_ORDERBOOK_MIRRORS = 16;

export function parseConfiguredMirrors(raw: unknown): OrderbookMirror[] {
  if (typeof raw !== "string" || raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("VITE_ORDERBOOK_MIRRORS must be valid JSON");
  }
  if (!isArray(parsed)) throw new Error("VITE_ORDERBOOK_MIRRORS must be an array");
  if (parsed.length >= MAX_ORDERBOOK_MIRRORS) {
    throw new Error(
      `VITE_ORDERBOOK_MIRRORS cannot contain more than ${MAX_ORDERBOOK_MIRRORS - 1} entries`,
    );
  }
  const mirrors = parsed.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`VITE_ORDERBOOK_MIRRORS entry ${index} must be an object`);
    }
    const row = entry;
    const keys = Object.keys(row).sort();
    if (keys.length !== 2 || keys[0] !== "apiBase" || keys[1] !== "id") {
      throw new Error(`VITE_ORDERBOOK_MIRRORS entry ${index} has unexpected fields`);
    }
    if (typeof row["id"] !== "string" || !MIRROR_ID_RE.test(row["id"])) {
      throw new Error(`VITE_ORDERBOOK_MIRRORS entry ${index} has an invalid id`);
    }
    if (row["id"] === PRIMARY_ORDERBOOK_ID) {
      throw new Error("VITE_ORDERBOOK_MIRRORS cannot replace the primary mirror");
    }
    if (typeof row["apiBase"] !== "string") {
      throw new Error(`VITE_ORDERBOOK_MIRRORS entry ${index} has an invalid apiBase`);
    }
    let url: URL;
    try {
      url = new URL(row["apiBase"]);
    } catch {
      throw new Error(`VITE_ORDERBOOK_MIRRORS entry ${index} has an invalid apiBase`);
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error(`VITE_ORDERBOOK_MIRRORS entry ${index} must use a plain HTTP(S) URL`);
    }
    return {
      id: row["id"],
      apiBase: url.toString().replace(/\/+$/, ""),
    };
  });
  if (new Set(mirrors.map((mirror) => mirror.id)).size !== mirrors.length) {
    throw new Error("VITE_ORDERBOOK_MIRRORS contains duplicate ids");
  }
  if (new Set(mirrors.map((mirror) => mirror.apiBase)).size !== mirrors.length) {
    throw new Error("VITE_ORDERBOOK_MIRRORS contains duplicate API bases");
  }
  return mirrors;
}

export const ORDERBOOK_MIRRORS: readonly OrderbookMirror[] = [
  { id: PRIMARY_ORDERBOOK_ID, apiBase: "/api" },
  ...parseConfiguredMirrors(import.meta.env.VITE_ORDERBOOK_MIRRORS),
];

export const ORDERBOOK_API = ORDERBOOK_MIRRORS[0]?.apiBase ?? "/api";

// Dust guard for the QRL side of orders (0.001 QRL); mirrored server-side
// in server/src/store.ts. The ETH-leg floor is per asset: see
// EthAsset.minBaseUnits in lib/assetRegistry.ts.
export const MIN_QRL_AMOUNT_WEI = 10n ** 15n;

// A taker only locks if the maker's timeout leaves at least this much
// claim window beyond the responder timeout.
export const CLAIM_MARGIN_S = 30 * 60;

// Pre-funded (prelocked) listings: the open-recipient lock's T1 window,
// sized to the book's 48h listing TTL so the listing's expiry and the
// escrow's refund opening coincide.
export const PRELOCK_INITIATOR_TIMEOUT_S = 48 * 3600;

// A prelocked order is takeable only while this much of its fixed T1
// remains: the announce-time 2x invariant for a fresh responder window,
// plus the claim margin for accept->announce->assign latency. Mirrored
// server-side in server/src/store.ts (MIN_TAKEABLE_RUNWAY_S).
export const MIN_TAKEABLE_RUNWAY_S = 2 * RESPONDER_TIMEOUT_S + CLAIM_MARGIN_S;

export const GITHUB_URL = "https://github.com/DigitalGuards/QuantaSwap";

/**
 * Path this build is served under, always with a leading and a trailing
 * slash ("/" by default). Set VITE_BASE_PATH to serve a build beside another
 * on one origin, which is how a previous release stays reachable after a
 * contract cutover: local swap state is namespaced per origin, so a build at
 * /v2/ reads the records its own deployment wrote and nothing else. Vite's
 * `base` produces the same value at runtime, and this normalises it so the
 * router basename and every absolute link agree with it.
 */
export function normalizeBasePath(raw: unknown): string {
  if (typeof raw !== "string" || raw === "" || raw === "/") return "/";
  const trimmed = raw.trim();
  if (!/^\/[A-Za-z0-9][A-Za-z0-9._~-]*(\/[A-Za-z0-9._~-]+)*\/?$/.test(trimmed)) {
    throw new Error(
      "VITE_BASE_PATH must be an absolute path of plain path segments, for example /v2/",
    );
  }
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export const BASE_PATH = normalizeBasePath(import.meta.env.BASE_URL);

/** The router basename: BASE_PATH without its trailing slash, empty at root. */
export const ROUTER_BASENAME = BASE_PATH === "/" ? "" : BASE_PATH.slice(0, -1);

/** An absolute URL for a path inside this build, for a link someone pastes
 *  elsewhere. `path` is app-relative and may start with a slash. */
export const absoluteAppUrl = (path: string): string =>
  new URL(`${BASE_PATH}${path.replace(/^\//, "")}`, window.location.origin).href;

/**
 * Where the previous release is served, when one is. Local swap state is
 * namespaced on both HTLC addresses and scoped to the origin, so a build of
 * the previous release at this path reads exactly the records that deployment
 * wrote: it is the recovery route for funds locked before a contract cutover.
 * Empty by default, and empty is what a build ships with: linking to /v2/
 * before anything is served there points users at a 404 while they are
 * looking for locked funds. An operator sets VITE_LEGACY_RELEASE_PATH=/v2/ at
 * build time once that path is actually served.
 */
export const LEGACY_RELEASE_PATH: string = (() => {
  const raw: unknown = import.meta.env.VITE_LEGACY_RELEASE_PATH;
  if (typeof raw !== "string" || raw === "") return "";
  return normalizeBasePath(raw);
})();
