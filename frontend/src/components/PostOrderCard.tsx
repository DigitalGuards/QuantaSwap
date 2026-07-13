import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits } from "ethers";
import type { BrowserProvider } from "ethers";
import { ArrowDownUp, BookPlus } from "lucide-react";
import {
  ETH_ASSETS,
  ETH_ASSET_SYMBOLS,
  ETH_LEG,
  MIN_QRL_AMOUNT_WEI,
  PRELOCK_INITIATOR_TIMEOUT_S,
  QRL_LEG,
  ethAssetSymbolOrNull,
  type EthAssetSymbol,
  type LegKey,
} from "@/config";
import type { Direction } from "@/lib/activeSwap";
import {
  clearPrelockStage,
  initiatorLeg,
  loadPrelockStage,
  saveMyOrder,
  savePrelockStage,
  type MyOrderRef,
  type PrelockStage,
} from "@/lib/activeSwap";
import { createOrder } from "@/lib/orderbook";
import { generateSecret } from "@/lib/secrets";
import {
  SwapStatus,
  buildLockNativeOpenData,
  buildLockTokenOpenData,
  buildReleaseData,
  getLegState,
  shortAddr,
} from "@/lib/htlc";
import { makeLegSender, sendEthTokenLock } from "@/lib/legSender";
import type { QrlTransport } from "@/hooks/useQrlWallet";
import { errorMessage, isUserRejection } from "@/utils/errorMessage";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/UI/Card";
import { Button } from "@/components/UI/Button";
import { Input } from "@/components/UI/Input";

/** A draft for the post form, human-unit input strings. Built by the
 *  order book's "Edit as my order" action: the clicked row's terms from
 *  the viewer's perspective, ready to tweak instead of hand-deriving
 *  prices from the book. */
export interface OrderDraft {
  direction: Direction;
  asset: EthAssetSymbol;
  fromAmount: string;
  toAmount: string;
}

interface Props {
  ethAccount: string | null;
  qrlAccount: string | null;
  /** Wallet plumbing for the pre-fund escrow transaction. */
  browserProvider: BrowserProvider | null;
  ensureSepolia: () => Promise<void>;
  qrlRequest: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  qrlTransport: QrlTransport | null;
  /** Latest draft to load into the form (a fresh object per request). */
  prefill?: OrderDraft | null;
  onPosted: (ref: MyOrderRef) => void;
}

const trimAmount = (units: bigint, decimals: number): string => {
  const s = formatUnits(units, decimals);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
};

/** parseUnits with a friendly error instead of ethers' internal one when
 *  the input carries more fraction digits than the asset supports. */
const parseAmount = (value: string, decimals: number, symbol: string): bigint => {
  const fraction = value.split(".")[1];
  if (fraction !== undefined && fraction.length > decimals) {
    throw new Error(`${symbol} supports at most ${decimals} decimal places`);
  }
  return parseUnits(value, decimals);
};

const ETH_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const QRL_ADDR_RE = /^Q[0-9a-fA-F]{40}$/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until the escrow is visible Open at the head. Sepolia includes in
 *  ~12s, QRL in up to about a minute; two minutes of patience covers both
 *  with slack, and a timeout is recoverable (the staging record survives). */
async function waitForEscrow(leg: LegKey, hashlock: string): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    const state = await getLegState(leg, hashlock).catch(() => null);
    if (state && state.status === SwapStatus.Open) return;
    if (state && state.status !== SwapStatus.None) {
      throw new Error("the escrow settled unexpectedly; use the recovery banner");
    }
    await sleep(3000);
  }
  throw new Error(
    "the escrow transaction has not confirmed yet; resume from the recovery banner once it does",
  );
}

