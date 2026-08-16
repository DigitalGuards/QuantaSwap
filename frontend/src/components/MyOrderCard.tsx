import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUnits } from "ethers";
import type { BrowserProvider } from "ethers";
import {
  ETH_ASSETS,
  INITIATOR_TIMEOUT_S,
  MIN_TAKEABLE_RUNWAY_S,
  QRL_LEG,
  RESPONDER_TIMEOUT_S,
} from "@/config";
import {
  clearActiveSwap,
  clearMyOrder,
  loadActiveSwap,
  loadMyOrder,
  saveActiveSwap,
  saveMyOrder,
  type ActiveSwap,
  type MyOrderRef,
} from "@/lib/activeSwap";
import { generateSecret } from "@/lib/secrets";
import {
  announceHashlock,
  assertMakerOrderProgress,
  assertMakerOrderTerms,
  assertStoredMakerSwapTerms,
  cancelSignedOrder,
  fillOrder,
  getOrder,
  listFillIntents,
  OrderGoneError,
  shareFragment,
  type OrderView,
} from "@/lib/orderbook";
import { cancelOrder, heartbeatOrder } from "@/lib/orderbook";
import {
  cancelDigest as protocolCancelDigest,
  fillDigest as protocolFillDigest,
  intentDigest as protocolIntentDigest,
  signCancelV1,
  signFillV1,
  verifyCancelV1,
  verifyFillV1,
  verifyOrderV1Auth,
  type FillV1Body,
  type SignedFillIntentV1,
} from "@/lib/orderSigning";
import {
  sameSignedIntent,
  selectEarliestFillIntent,
  withOrderSelectionLock,
} from "@/components/signedOrderFlow";
import { SwapStatus, buildReleaseData, getLegState } from "@/lib/htlc";
import { makeLegSender } from "@/lib/legSender";
import { errorMessage } from "@/utils/errorMessage";
import type { QrlTransport } from "@/hooks/useQrlWallet";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/UI/Card";
import { Button } from "@/components/UI/Button";
import { Input } from "@/components/UI/Input";

