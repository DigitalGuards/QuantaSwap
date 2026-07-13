// Pure derivation of the swap state machine: which of the four steps are
// done, runnable, blocked on verification, or waiting for confirmation
// depth, given the persisted swap and the observed chain state. No IO and
// no React here so the whole matrix (maker/taker/sandbox x chain states)
// is unit-testable; SwapFlow renders what this returns.

import { formatUnits } from "ethers";
import { CLAIM_MARGIN_S, ETH_ASSETS, QRL_LEG, type LegKey } from "../config";
import { NATIVE_TOKEN, SwapStatus, qToHex, type LegState } from "./htlc";
import { initiatorLeg, responderLeg, type ActiveSwap } from "./activeSwap";

export const ZERO32 = `0x${"0".repeat(64)}`;

export type LegStates = Partial<Record<LegKey, LegState>>;

export const sameAddr = (a: string, b: string): boolean =>
  qToHex(a).toLowerCase() === qToHex(b).toLowerCase();

export type StepKey =
  | "lock-initiator"
  | "assign-initiator"
  | "lock-responder"
  | "claim-responder"
  | "claim-initiator";

export interface StepModel {
  key: StepKey;
  /** The leg this step's transaction lands on. */
  leg: LegKey;
  /** Whether this browser's role signs this step. */
  own: boolean;
  done: boolean;
  canRun: boolean;
  /** Verification failure on the counterparty lock; own steps only. */
  issue: string | null;
  /** Lock seen at the head but not yet at confirmation depth. */
  awaitingDepth: boolean;
}

/** One leg's agreed terms: recipient and amount fixed at take time, plus
 *  the asset the escrow must hold. `expectedToken` is the address(0)
 *  sentinel for native legs and the registry ERC-20 address otherwise;
 *  counterparty locks are valid ONLY when the on-chain token equals it. */
export interface LegPlan {
  recipient: string;
  /** Base units of this leg's asset. */
  amount: bigint;
  expectedToken: string;
  symbol: string;
  decimals: number;
}

export interface SwapMachine {
  iLeg: LegKey;
  rLeg: LegKey;
  steps: [StepModel, StepModel, StepModel, StepModel];
  complete: boolean;
  /** Preimage published on-chain by the responder-leg claim, if any. */
  revealedPreimage: string | null;
  /** Legs this role initiated that are Open and past their timeout. */
  refundableLegs: LegKey[];
  /** Prelocked swaps only: own open escrow whose recipient is still
   *  unset, reclaimable on demand via release() (assign kills this exit;
   *  the timeout-gated refund then takes over). */
  releasableLegs: LegKey[];
  /** Prelocked swaps only: the initiator escrow is confirmed but its
   *  recipient is not yet assigned at depth. Not a verification failure,
   *  but it blocks the responder lock exactly like one. */
  awaitingAssign: boolean;
  /** Legs this role has escrowed (Open) on-chain right now, refundable or
   *  not; discarding while any are here would strand funds. */
  ownLockedLegs: LegKey[];
  /** The addresses this role agreed to swap with, per chain. */
  ownEth: string;
  ownQrl: string;
  legPlan: Record<LegKey, LegPlan>;
}

export interface SwapMachineInput {
  swap: ActiveSwap;
  /** Chain state at the head, per leg. */
  legs: LegStates;
  /** Chain state `confirmations` blocks behind the head, per leg. */
  confirmed: LegStates;
  nowS: number;
}

// The head sees a lock the confirmed snapshot does not yet: it exists but
// is still shallow enough for a reorg to rewrite.
const awaitingDepth = (latest: LegState | undefined, conf: LegState | undefined): boolean =>
  Boolean(latest && latest.status === SwapStatus.Open && conf?.status !== SwapStatus.Open);