export function PostOrderCard({
  ethAccount,
  qrlAccount,
  browserProvider,
  ensureSepolia,
  qrlRequest,
  qrlTransport,
  prefill,
  onPosted,
}: Props) {
  const [direction, setDirection] = useState<Direction>("eth->qrl");
  const [assetSymbol, setAssetSymbol] = useState<EthAssetSymbol>("ETH");
  const [fromAmount, setFromAmount] = useState("");
  const [toAmount, setToAmount] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [prefund, setPrefund] = useState(false);
  const [allowedEth, setAllowedEth] = useState("");
  const [allowedQrl, setAllowedQrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Sub-step label while the pre-fund flow walks its transactions. */
  const [stageLabel, setStageLabel] = useState<string | null>(null);
  /** Interrupted pre-funded post (escrow possibly on-chain, no order). */
  const [staged, setStaged] = useState<PrelockStage | null>(() => loadPrelockStage());
  /** A chain read for the staged record just returned None (no escrow yet).
   *  Reveals the explicit discard override: the record can only be dropped
   *  here by a warned user, never automatically, since a None reading
   *  cannot distinguish a rejected lock from one still confirming. */
  const [noEscrowSeen, setNoEscrowSeen] = useState(false);
  /** On-chain status of the staged escrow, probed when the recovery banner
   *  appears so it can lead with the RIGHT action (release a real escrow vs
   *  discard a rejected one) instead of making the maker click Release to
   *  discover there is nothing there. `absent` == None (not proof the lock
   *  is dead; a pending broadcast also reads None). */
  const [stagedChain, setStagedChain] = useState<
    "checking" | "open" | "absent" | "unknown"
  >("checking");
  /** True while a fresh pre-fund post is actively running (lock + confirm +
   *  list). Suppresses the recovery banner so an in-flight post does not
   *  flash a "no escrow, discard?" prompt while its own lock is still
   *  landing; the banner is a recovery affordance for an INTERRUPTED post. */
  const [activePost, setActivePost] = useState(false);

  const sendOnLeg = useMemo(
    () => makeLegSender({ browserProvider, ensureSepolia, qrlAccount, qrlTransport, qrlRequest }),
    [browserProvider, ensureSepolia, qrlAccount, qrlTransport, qrlRequest],
  );

  // Probe the staged escrow when a recovery record is present. A settled
  // escrow (already released/refunded) is safe to auto-clear; Open means
  // real funds to finish or release; None (absent) leads with discard but
  // never auto-clears (a pending lock also reads None). Re-runs when the
  // record identity changes, and on the banner's Re-check button.
  const probeStaged = useCallback(
    async (rec: PrelockStage) => {
      setStagedChain("checking");
      try {
        const s = await getLegState(rec.leg, rec.hashlock);
        if (s.status === SwapStatus.Open) setStagedChain("open");
        else if (s.status === SwapStatus.None) {
          setStagedChain("absent");
          setNoEscrowSeen(true);
        } else {
          // Claimed/Refunded: an unassigned staged escrow can only reach a
          // terminal state by release/refund, so the funds are already
          // back with the maker. Safe to drop the record.
          clearPrelockStage();
          setStaged(null);
        }
      } catch {
        setStagedChain("unknown");
      }
    },
    [],
  );

  const stagedKey = staged ? `${staged.leg}:${staged.hashlock}` : null;
  useEffect(() => {
    if (!staged) return;
    void probeStaged(staged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stagedKey, probeStaged]);

  // Load an explicit draft over whatever is in the form (each request is
  // a fresh object, so the same row can be loaded twice).
  useEffect(() => {
    if (!prefill) return;
    setDirection(prefill.direction);
    setAssetSymbol(prefill.asset);
    setFromAmount(prefill.fromAmount);
    setToAmount(prefill.toAmount);
    setError(null);
  }, [prefill]);

  const asset = ETH_ASSETS[assetSymbol];
  // The ETH-leg side gives `asset`; the QRL side is always native QRL.
  const fromSymbol = direction === "eth->qrl" ? asset.symbol : QRL_LEG.asset;
  const toSymbol = direction === "eth->qrl" ? QRL_LEG.asset : asset.symbol;

  const ready = Boolean(ethAccount && qrlAccount && Number(fromAmount) > 0 && Number(toAmount) > 0);

  /** Create the book listing for an escrowed stage and hand over the
   *  order handle. Shared by the happy path and the recovery banner. */
  const listStagedOrder = async (
    stage: PrelockStage,
    makerEth: string,
    makerQrl: string,
  ): Promise<void> => {
    const { order, makerToken, shareToken } = await createOrder({
      direction: stage.direction,
      asset: stage.asset,
      fromAmount: stage.fromAmount,
      toAmount: stage.toAmount,
      makerEthAccount: makerEth,
      makerQrlAccount: makerQrl,
      ...(stage.visibility === "private"
        ? {
            visibility: "private" as const,
            ...(stage.allowedTakerEth !== null ? { allowedTakerEth: stage.allowedTakerEth } : {}),
            ...(stage.allowedTakerQrl !== null ? { allowedTakerQrl: stage.allowedTakerQrl } : {}),
          }
        : {}),
      prelock: { hashlock: stage.hashlock, initiatorTimeout: stage.initiatorTimeout },
    });
    // Belt and braces: a book that predates prelock would silently drop
    // the field, leaving an on-chain escrow behind an ordinary listing.
    if (order.prelocked !== true) {
      throw new Error(
        "the order book ignored the pre-funding; release the escrow from the recovery banner",
      );
    }
    const ref: MyOrderRef = {
      id: order.id,
      token: makerToken,
      asset: stage.asset,
      fromAmount: stage.fromAmount,
      toAmount: stage.toAmount,
      shareToken: shareToken ?? null,
      prelock: {
        hashlock: stage.hashlock,
        preimage: stage.preimage,
        initiatorTimeout: stage.initiatorTimeout,
        leg: stage.leg,
      },
    };
    saveMyOrder(ref);
    clearPrelockStage();
    setStaged(null);
    onPosted(ref);
  };

  const post = async () => {
    if (!ethAccount || !qrlAccount) return;
    setError(null);
    setBusy(true);
    try {
      const ethSide = direction === "eth->qrl" ? fromAmount : toAmount;
      const qrlSide = direction === "eth->qrl" ? toAmount : fromAmount;
      const ethUnits = parseAmount(ethSide, asset.decimals, asset.symbol);
      const qrlWei = parseAmount(qrlSide, 18, QRL_LEG.asset);
      if (ethUnits < asset.minBaseUnits) {
        throw new Error(
          `${asset.symbol} amount must be at least ${trimAmount(asset.minBaseUnits, asset.decimals)}`,
        );
      }
      if (qrlWei < MIN_QRL_AMOUNT_WEI) {
        throw new Error(`QRL amount must be at least ${trimAmount(MIN_QRL_AMOUNT_WEI, 18)}`);
      }
      const fromUnits = direction === "eth->qrl" ? ethUnits : qrlWei;
      const toUnits = direction === "eth->qrl" ? qrlWei : ethUnits;
      const restrictEth = allowedEth.trim();
      const restrictQrl = allowedQrl.trim();
      if (isPrivate) {
        if (restrictEth && !ETH_ADDR_RE.test(restrictEth)) {
          throw new Error("Taker ETH address must be a 0x-prefixed 20-byte address");
        }
        if (restrictQrl && !QRL_ADDR_RE.test(restrictQrl)) {
          throw new Error("Taker QRL address must be a Q-prefixed 20-byte address");
        }
      }

      if (prefund) {
        // Re-read from storage, not just in-memory state: another tab may
        // have staged a pre-funded post since this card mounted, and its
        // record holds an escrow's only preimage. Never overwrite it.
        const existing = staged ?? loadPrelockStage();
        if (existing) {
          setStaged(existing);
          throw new Error(
            "an earlier pre-funded post is still unresolved; finish or release it first (banner above)",
          );
        }
        // Escrow-before-listing, with the secret persisted BEFORE any
        // transaction: a crash after the lock broadcast must never cost
        // the preimage (losing it strands the funds until T1's
        // permissionless refund).
        const secret = await generateSecret();
        const now = Math.floor(Date.now() / 1000);
        const leg = initiatorLeg(direction);
        const stage: PrelockStage = {
          hashlock: secret.hashlock,
          preimage: secret.preimage,
          initiatorTimeout: now + PRELOCK_INITIATOR_TIMEOUT_S,
          leg,
          direction,
          asset: asset.symbol,
          fromAmount: fromUnits.toString(),
          toAmount: toUnits.toString(),
          visibility: isPrivate ? "private" : "public",
          allowedTakerEth: isPrivate && restrictEth ? restrictEth : null,
          allowedTakerQrl: isPrivate && restrictQrl ? restrictQrl : null,
          createdAt: now,
        };
        savePrelockStage(stage);
        setStaged(stage);
        setNoEscrowSeen(false);
        setActivePost(true);
        try {
          if (leg === "eth" && asset.address !== null) {
            await sendEthTokenLock({
              send: sendOnLeg,
              ethAccount,
              token: asset.address,
              symbol: asset.symbol,
              amount: fromUnits,
              approvalRace: asset.quirks.approvalRace,
              lockData: buildLockTokenOpenData(
                secret.hashlock,
                asset.address,
                fromUnits,
                stage.initiatorTimeout,
              ),
              onStage: setStageLabel,
            });
          } else {
            setStageLabel(`Lock ${fromSymbol}`);
            await sendOnLeg(
              leg,
              buildLockNativeOpenData(secret.hashlock, stage.initiatorTimeout),
              fromUnits,
            );
          }
        } catch (lockErr) {
          // A declined wallet signature (ACTION_REJECTED / 4001) provably
          // never broadcast, so nothing can land on-chain: drop the staging
          // record so the maker can simply try again, no recovery banner.
          // Any other failure keeps the record (a broadcast may be pending).
          if (isUserRejection(lockErr)) {
            clearPrelockStage();
            setStaged(null);
          }
          throw lockErr;
        }
        setStageLabel("Confirming the escrow on-chain");
        await waitForEscrow(leg, secret.hashlock);
        setStageLabel("Listing the order");
        await listStagedOrder(stage, ethAccount, qrlAccount);
        return;
      }

      const { order, makerToken, shareToken } = await createOrder({
        direction,
        asset: asset.symbol,
        fromAmount: fromUnits.toString(),
        toAmount: toUnits.toString(),
        makerEthAccount: ethAccount,
        makerQrlAccount: qrlAccount,
        ...(isPrivate
          ? {
              visibility: "private" as const,
              ...(restrictEth ? { allowedTakerEth: restrictEth } : {}),
              ...(restrictQrl ? { allowedTakerQrl: restrictQrl } : {}),
            }
          : {}),
      });
      // Anchor the terms we just posted, not the book's echo of them:
      // MyOrderCard builds the swap from this handle at match time.
      const ref: MyOrderRef = {
        id: order.id,
        token: makerToken,
        asset: asset.symbol,
        fromAmount: fromUnits.toString(),
        toAmount: toUnits.toString(),
        shareToken: shareToken ?? null,
        prelock: null,
      };
      saveMyOrder(ref);
      onPosted(ref);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setStageLabel(null);
      setActivePost(false);
    }
  };

  /** Recovery: list the interrupted stage as an order (escrow must be
   *  Open and unassigned on-chain). */
  const resumeStagedPost = async () => {
    if (!staged || !ethAccount || !qrlAccount) return;
    setError(null);
    setBusy(true);
    try {
      const state = await getLegState(staged.leg, staged.hashlock);
      if (state.status === SwapStatus.None) {
        // A None reading cannot see the mempool, so it cannot tell a
        // rejected lock from one still confirming. Never clear the record
        // here; reveal the explicit discard override instead.
        setNoEscrowSeen(true);
        throw new Error(
          "no escrow is on-chain under this record yet: if you approved the lock, wait for it to confirm and retry; if you rejected it, use Discard record below",
        );
      }
      if (state.status !== SwapStatus.Open) {
        clearPrelockStage();
        setStaged(null);
        throw new Error("the escrow already settled; the stale record was discarded");
      }
      await listStagedOrder(staged, ethAccount, qrlAccount);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /** Recovery: reclaim the interrupted stage's escrow (or discard the
   *  record when nothing ever reached the chain). */
  const releaseStaged = async () => {
    if (!staged) return;
    setError(null);
    setBusy(true);
    try {
      const state = await getLegState(staged.leg, staged.hashlock);
      if (state.status === SwapStatus.Open) {
        setStageLabel("Releasing the escrow");
        await sendOnLeg(staged.leg, buildReleaseData(staged.hashlock), 0n);
        for (let i = 0; i < 40; i += 1) {
          const cur = await getLegState(staged.leg, staged.hashlock).catch(() => null);
          if (cur && cur.status !== SwapStatus.Open) break;
          if (i === 39) throw new Error("release not confirmed yet; try again shortly");
          await sleep(3000);
        }
        // Escrow provably released (funds back in the wallet): record dead.
        clearPrelockStage();
        setStaged(null);
        return;
      }
      if (state.status === SwapStatus.None) {
        // The lock is not on-chain. It may be rejected/never-sent, or it
        // may be broadcast and still confirming (a head read cannot see
        // the mempool, and a pending tx has no inclusion deadline). We
        // cannot tell, so we must NOT delete the record here: reveal the
        // explicit, warned discard override instead.
        setNoEscrowSeen(true);
        throw new Error(
          "no escrow is on-chain under this record: if you approved the lock, it may still be confirming, so wait and retry; if you rejected it, use Discard record below",
        );
      }
      // Already settled (Claimed/Refunded): nothing at stake, record dead.
      clearPrelockStage();
      setStaged(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setStageLabel(null);
    }
  };

  /** Explicit override: drop a staging record whose escrow reads None.
   *  Re-checks the chain first and refuses if an escrow has since appeared
   *  (use Release then); otherwise the warned user consciously accepts the
   *  residual risk that a still-pending lock could mine after the record is
   *  gone. This is the ONLY path that clears a record on a None reading. */
  const discardStagedRecord = () => {
    if (!staged) return;
    if (
      !window.confirm(
        "Discard this record? Only do this if you rejected or never sent the lock transaction. " +
          "If a lock is still confirming, discarding now strands those funds until the 48h timeout " +
          "and you would have to recover the hashlock from your wallet history. Discard anyway?",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    void (async () => {
      const state = await getLegState(staged.leg, staged.hashlock);
      if (state.status === SwapStatus.Open) {
        setNoEscrowSeen(false);
        throw new Error(
          "an escrow is on-chain after all: use Release escrow to reclaim it, do not discard",
        );
      }
      clearPrelockStage();
      setStaged(null);
      setNoEscrowSeen(false);
    })()
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => setBusy(false));
  };

  const assetPicker = (
    <select
      aria-label="Ethereum-leg asset"
      value={assetSymbol}
      onChange={(e) => {
        const next = ethAssetSymbolOrNull(e.target.value);
        if (next !== null) setAssetSymbol(next);
      }}
      className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md border border-border/60 bg-muted/40 px-1.5 py-1 text-sm font-medium text-muted-foreground"
    >
      {ETH_ASSET_SYMBOLS.map((s) => (
        // Option rows live in the native popup, which ignores most CSS;
        // explicit colors (plus :root color-scheme) keep them readable
        // on platforms that render the list themselves.
        <option key={s} value={s} className="bg-popover text-foreground">
          {s}
        </option>
      ))}
    </select>
  );

  const legBox = (
    kind: "You give" | "You want",
    side: "eth" | "qrl",
    value: string,
    setValue: (v: string) => void,
  ) => (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{kind}</span>
        <span>{side === "eth" ? ETH_LEG.name : QRL_LEG.name}</span>
      </div>
      <div className="relative">
        <Input
          inputMode="decimal"
          placeholder={
            side === "eth" ? `min ${trimAmount(asset.minBaseUnits, asset.decimals)}` : "0.0"
          }
          value={value}
          onChange={(e) => {
            const next = e.target.value.replace(",", ".");
            if (next === "" || /^\d*\.?\d*$/.test(next)) setValue(next);
          }}
          className="font-data h-12 pr-20 text-lg"
        />
        {side === "eth" ? (
          assetPicker
        ) : (
          <span className="absolute top-1/2 right-3 -translate-y-1/2 text-sm font-medium text-muted-foreground">
            {QRL_LEG.asset}
          </span>
        )}
      </div>
    </div>
  );

  const stagedAsset = staged ? ETH_ASSETS[staged.asset] : null;
  const stagedAmount =
    staged && stagedAsset
      ? staged.leg === "eth"
        ? `${trimAmount(BigInt(staged.fromAmount), stagedAsset.decimals)} ${stagedAsset.symbol}`
        : `${trimAmount(BigInt(staged.fromAmount), 18)} ${QRL_LEG.asset}`
      : null;

  return (
    <Card className="surface-ember">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xl">Post an order</CardTitle>
          <span className="text-xs text-muted-foreground">HTLC protocol mode</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {staged && !activePost ? (
          <div className="space-y-2 rounded-md border border-amber-400/40 bg-amber-400/10 p-3">
            <p className="text-xs leading-relaxed text-amber-400">
              {stagedChain === "checking"
                ? "Checking a pre-funded post that did not finish…"
                : stagedChain === "open"
                  ? `A pre-funded post did not finish, but your ${stagedAmount ?? "funds"} is escrowed on-chain. Finish listing it, or release the escrow back to your wallet.`
                  : stagedChain === "absent"
                    ? "A pre-funded post did not finish and no escrow is on-chain. If you rejected or never sent the lock, discard this record. If you just approved it, it may still be confirming: re-check in a moment."
                    : `A pre-funded post did not finish (${stagedAmount ?? "funds"}). Re-check the escrow on-chain, then finish listing it or release it.`}{" "}
              This record holds the swap secret; it is kept until you resolve it.
            </p>
            <div className="flex flex-wrap gap-2">
              {/* Adapt to the probed chain state: lead with Release only when
                  an escrow really exists, and with Discard when the lock is
                  absent, instead of making the maker click Release to find
                  out there is nothing there. Resume lists from the staged
                  record's own terms (not the emptied form), so it gates on
                  the wallets alone. */}
              {stagedChain === "open" || stagedChain === "unknown" ? (
                <Button
                  size="sm"
                  disabled={busy || !ethAccount || !qrlAccount}
                  onClick={() => void resumeStagedPost()}
                >
                  Finish posting
                </Button>
              ) : null}
              {stagedChain === "open" || stagedChain === "unknown" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void releaseStaged()}
                >
                  {busy && stageLabel !== null ? `${stageLabel}…` : "Release escrow"}
                </Button>
              ) : null}
              {stagedChain === "absent" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => staged && void probeStaged(staged)}
                >
                  Re-check
                </Button>
              ) : null}
              {noEscrowSeen && stagedChain !== "open" ? (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => discardStagedRecord()}
                >
                  Discard record
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {legBox("You give", direction === "eth->qrl" ? "eth" : "qrl", fromAmount, setFromAmount)}
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="icon"
            aria-label="switch direction"
            onClick={() => {
              setDirection((d) => (d === "eth->qrl" ? "qrl->eth" : "eth->qrl"));
              setFromAmount(toAmount);
              setToAmount(fromAmount);
            }}
          >
            <ArrowDownUp className="h-4 w-4" />
          </Button>
        </div>
        {legBox("You want", direction === "eth->qrl" ? "qrl" : "eth", toAmount, setToAmount)}

        <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Receive {toSymbol} to</span>
            <span className="font-data text-xs text-blue-accent">
              {direction === "eth->qrl"
                ? qrlAccount
                  ? shortAddr(qrlAccount)
                  : "connect QRL wallet"
                : ethAccount
                  ? shortAddr(ethAccount)
                  : "connect ETH wallet"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Timelocks</span>
            <span className="font-data">
              {prefund ? "48h escrow / 1h taker leg" : "2h your leg / 1h taker leg"}
            </span>
          </div>
        </div>

        <div className="space-y-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={prefund}
              onChange={(e) => setPrefund(e.target.checked)}
              className="h-4 w-4 accent-[hsl(var(--primary))]"
            />
            <span className="font-medium">Pre-fund</span>
            <span className="text-xs text-muted-foreground">
              escrow your {fromSymbol} now, release any time
            </span>
          </label>
          {prefund ? (
            <p className="rounded-md border border-border/60 bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">
              Your {fromSymbol} goes into the HTLC escrow immediately (recipient unset), so the
              listing is provably funded and your only step at match time is one cheap assignment
              transaction. Until a taker is assigned you can reclaim the escrow on demand; even if
              you lose this browser&apos;s data, the escrow stays yours and becomes reclaimable
              on-chain after the 48h timeout (from the lock transaction in your wallet history).
            </p>
          ) : null}
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
              className="h-4 w-4 accent-[hsl(var(--primary))]"
            />
            <span className="font-medium">Private swap</span>
            <span className="text-xs text-muted-foreground">
              hidden from the book, shared by link
            </span>
          </label>
          {isPrivate ? (
            <div className="space-y-2 rounded-md border border-border/60 bg-muted/20 p-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                You get a one-off link to hand to your counterparty (OTC style). Optionally
                reserve the order for their addresses; leave blank to let anyone with the link
                take it.
              </p>
              <Input
                placeholder="Taker ETH address (optional, 0x…)"
                value={allowedEth}
                onChange={(e) => setAllowedEth(e.target.value)}
                className="font-data h-9 text-xs"
              />
              <Input
                placeholder="Taker QRL address (optional, Q…)"
                value={allowedQrl}
                onChange={(e) => setAllowedQrl(e.target.value)}
                className="font-data h-9 text-xs"
              />
            </div>
          ) : null}
        </div>

        <Button className="w-full" size="lg" disabled={!ready || busy} onClick={() => void post()}>
          <BookPlus className="h-4 w-4" />
          {!ethAccount || !qrlAccount
            ? "Connect both wallets to post"
            : !(Number(fromAmount) > 0)
              ? `Enter the ${fromSymbol} amount`
              : !(Number(toAmount) > 0)
                ? `Enter the ${toSymbol} amount`
                : busy
                  ? stageLabel !== null
                    ? `${stageLabel}…`
                    : "Posting…"
                  : prefund
                    ? isPrivate
                      ? "Escrow & post private order"
                      : "Escrow & post order"
                    : isPrivate
                      ? "Post private order"
                      : "Post order"}
        </Button>
        {error ? <p className="text-sm break-words text-destructive">{error}</p> : null}
        <p className="text-xs leading-relaxed text-muted-foreground">
          {prefund
            ? "Pre-funding escrows your side up front; everything else still settles atomically through the HTLCs, or refunds after the timelocks."
            : "Posting is free and holds no funds. When a taker accepts, you lock first and the swap settles atomically through the HTLCs, or refunds after the timelocks."}
        </p>
      </CardContent>
    </Card>
  );
}