interface Props {
  myOrder: MyOrderRef;
  /** The maker's connected wallet accounts. The maker's own payout
   *  addresses are anchored to these, never to the order-book response, so
   *  a hostile book cannot redirect the maker's incoming leg (symmetric
   *  with the taker, whose addresses come from its wallet too). */
  ethAccount: string | null;
  qrlAccount: string | null;
  /** Wallet plumbing for the pre-funded escrow's release transaction. */
  browserProvider: BrowserProvider | null;
  ensureSepolia: () => Promise<void>;
  qrlRequest: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  qrlTransport: QrlTransport | null;
  qrlWalletRdns: string | null;
  onMatched: (swap: ActiveSwap) => void;
  onClosed: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SIGNED_FILL_RESPONSE_S = 5 * 60;
const SIGNED_PRELOCK_RUNWAY_S = 9_000;

function assertPortableMakerOrder(
  local: MyOrderRef,
  current: OrderView,
): asserts local is MyOrderRef & {
  direction: NonNullable<MyOrderRef["direction"]>;
  fromAmount: string;
  toAmount: string;
} {
  const prelockMatches =
    local.prelock === null
      ? current.prelocked !== true
      : current.prelocked === true &&
        current.hashlock === local.prelock.hashlock &&
        current.initiatorTimeout === local.prelock.initiatorTimeout;
  if (
    local.direction === null ||
    local.fromAmount === null ||
    local.toAmount === null ||
    current.makerAuth === undefined ||
    current.orderDigest === undefined ||
    !verifyOrderV1Auth(current, Math.floor(Date.now() / 1000), true) ||
    current.id !== local.id ||
    (local.orderDigest !== undefined && current.orderDigest !== local.orderDigest) ||
    (local.orderAuth !== undefined &&
      current.makerAuth.nonce !== local.orderAuth.nonce) ||
    current.direction !== local.direction ||
    (current.asset ?? "ETH") !== local.asset ||
    current.fromAmount !== local.fromAmount ||
    current.toAmount !== local.toAmount ||
    !prelockMatches
  ) {
    throw new Error("The portable order no longer matches its locally saved terms.");
  }
}

function fillDraftMatchesIntent(
  draft: FillV1Body | undefined,
  orderDigest: string,
  selected: SignedFillIntentV1,
): draft is FillV1Body {
  if (draft === undefined) return false;
  return (
    draft.orderDigest === orderDigest &&
    draft.intentDigest === protocolIntentDigest(selected.intent, selected.auth) &&
    draft.takerEthAccount === selected.intent.takerEthAccount &&
    draft.takerQrlAccount === selected.intent.takerQrlAccount &&
    draft.releaseCommitment === selected.intent.releaseCommitment
  );
}

/** The maker's listed order: waits for a taker, then generates the swap
 *  secret, announces the hashlock and hands over to the swap flow. The
 *  secret is persisted locally before the announcement so a mid-flight
 *  crash can never orphan locked funds. */
export function MyOrderCard({
  myOrder,
  ethAccount,
  qrlAccount,
  browserProvider,
  ensureSepolia,
  qrlRequest,
  qrlTransport,
  qrlWalletRdns,
  onMatched,
  onClosed,
}: Props) {
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [terminalProofSaved, setTerminalProofSaved] = useState(
    myOrder.fill !== undefined,
  );
  /** The listing is gone (cancelled or swept) but this is a pre-funded
   *  order: the escrow may still sit on-chain, so the handle must not be
   *  cleared until the funds are released. */
  const [orphaned, setOrphaned] = useState(false);
  const matching = useRef(false);

  const sendOnLeg = useMemo(
    () => makeLegSender({ browserProvider, ensureSepolia, qrlAccount, qrlTransport, qrlRequest }),
    [browserProvider, ensureSepolia, qrlAccount, qrlTransport, qrlRequest],
  );

  // Private orders live behind their share link; the maker's own reads
  // carry the token too (the listing 404s without it).
  const shareUrl =
    myOrder.shareToken === null
      ? null
      : `${window.location.origin}/o/${myOrder.id}${shareFragment(myOrder.shareToken)}`;

  const close = useCallback(() => {
    clearMyOrder();
    onClosed();
  }, [onClosed]);

  const startLegacySwap = useCallback(
    async (current: OrderView) => {
      if (matching.current) return;
      matching.current = true;
      setBusy(true);
      setError(null);
      try {
        assertMakerOrderTerms(myOrder, current);
        if (!current.takerEthAccount || !current.takerQrlAccount) {
          throw new Error("taker addresses missing from the accepted order");
        }
        // Anchor our own payout addresses to the connected wallet, not the
        // book. The book is untrusted; using its value would let it feed us
        // an attacker address that our own secret-reveal gate then verifies
        // against, sending our incoming leg to the attacker.
        if (!ethAccount || !qrlAccount) {
          throw new Error("connect both wallets to start the swap");
        }
        // Reuse a previously generated secret for this order (retry after a
        // lost announce response); generating a fresh one would desync us
        // from whatever the order book already published.
        const stored = loadActiveSwap();
        let swap: ActiveSwap;
        if (stored && stored.role === "maker" && stored.orderId === current.id && stored.hashlock) {
          assertStoredMakerSwapTerms(myOrder, stored);
          swap = stored;
        } else if (myOrder.prelock !== null) {
          // Pre-funded order: the secret and T1 were fixed (and persisted)
          // before the escrow transaction; regenerating either would
          // desync us from the immutable on-chain lock. Only T2 is fresh:
          // the taker's window starts at match.
          const pre = myOrder.prelock;
          const now = Math.floor(Date.now() / 1000);
          if (pre.initiatorTimeout - now < MIN_TAKEABLE_RUNWAY_S) {
            throw new Error(
              "too little time remains on the pre-funded escrow to swap safely; release it and relist",
            );
          }
          swap = {
            role: "maker",
            termsBindingVersion: 1,
            orderId: current.id,
            takerToken: null,
            shareToken: myOrder.shareToken,
            direction: myOrder.direction,
            ethAsset: myOrder.asset,
            fromAmount: myOrder.fromAmount,
            toAmount: myOrder.toAmount,
            makerEthAccount: ethAccount,
            makerQrlAccount: qrlAccount,
            takerEthAccount: current.takerEthAccount,
            takerQrlAccount: current.takerQrlAccount,
            preimage: pre.preimage,
            hashlock: pre.hashlock,
            initiatorTimeout: pre.initiatorTimeout,
            responderTimeout: now + RESPONDER_TIMEOUT_S,
            prelocked: true,
            createdAt: now,
          };
          saveActiveSwap(swap);
        } else {
          const secret = await generateSecret();
          const now = Math.floor(Date.now() / 1000);
          swap = {
            role: "maker",
            termsBindingVersion: 1,
            orderId: current.id,
            takerToken: null,
            shareToken: myOrder.shareToken,
            direction: myOrder.direction,
            // Anchored locally at post time, like the payout addresses.
            // Legacy handles without every economic term fail closed.
            ethAsset: myOrder.asset,
            fromAmount: myOrder.fromAmount,
            toAmount: myOrder.toAmount,
            makerEthAccount: ethAccount,
            makerQrlAccount: qrlAccount,
            takerEthAccount: current.takerEthAccount,
            takerQrlAccount: current.takerQrlAccount,
            preimage: secret.preimage,
            hashlock: secret.hashlock,
            initiatorTimeout: now + INITIATOR_TIMEOUT_S,
            responderTimeout: now + RESPONDER_TIMEOUT_S,
            createdAt: now,
          };
          saveActiveSwap(swap);
        }
        // Consume the maker capability only after the accepted row's
        // parties and terms match both local records.
        assertMakerOrderProgress(myOrder, swap, current);
        let announced: OrderView;
        try {
          announced = await announceHashlock(current.id, {
            token: myOrder.token,
            hashlock: swap.hashlock ?? "",
            initiatorTimeout: swap.initiatorTimeout ?? 0,
            responderTimeout: swap.responderTimeout ?? 0,
          }, myOrder.bookId);
        } catch (err) {
          // The announce may have applied even though we saw an error
          // (lost response, or a 409 on retry). Converge via the book.
          const after = await getOrder(
            current.id,
            myOrder.shareToken ?? undefined,
            myOrder.bookId,
          );
          if (after.status === "open") {
            // The taker released before we announced; nothing published,
            // the listing is back on the book. Drop the provisional swap
            // record (its responder window would be stale by the time the
            // next taker arrives; nothing on-chain references it, and a
            // pre-funded order's secret lives in the order handle) and
            // keep waiting.
            clearActiveSwap();
            matching.current = false;
            return;
          }
          if (!(after.status === "locking" && after.hashlock === swap.hashlock)) throw err;
          announced = after;
        }
        // A release + re-accept between poll and announce must not replace
        // the parties already persisted with the secret. The response is
        // untrusted and has to match the local order, swap, and H/T values.
        assertMakerOrderProgress(myOrder, swap, announced);
        clearMyOrder();
        onMatched(swap);
      } catch (err) {
        matching.current = false;
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [myOrder, ethAccount, qrlAccount, onMatched],
  );

  const startSignedSwap = useCallback(
    async (snapshot: OrderView) => {
      if (matching.current) return;
      matching.current = true;
      setBusy(true);
      setError(null);
      try {
        const matched = await withOrderSelectionLock(snapshot.id, async () => {
          const saved = loadMyOrder();
          if (saved === null || saved.id !== snapshot.id) {
            throw new Error("The local portable-order recovery record is missing.");
          }
          if (!ethAccount || !qrlAccount) {
            throw new Error("Connect both wallets before selecting a fill request.");
          }
          const current = await getOrder(
            saved.id,
            saved.shareToken ?? undefined,
            saved.bookId,
          );
          setOrder(current);
          assertPortableMakerOrder(saved, current);
          const makerAuth = current.makerAuth;
          const currentOrderDigest = current.orderDigest;
          if (makerAuth === undefined || currentOrderDigest === undefined) {
            throw new Error("The portable order proof is incomplete.");
          }
          const savedDirection = saved.direction;
          const savedFromAmount = saved.fromAmount;
          const savedToAmount = saved.toAmount;
          if (
            current.makerEthAccount.toLowerCase() !== ethAccount.toLowerCase() ||
            current.makerQrlAccount.toLowerCase() !== qrlAccount.toLowerCase()
          ) {
            throw new Error("Connect the same maker accounts that authored this OrderV1.");
          }
          if (current.equivocated === true || current.cancelProof !== undefined) {
            throw new Error("Conflicting terminal messages were detected. Funding is blocked.");
          }
          if (current.status === "locking" && saved.fill === undefined) {
            throw new Error(
              "The book has a terminal FillV1 without the matching local signed proof. Funding is blocked.",
            );
          }

          let selected = saved.selectedIntent;
          if (saved.fill === undefined) {
            const intents = await listFillIntents(saved.id, saved.bookId, saved.token);
            const savedStillValid =
              selected === undefined
                ? null
                : selectEarliestFillIntent(current, [selected]);
            selected =
              savedStillValid ?? selectEarliestFillIntent(current, intents) ?? undefined;
          }
          if (selected === undefined) return null;

          const selectedSigned: SignedFillIntentV1 = {
            intent: selected.intent,
            auth: selected.auth,
          };
          const selectedDigest = protocolIntentDigest(
            selectedSigned.intent,
            selectedSigned.auth,
          );
          if (selected.intentDigest !== selectedDigest) {
            throw new Error("The selected FillIntentV1 digest is invalid.");
          }

          const now = Math.floor(Date.now() / 1000);
          let preimage = saved.fillPreimage;
          let draft = saved.fillDraft;
          let respondBy = saved.fillRespondBy;
          const canReuseDraft =
            fillDraftMatchesIntent(draft, currentOrderDigest, selectedSigned) &&
            preimage !== undefined &&
            respondBy !== undefined &&
            Number.isSafeInteger(respondBy) &&
            (saved.fill !== undefined || respondBy - now >= 60);
          if (!canReuseDraft) {
            const secret =
              saved.prelock === null ? await generateSecret() : {
                preimage: saved.prelock.preimage,
                hashlock: saved.prelock.hashlock,
              };
            preimage = secret.preimage;
            const initiatorTimeout =
              saved.prelock === null
                ? now + INITIATOR_TIMEOUT_S
                : saved.prelock.initiatorTimeout;
            if (
              saved.prelock !== null &&
              initiatorTimeout - now < SIGNED_PRELOCK_RUNWAY_S
            ) {
              throw new Error(
                "Too little time remains on the pre-funded escrow for a signed fill.",
              );
            }
            respondBy = Math.min(
              now + SIGNED_FILL_RESPONSE_S,
              makerAuth.expiresAt,
            );
            if (respondBy - now < 60) {
              throw new Error("This OrderV1 expires too soon to publish a safe FillV1.");
            }
            draft = {
              orderDigest: currentOrderDigest,
              intentDigest: selectedDigest,
              takerEthAccount: selected.intent.takerEthAccount,
              takerQrlAccount: selected.intent.takerQrlAccount,
              releaseCommitment: selected.intent.releaseCommitment,
              hashlock: secret.hashlock,
              initiatorTimeout,
              responderTimeout: now + RESPONDER_TIMEOUT_S,
            };
          }
          if (draft === undefined || respondBy === undefined || preimage === undefined) {
            throw new Error("The FillV1 recovery draft is incomplete.");
          }

          const staged: MyOrderRef = {
            ...saved,
            orderAuth: makerAuth,
            orderDigest: currentOrderDigest,
            selectedIntent: selected,
            fillDraft: draft,
            fillRespondBy: respondBy,
            fillPreimage: preimage,
          };
          saveMyOrder(staged);

          const signed =
            staged.fill ??
            (await signFillV1({
              body: draft,
              order: current,
              walletRdns: qrlWalletRdns,
              request: qrlRequest,
              respondBy,
            }));
          const digest = protocolFillDigest(
            signed.fill,
            makerAuth,
            signed.auth,
          );
          if (staged.fillDigest !== undefined && staged.fillDigest !== digest) {
            throw new Error("The saved FillV1 digest does not match its proof.");
          }
          const signedHandle: MyOrderRef = {
            ...staged,
            fill: signed,
            fillDigest: digest,
          };
          saveMyOrder(signedHandle);
          setTerminalProofSaved(true);

          let terminal = current;
          const terminalMatches =
            terminal.status === "locking" &&
            terminal.fill !== undefined &&
            terminal.fillAuth !== undefined &&
            terminal.fillDigest === digest;
          if (!terminalMatches) {
            terminal = await fillOrder(
              signedHandle.id,
              signed,
              selectedSigned,
              signedHandle.bookId,
              signedHandle.token,
            );
            setOrder(terminal);
          }
          if (terminal.released === true) {
            throw new Error(
              "The taker released this fill before funding. This OrderV1 is finished; publish a fresh order.",
            );
          }
          if (
            terminal.status !== "locking" ||
            terminal.equivocated === true ||
            terminal.cancelProof !== undefined ||
            terminal.fill === undefined ||
            terminal.fillAuth === undefined ||
            terminal.selectedIntent === undefined ||
            terminal.fillDigest !== digest ||
            terminal.selectedIntent.intentDigest !== selectedDigest ||
            !sameSignedIntent(terminal.selectedIntent, selectedSigned) ||
            !verifyFillV1(
              terminal.fill,
              terminal.fillAuth,
              terminal,
              selectedSigned,
              { now: Math.floor(Date.now() / 1000), allowExpired: true },
            ) ||
            Math.floor(Date.now() / 1000) >= terminal.fillAuth.expiresAt
          ) {
            throw new Error("The terminal FillV1 response failed local verification.");
          }

          const swap: ActiveSwap = {
            role: "maker",
            termsBindingVersion: 1,
            orderId: terminal.id,
            ...(signedHandle.bookId === undefined
              ? {}
              : { bookId: signedHandle.bookId }),
            orderDigest: currentOrderDigest,
            intent: selectedSigned,
            intentDigest: selectedDigest,
            fill: signed,
            fillDigest: digest,
            takerToken: null,
            shareToken: signedHandle.shareToken,
            direction: savedDirection,
            ethAsset: signedHandle.asset,
            fromAmount: savedFromAmount,
            toAmount: savedToAmount,
            makerEthAccount: ethAccount,
            makerQrlAccount: qrlAccount,
            takerEthAccount: selected.intent.takerEthAccount,
            takerQrlAccount: selected.intent.takerQrlAccount,
            preimage,
            hashlock: signed.fill.hashlock,
            initiatorTimeout: signed.fill.initiatorTimeout,
            responderTimeout: signed.fill.responderTimeout,
            ...(signedHandle.prelock === null ? {} : { prelocked: true }),
            createdAt: signed.auth.issuedAt,
          };
          saveActiveSwap(swap);
          return swap;
        });
        if (matched === null) {
          matching.current = false;
          return;
        }
        clearMyOrder();
        onMatched(matched);
      } catch (err) {
        matching.current = false;
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [ethAccount, qrlAccount, qrlRequest, qrlWalletRdns, onMatched],
  );

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const current = await getOrder(
          myOrder.id,
          myOrder.shareToken ?? undefined,
          myOrder.bookId,
        );
        if (stop) return;
        setOrder(current);
        if (current.makerAuth !== undefined) {
          if (current.status === "open" || current.status === "locking") {
            void startSignedSwap(current);
          }
        } else if (current.status === "accepted") {
          void startLegacySwap(current);
        }
        if (current.status === "cancelled") {
          // A pre-funded handle must survive its listing: clearing it here
          // would delete the preimage while the escrow still sits on-chain.
          if (myOrder.prelock !== null) setOrphaned(true);
          else close();
        }
      } catch (err) {
        if (!stop && err instanceof OrderGoneError) {
          if (myOrder.prelock !== null) setOrphaned(true);
          else close();
        }
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [
    myOrder.id,
    myOrder.shareToken,
    myOrder.bookId,
    startLegacySwap,
    startSignedSwap,
    close,
  ]);

  // Maker liveness: while this card is mounted the listing stays in the
  // takeable set; a closed tab ages out after the book's presence TTL, so
  // takers stop reserving orders whose maker cannot respond.
  useEffect(() => {
    const beat = () =>
      void heartbeatOrder(myOrder.id, myOrder.token, myOrder.bookId).catch(
        () => undefined,
      );
    beat();
    const t = setInterval(beat, 30_000);
    return () => clearInterval(t);
  }, [myOrder.id, myOrder.token, myOrder.bookId]);

  const cancelListing = useCallback(
    async (current?: OrderView): Promise<void> => {
      const saved = loadMyOrder() ?? myOrder;
      const view =
        current ??
        (await getOrder(
          saved.id,
          saved.shareToken ?? undefined,
          saved.bookId,
        ));
      if (view.makerAuth === undefined) {
        await cancelOrder(saved.id, saved.token, saved.bookId);
        return;
      }
      assertPortableMakerOrder(saved, view);
      const makerAuth = view.makerAuth;
      const currentOrderDigest = view.orderDigest;
      if (makerAuth === undefined || currentOrderDigest === undefined) {
        throw new Error("The portable order proof is incomplete.");
      }
      if (saved.fill !== undefined || view.fill !== undefined) {
        throw new Error("A signed FillV1 already exists. This OrderV1 cannot be cancelled.");
      }
      const signed =
        saved.cancel ??
        (await signCancelV1({
          body: { orderDigest: currentOrderDigest, reasonCode: 0 },
          order: view,
          walletRdns: qrlWalletRdns,
          request: qrlRequest,
        }));
      const digest = protocolCancelDigest(
        signed.cancel,
        makerAuth,
        signed.auth,
      );
      if (saved.cancelDigest !== undefined && saved.cancelDigest !== digest) {
        throw new Error("The saved CancelV1 digest does not match its proof.");
      }
      saveMyOrder({ ...saved, cancel: signed, cancelDigest: digest });
      const cancelled = await cancelSignedOrder(
        saved.id,
        signed,
        saved.bookId,
        saved.token,
      );
      if (
        cancelled.cancelDigest !== digest ||
        cancelled.cancelProof === undefined ||
        cancelled.cancelAuth === undefined ||
        !verifyCancelV1(
          cancelled.cancelProof,
          cancelled.cancelAuth,
          cancelled,
          { allowExpired: true },
        )
      ) {
        throw new Error("The CancelV1 response failed local verification.");
      }
    },
    [myOrder, qrlRequest, qrlWalletRdns],
  );

  const cancel = () => {
    setBusy(true);
    setError(null);
    cancelListing(order ?? undefined)
      .then(close)
      .catch((err: unknown) => {
        if (err instanceof OrderGoneError) {
          close();
          return;
        }
        setError(errorMessage(err));
      })
      .finally(() => setBusy(false));
  };

  /** Pre-funded orders: pull the listing AND reclaim the escrow, clearing
   *  the local handle only once the funds have provably left the lock.
   *  Book cancel goes first so no taker reserves a dying listing; a
   *  racing accept is safe because release stays legal until assign. */
  const releaseEscrow = () => {
    const pre = myOrder.prelock;
    if (pre === null) return;
    setBusy(true);
    setError(null);
    void (async () => {
      // Best-effort delist. release() needs nothing from the book, so a
      // book outage (or a hostile 5xx) must not block the on-chain reclaim:
      // swallow every cancel error and proceed. A stale listing is harmless
      // (takers re-verify the escrow on-chain; a released lock can never be
      // assigned).
      if (order?.fill === undefined) {
        await cancelListing(order ?? undefined).catch(() => undefined);
      }
      const state = await getLegState(pre.leg, pre.hashlock);
      if (state.status === SwapStatus.Open) {
        await sendOnLeg(pre.leg, buildReleaseData(pre.hashlock), 0n);
        for (let i = 0; ; i += 1) {
          const cur = await getLegState(pre.leg, pre.hashlock).catch(() => null);
          if (cur && cur.status !== SwapStatus.Open) break;
          if (i >= 39) throw new Error("release broadcast but not confirmed yet; retry shortly");
          await sleep(3000);
        }
      }
      close();
    })()
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => setBusy(false));
  };

  // Amount formatting follows the order's ETH-leg asset (anchored locally
  // in myOrder.asset); the QRL side is always native 18-decimal QRL.
  const asset = ETH_ASSETS[myOrder.asset];
  const sideOf = (leg: "eth" | "qrl") =>
    leg === "eth"
      ? { symbol: asset.symbol, decimals: asset.decimals }
      : { symbol: QRL_LEG.display, decimals: 18 };
  const fromSide = myOrder.direction
    ? sideOf(myOrder.direction === "eth->qrl" ? "eth" : "qrl")
    : null;
  const toSide = myOrder.direction
    ? sideOf(myOrder.direction === "eth->qrl" ? "qrl" : "eth")
    : null;

  return (
    <Card className="surface-ember">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Your open order</CardTitle>
          <span className="font-data text-xs text-muted-foreground">{myOrder.id}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {order && fromSide && toSide && myOrder.fromAmount && myOrder.toAmount ? (
          <p className="text-sm">
            Give <span className="font-data font-medium">{formatUnits(BigInt(myOrder.fromAmount), fromSide.decimals)} {fromSide.symbol}</span>{" "}
            for <span className="font-data font-medium">{formatUnits(BigInt(myOrder.toAmount), toSide.decimals)} {toSide.symbol}</span>
          </p>
        ) : order && myOrder.direction === null ? (
          <p className="text-sm text-destructive">
            This saved order predates local term binding. Cancel or release it and relist.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Loading order…</p>
        )}
        {orphaned ? (
          <div className="space-y-2 rounded-md border border-amber-400/40 bg-amber-400/10 p-3">
            <p className="text-xs leading-relaxed text-amber-400">
              The listing is gone from the book, but your pre-funded escrow may still sit
              on-chain. Release it to reclaim your funds; this handle keeps the swap secret until
              then.
            </p>
            <Button size="sm" variant="outline" disabled={busy} onClick={releaseEscrow}>
              {busy ? "Releasing…" : "Release escrow"}
            </Button>
          </div>
        ) : order?.makerAuth !== undefined && order.status === "locking" && order.released ? (
          <p className="rounded-md border border-amber-400/40 bg-amber-400/10 p-3 text-sm text-amber-400">
            The selected taker released this terminal fill. Do not fund it. Reclaim any unassigned
            pre-funded escrow, then publish a fresh OrderV1.
          </p>
        ) : order?.makerAuth !== undefined ? (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <span
              aria-hidden
              className="glow-dot mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-current text-success"
            />
            <span>
              {order.status === "locking"
                ? "FillV1 published and verified. Preparing the atomic swap."
                : busy
                  ? "Reviewing signed FillIntentV1 requests. Your exact selection is saved before the wallet prompt."
                  : "Portable OrderV1 is live. This browser selects the earliest valid signed request and publishes one terminal FillV1."}
            </span>
          </p>
        ) : order?.status === "accepted" ? (
          <p className="text-sm text-blue-accent">
            {busy ? "Taker found: preparing the swap…" : "Taker found."}
          </p>
        ) : (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <span
              aria-hidden
              className="glow-dot mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-current text-success"
            />
            <span>
              {myOrder.prelock !== null
                ? shareUrl
                  ? "Private pre-funded order: hidden from the book, escrow already on-chain. When your counterparty accepts, you assign them with one transaction."
                  : "Listed pre-funded: your escrow is already on-chain. Keep this page open: when someone accepts, you assign them with one transaction."
                : shareUrl
                  ? "Private order: hidden from the book. Keep this page open: when your counterparty accepts, you lock first."
                  : "Listed on the order book, waiting for a taker. Keep this page open: when someone accepts, you lock first."}
            </span>
          </p>
        )}
        {shareUrl && order?.status === "open" ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={shareUrl}
                onFocus={(e) => e.currentTarget.select()}
                aria-label="Private order share link"
                className="font-data h-8 text-xs"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(shareUrl).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {order.allowedTakerEth || order.allowedTakerQrl
                ? "Anyone with this link can view the order, but only the reserved taker can accept it."
                : "Anyone with this link can take the order; share it only with your counterparty."}
            </p>
          </div>
        ) : null}
        {error ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive">{error}</p>
            {order?.status === "accepted" ||
            (order?.makerAuth !== undefined && order.released !== true) ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    matching.current = false;
                    if (order.makerAuth !== undefined) void startSignedSwap(order);
                    else void startLegacySwap(order);
                  }}
                >
                  Retry
                </Button>
                {/* A prelocked match can wedge here (e.g. the runway floor
                    was crossed between accept and this poll, so startSwap
                    throws every time). Release stays legal until assign, so
                    give the maker the escape the error tells them to use
                    even though the accepted state hides the normal one. */}
                {myOrder.prelock !== null ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={releaseEscrow}>
                    Release escrow &amp; cancel
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {!orphaned &&
        order?.makerAuth !== undefined &&
        order.status === "locking" &&
        order.released ? (
          myOrder.prelock !== null ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={releaseEscrow}>
              {busy ? "Releasing…" : "Release escrow"}
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled={busy} onClick={close}>
              Close finished order
            </Button>
          )
        ) : !orphaned && order?.status === "open" && !terminalProofSaved ? (
          myOrder.prelock !== null ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={releaseEscrow}>
              {busy ? "Releasing…" : "Release escrow & cancel"}
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled={busy} onClick={cancel}>
              Cancel order
            </Button>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}