export function deriveSwapMachine(input: SwapMachineInput): SwapMachine | null {
  const { swap, legs, confirmed, nowS } = input;
  const { hashlock, initiatorTimeout, responderTimeout } = swap;
  if (!hashlock || initiatorTimeout === null || responderTimeout === null) return null;

  const iLeg = initiatorLeg(swap.direction);
  const rLeg = responderLeg(swap.direction);
  const iState = legs[iLeg];
  const rState = legs[rLeg];
  const iConfirmed = confirmed[iLeg];
  const rConfirmed = confirmed[rLeg];

  // Which of the four steps this browser drives. In the sandbox one person
  // plays both roles; in a real order-book swap each side only ever signs
  // its own two transactions.
  const mySteps: readonly [boolean, boolean, boolean, boolean] =
    swap.role === "maker"
      ? [true, false, true, false]
      : swap.role === "taker"
        ? [false, true, false, true]
        : [true, true, true, true];

  // Recipients are fixed at lock time and re-checked against chain state
  // before either party commits funds or reveals the secret.
  const addrOn = (leg: LegKey, party: "maker" | "taker"): string =>
    leg === "eth"
      ? party === "maker"
        ? swap.makerEthAccount
        : swap.takerEthAccount
      : party === "maker"
        ? swap.makerQrlAccount
        : swap.takerQrlAccount;

  // The asset each leg must escrow. The QRL leg is always native; the ETH
  // leg's asset comes from the locally persisted swap (agreed at take
  // time), resolved against the compiled-in registry, never from the
  // order book or from chain state.
  const ethAsset = ETH_ASSETS[swap.ethAsset];
  const assetOn = (leg: LegKey): Pick<LegPlan, "expectedToken" | "symbol" | "decimals"> =>
    leg === "eth"
      ? {
          expectedToken: ethAsset.address ?? NATIVE_TOKEN,
          symbol: ethAsset.symbol,
          decimals: ethAsset.decimals,
        }
      : { expectedToken: NATIVE_TOKEN, symbol: QRL_LEG.asset, decimals: 18 };

  const legPlan = {
    [iLeg]: { recipient: addrOn(iLeg, "taker"), amount: BigInt(swap.fromAmount), ...assetOn(iLeg) },
    [rLeg]: { recipient: addrOn(rLeg, "maker"), amount: BigInt(swap.toAmount), ...assetOn(rLeg) },
  } as Record<LegKey, LegPlan>;

  // The token identity check on a counterparty lock. A lockToken() record
  // shares the getSwap struct with lockNative(), so without this a lock
  // paying out the wrong (possibly worthless) asset would pass every
  // recipient/amount check. Fail closed: only the exact expected token
  // (native sentinel or the agreed asset's registry address) is honest.
  const tokenIssue = (confirmedToken: string, plan: LegPlan): string | null => {
    if (sameAddr(confirmedToken, plan.expectedToken)) return null;
    return sameAddr(plan.expectedToken, NATIVE_TOKEN)
      ? `it escrows a token, not native ${plan.symbol}`
      : `it escrows the wrong token contract, not the agreed ${plan.symbol}`;
  };

  // Prelocked swaps: the initiator escrow exists before a recipient does.
  const prelocked = swap.prelocked === true;
  const ZERO_ADDR = `0x${"0".repeat(40)}`;
  const unassigned = (st: LegState): boolean => sameAddr(st.recipient, ZERO_ADDR);

  // An unassigned-at-depth escrow is "waiting for the maker's assign",
  // not a verification failure; but it must block the responder lock
  // exactly like one (the taker only ever commits against a lock whose
  // recipient is themselves, at depth).
  const awaitingAssign =
    prelocked &&
    Boolean(iConfirmed && iConfirmed.status === SwapStatus.Open && unassigned(iConfirmed));

  // Taker-side verification of the maker's lock before responding with
  // funds. The order book announced the parameters; the chain confirms
  // them. Checked against the confirmation-depth snapshot, not the head:
  // a shallow lock could still be reorged into a different one.
  const iPlan = legPlan[iLeg];
  let initiatorLockIssue: string | null = null;
  if (iConfirmed && iConfirmed.status === SwapStatus.Open && !awaitingAssign) {
    const badToken = tokenIssue(iConfirmed.token, iPlan);
    if (badToken !== null) initiatorLockIssue = badToken;
    else if (!sameAddr(iConfirmed.recipient, iPlan.recipient))
      initiatorLockIssue = "its recipient is not your address";
    else if (iConfirmed.amount !== iPlan.amount)
      initiatorLockIssue = `it escrows ${formatUnits(iConfirmed.amount, iPlan.decimals)} ${iPlan.symbol}, not the agreed ${formatUnits(iPlan.amount, iPlan.decimals)}`;
    else if (iConfirmed.timeout < responderTimeout + CLAIM_MARGIN_S)
      initiatorLockIssue = "its timeout leaves you too little claim window";
  }

  // Maker-side verification of the taker's lock before revealing the
  // secret, against the same confirmation-depth snapshot. The timeout is
  // read from the taker's ACTUAL on-chain lock, not the responderTimeout we
  // announced: a hostile taker can lock a valid-looking leg (right
  // recipient, right amount) with a near-term timeout, so revealing on the
  // announced window would publish the secret into a claim that expires
  // before it mines, letting the taker refund and then claim our leg. We
  // require the same CLAIM_MARGIN_S cushion the taker uses on our lock.
  const rPlan = legPlan[rLeg];
  let responderLockIssue: string | null = null;
  if (rConfirmed && rConfirmed.status === SwapStatus.Open) {
    const badToken = tokenIssue(rConfirmed.token, rPlan);
    if (badToken !== null) responderLockIssue = badToken;
    else if (!sameAddr(rConfirmed.recipient, rPlan.recipient))
      responderLockIssue = "its recipient is not your address";
    else if (rConfirmed.amount !== rPlan.amount)
      responderLockIssue = `it escrows ${formatUnits(rConfirmed.amount, rPlan.decimals)} ${rPlan.symbol}, not the agreed ${formatUnits(rPlan.amount, rPlan.decimals)}`;
    else if (rConfirmed.timeout < nowS + CLAIM_MARGIN_S)
      responderLockIssue = "its timeout leaves too little window to reveal the secret safely";
  }

  const revealedPreimage = rState && rState.preimage !== ZERO32 ? rState.preimage : null;

  // For a prelocked swap the initiator escrow predates the match: the
  // maker's only match-time transaction on this leg is the one-time
  // assign(). Its `done` is judged at confirmation depth like every fact
  // the taker acts on irreversibly (a shallow assign can still reorg
  // into a different recipient; write-once holds per canonical chain).
  const assignStep: StepModel = {
    key: "assign-initiator",
    leg: iLeg,
    own: mySteps[0],
    done: Boolean(
      iConfirmed && iConfirmed.status !== SwapStatus.None && !unassigned(iConfirmed),
    ),
    // Assigning while the shared hashlock is already used on the
    // responder chain would trade the maker's on-demand release for a
    // forced wait until T1 (release dies with assign, and a dust squat
    // over there costs an attacker almost nothing), so the gate requires
    // a clean responder leg and fails closed while it is unknown.
    canRun: Boolean(
      iState &&
        iState.status === SwapStatus.Open &&
        unassigned(iState) &&
        rState &&
        rState.status === SwapStatus.None &&
        nowS < responderTimeout,
    ),
    issue:
      mySteps[0] &&
      iState &&
      iState.status === SwapStatus.Open &&
      unassigned(iState) &&
      rState &&
      rState.status !== SwapStatus.None
        ? "the hashlock is already used on the responder chain; release your escrow and relist"
        : null,
    awaitingDepth: Boolean(
      iState &&
        iState.status === SwapStatus.Open &&
        !unassigned(iState) &&
        !(iConfirmed && iConfirmed.status === SwapStatus.Open && !unassigned(iConfirmed)),
    ),
  };

  const steps: [StepModel, StepModel, StepModel, StepModel] = [
    prelocked
      ? assignStep
      : {
          key: "lock-initiator",
          leg: iLeg,
          own: mySteps[0],
          done: Boolean(iState && iState.status !== SwapStatus.None),
          canRun: Boolean(iState && iState.status === SwapStatus.None),
          issue: null,
          awaitingDepth: false,
        },
    {
      key: "lock-responder",
      leg: rLeg,
      own: mySteps[1],
      done: Boolean(rState && rState.status !== SwapStatus.None),
      canRun: Boolean(
        iConfirmed &&
          iConfirmed.status === SwapStatus.Open &&
          !initiatorLockIssue &&
          !awaitingAssign &&
          rState &&
          rState.status === SwapStatus.None &&
          nowS < responderTimeout,
      ),
      issue: mySteps[1] ? initiatorLockIssue : null,
      awaitingDepth: Boolean(
        rState && rState.status === SwapStatus.None && awaitingDepth(iState, iConfirmed),
      ),
    },
    {
      key: "claim-responder",
      leg: rLeg,
      own: mySteps[2],
      done: Boolean(rState && rState.status === SwapStatus.Claimed),
      // Never reveal the secret before our own leg is locked (iState Open)
      // and never without a real claim margin on the taker's on-chain
      // timeout (folded into responderLockIssue). responderTimeout is kept
      // only as a secondary cap. On a prelocked swap, additionally never
      // reveal while our escrow is unassigned: with the preimage public,
      // an unassigned lock could still be release()d, which would take
      // both sides (the taker's gate makes this unreachable for an honest
      // taker; this closes it for buggy counterclients too).
      canRun: Boolean(
        swap.preimage &&
          iState &&
          iState.status === SwapStatus.Open &&
          (!prelocked || !unassigned(iState)) &&
          rConfirmed &&
          rConfirmed.status === SwapStatus.Open &&
          !responderLockIssue &&
          nowS < responderTimeout,
      ),
      issue: mySteps[2] ? responderLockIssue : null,
      awaitingDepth: Boolean(
        rState && rState.status !== SwapStatus.Claimed && awaitingDepth(rState, rConfirmed),
      ),
    },
    {
      key: "claim-initiator",
      leg: iLeg,
      own: mySteps[3],
      done: Boolean(iState && iState.status === SwapStatus.Claimed),
      // Gate on the initiator lock's OWN on-chain timeout, not the
      // book-announced initiatorTimeout: a maker can announce a long window
      // but lock a near-term one, and claim() reverts TimeoutPassed once the
      // real deadline passes, so trusting the announced value would tell the
      // taker a closed claim window is still open after the secret is public.
      // An unassigned prelocked escrow has no claim target yet (the
      // contract reverts NotAssigned), so nothing to offer either.
      canRun: Boolean(
        revealedPreimage &&
          iState &&
          iState.status === SwapStatus.Open &&
          (!prelocked || !unassigned(iState)) &&
          nowS < iState.timeout,
      ),
      issue: null,
      awaitingDepth: false,
    },
  ];

  const complete = iState?.status === SwapStatus.Claimed && rState?.status === SwapStatus.Claimed;

  // You can only refund a leg you initiated: refund() pays the locker. The
  // deadline comes from the leg's ACTUAL on-chain timeout (a third party
  // could front-run the hashlock with a different one), not the announced
  // value; on the honest path they are identical.
  const myLegs: LegKey[] =
    swap.role === "maker" ? [iLeg] : swap.role === "taker" ? [rLeg] : [iLeg, rLeg];
  const ownLockedLegs = myLegs.filter((leg) => legs[leg]?.status === SwapStatus.Open);
  const refundableLegs = ownLockedLegs.filter((leg) => {
    const state = legs[leg];
    return state !== undefined && nowS >= state.timeout;
  });
  // Release needs no timeout, only an own open escrow still unassigned.
  const releasableLegs = !prelocked
    ? []
    : ownLockedLegs.filter((leg) => {
        const state = legs[leg];
        return state !== undefined && unassigned(state);
      });

  return {
    iLeg,
    rLeg,
    steps,
    complete,
    revealedPreimage,
    refundableLegs,
    releasableLegs,
    awaitingAssign,
    /** My legs currently Open (escrowed) on-chain: discarding the swap
     *  while any are here strands funds, since discard deletes the hashlock
     *  and preimage the refund/claim path needs. */
    ownLockedLegs,
    ownEth: addrOn("eth", swap.role === "taker" ? "taker" : "maker"),
    ownQrl: addrOn("qrl", swap.role === "taker" ? "taker" : "maker"),
    legPlan,
  };
}
