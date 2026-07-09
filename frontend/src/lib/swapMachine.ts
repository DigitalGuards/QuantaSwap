// Pure derivation of the swap state machine: which of the four steps are
// done, runnable, blocked on verification, or waiting for confirmation
// depth, given the persisted swap and the observed chain state. No IO and
// no React here so the whole matrix (maker/taker/sandbox x chain states)
// is unit-testable; SwapFlow renders what this returns.

import { formatEther } from "ethers";
import { CLAIM_MARGIN_S, legByKey, type LegKey } from "../config";
import { SwapStatus, qToHex, type LegState } from "./htlc";
import { initiatorLeg, responderLeg, type ActiveSwap } from "./activeSwap";

export const ZERO32 = `0x${"0".repeat(64)}`;

export type LegStates = Partial<Record<LegKey, LegState>>;

export const sameAddr = (a: string, b: string): boolean =>
  qToHex(a).toLowerCase() === qToHex(b).toLowerCase();

export type StepKey = "lock-initiator" | "lock-responder" | "claim-responder" | "claim-initiator";

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

export interface SwapMachine {
  iLeg: LegKey;
  rLeg: LegKey;
  steps: [StepModel, StepModel, StepModel, StepModel];
  complete: boolean;
  /** Preimage published on-chain by the responder-leg claim, if any. */
  revealedPreimage: string | null;
  /** Legs this role initiated that are Open and past their timeout. */
  refundableLegs: LegKey[];
  /** The addresses this role agreed to swap with, per chain. */
  ownEth: string;
  ownQrl: string;
  legPlan: Record<LegKey, { recipient: string; amount: bigint }>;
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
  const iCfg = legByKey(iLeg);
  const rCfg = legByKey(rLeg);
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

  const legPlan = {
    [iLeg]: { recipient: addrOn(iLeg, "taker"), amount: BigInt(swap.fromAmount) },
    [rLeg]: { recipient: addrOn(rLeg, "maker"), amount: BigInt(swap.toAmount) },
  } as Record<LegKey, { recipient: string; amount: bigint }>;

  const timeoutOf = (leg: LegKey): number => (leg === iLeg ? initiatorTimeout : responderTimeout);

  // Taker-side verification of the maker's lock before responding with
  // funds. The order book announced the parameters; the chain confirms
  // them. Checked against the confirmation-depth snapshot, not the head:
  // a shallow lock could still be reorged into a different one.
  let initiatorLockIssue: string | null = null;
  if (iConfirmed && iConfirmed.status === SwapStatus.Open) {
    if (!sameAddr(iConfirmed.recipient, legPlan[iLeg].recipient))
      initiatorLockIssue = "its recipient is not your address";
    else if (iConfirmed.amount !== legPlan[iLeg].amount)
      initiatorLockIssue = `it escrows ${formatEther(iConfirmed.amount)} ${iCfg.asset}, not the agreed ${formatEther(legPlan[iLeg].amount)}`;
    else if (iConfirmed.timeout < responderTimeout + CLAIM_MARGIN_S)
      initiatorLockIssue = "its timeout leaves you too little claim window";
  }

  // Maker-side verification of the taker's lock before revealing the
  // secret, against the same confirmation-depth snapshot.
  let responderLockIssue: string | null = null;
  if (rConfirmed && rConfirmed.status === SwapStatus.Open) {
    if (!sameAddr(rConfirmed.recipient, legPlan[rLeg].recipient))
      responderLockIssue = "its recipient is not your address";
    else if (rConfirmed.amount !== legPlan[rLeg].amount)
      responderLockIssue = `it escrows ${formatEther(rConfirmed.amount)} ${rCfg.asset}, not the agreed ${formatEther(legPlan[rLeg].amount)}`;
  }

  const revealedPreimage = rState && rState.preimage !== ZERO32 ? rState.preimage : null;

  const steps: [StepModel, StepModel, StepModel, StepModel] = [
    {
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
      canRun: Boolean(
        swap.preimage &&
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
      canRun: Boolean(
        revealedPreimage &&
          iState &&
          iState.status === SwapStatus.Open &&
          nowS < initiatorTimeout,
      ),
      issue: null,
      awaitingDepth: false,
    },
  ];

  const complete = iState?.status === SwapStatus.Claimed && rState?.status === SwapStatus.Claimed;

  // You can only refund a leg you initiated: refund() pays the locker.
  const myLegs: LegKey[] =
    swap.role === "maker" ? [iLeg] : swap.role === "taker" ? [rLeg] : [iLeg, rLeg];
  const refundableLegs = myLegs.filter(
    (leg) => legs[leg]?.status === SwapStatus.Open && nowS >= timeoutOf(leg),
  );

  return {
    iLeg,
    rLeg,
    steps,
    complete,
    revealedPreimage,
    refundableLegs,
    ownEth: addrOn("eth", swap.role === "taker" ? "taker" : "maker"),
    ownQrl: addrOn("qrl", swap.role === "taker" ? "taker" : "maker"),
    legPlan,
  };
}
