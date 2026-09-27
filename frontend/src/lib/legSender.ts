// Wallet transaction sender for both legs, shared by the swap flow and
// the prelock post flow (which escrows before an order even exists, so it
// cannot live inside SwapFlow). Extracted verbatim from SwapFlow; the
// behavior notes below are load-bearing.

import type { BrowserProvider } from "ethers";
import { ETH_LEG, QRL_LEG, type LegKey } from "../config";
import {
  allowanceOf,
  assertDeliveryGasPolicy,
  buildApproveData,
  qrlRpc,
  settlementGasLimit,
} from "./htlc";
import type { QrlTransport } from "../hooks/useQrlWallet";
import { assertQip55ExecutionReady } from "./qip55";
import { assertQrlNetwork } from "./qrlNetwork";

export interface LegSenderHandles {
  browserProvider: BrowserProvider | null;
  ensureSepolia: () => Promise<void>;
  qrlAccount: string | null;
  /** Active QRL transport; the extension needs an explicit gas limit. */
  qrlTransport: QrlTransport | null;
  qrlRequest: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

export type LegSender = (
  leg: LegKey,
  data: string,
  valueWei: bigint,
  ethTo?: string,
) => Promise<void>;

/** A settlement re-checks its own safety immediately before broadcast and
 *  throws to abandon it. Used for the hard claim cutoff of
 *  docs/FINALITY.md section 3.3. */
export type BroadcastGuard = () => Promise<void>;

export type ClaimSender = (
  leg: LegKey,
  data: string,
  valueWei: bigint,
  guard?: BroadcastGuard,
) => Promise<void>;

/** Settlement calldata (claim, refund, release) goes out with
 *  `estimateGas + 250000`: HTLCv3 hands a payout attempt its own bounded
 *  budget and keeps a reserve for the credit fallback, so a bare estimate
 *  defers a payout that would have been delivered. The estimate is per
 *  transport, because only the QRL relay estimates on the wallet's side.
 *  See docs/audit/HTLCV3_SCOPE.md A1 and A2. */
async function estimateQrlSettlementGas(tx: Record<string, unknown>): Promise<bigint> {
  const estimated = (await qrlRpc("qrl_estimateGas", [tx])) as string;
  const gasLimit = settlementGasLimit(BigInt(estimated));
  if (gasLimit <= 0n || gasLimit > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Invalid QRL settlement gas estimate");
  }
  return gasLimit;
}

/** The QRL leg's transaction shape, per transport. The extension does not
 *  estimate: it feeds these fields into @theqrl/web3 signTransaction, whose
 *  legacy branch fails gas validation, so it gets type "0x2" with numeric
 *  gas under both keys and a decimal-string value. The relay wallet does
 *  estimate, and honours an explicit `gas` when one is supplied, which is
 *  how the settlement buffer reaches it. */
function qrlSettlementTx(
  account: string,
  data: string,
  valueWei: bigint,
  transport: QrlTransport | null,
  gasLimit: bigint,
): Record<string, unknown> {
  if (transport === "extension") {
    return {
      from: account,
      to: QRL_LEG.htlc,
      chainId: QRL_LEG.chainIdHex,
      value: valueWei.toString(),
      data,
      gas: Number(gasLimit),
      gasLimit: Number(gasLimit),
      type: "0x2",
    };
  }
  return {
    from: account,
    to: QRL_LEG.htlc,
    chainId: QRL_LEG.chainIdHex,
    data,
    gas: `0x${gasLimit.toString(16)}`,
    ...(valueWei > 0n ? { value: `0x${valueWei.toString(16)}` } : {}),
  };
}

// `ethTo` overrides the ETH-leg target for ERC-20 approve transactions
// (which go to the token contract); everything else goes to the HTLC.
// The QRL leg always targets its HTLC. Return data is never decoded
// (noReturnValue tokens forbid it); success = the receipt confirming
// without revert (tx.wait throws on a reverted receipt).
export const makeLegSender =
  (h: LegSenderHandles): LegSender =>
  async (leg, data, valueWei, ethTo = ETH_LEG.htlc) => {
    if (leg === "eth") {
      if (!h.browserProvider) throw new Error("Ethereum wallet not connected");
      await h.ensureSepolia();
      const signer = await h.browserProvider.getSigner();
      const tx = await signer.sendTransaction({ to: ethTo, data, value: valueWei });
      await tx.wait();
    } else {
      if (!h.qrlAccount) throw new Error("QRL wallet not connected");
      assertQip55ExecutionReady(h.qrlAccount, QRL_LEG.htlc);
      await assertQrlNetwork((method, params) => h.qrlRequest({ method, params }));
      let tx: Record<string, unknown> = {
        from: h.qrlAccount,
        to: QRL_LEG.htlc,
        chainId: QRL_LEG.chainIdHex,
        data,
        ...(valueWei > 0n ? { value: `0x${valueWei.toString(16)}` } : {}),
      };
      if (h.qrlTransport === "extension") {
        // The extension does not estimate gas; it feeds the dApp's fields
        // into @theqrl/web3 0.5 signTransaction. Its legacy (gasPrice)
        // branch fails web3 gas validation, so request type "0x2": the
        // extension then fills maxFee/maxPriorityFee itself, the exact
        // shape its own internal sends use. Numeric gas under both keys,
        // decimal-string value. The relay wallet estimates itself, so it
        // keeps the minimal hex shape.
        const estimated = (await qrlRpc("qrl_estimateGas", [tx])) as string;
        const gasLimit = Number((BigInt(estimated) * 130n) / 100n);
        if (!Number.isSafeInteger(gasLimit) || gasLimit <= 0) throw new Error("Invalid QRL gas estimate");
        tx = {
          from: h.qrlAccount,
          to: QRL_LEG.htlc,
          chainId: QRL_LEG.chainIdHex,
          value: valueWei.toString(),
          data,
          gas: gasLimit,
          gasLimit,
          type: "0x2",
        };
      }
      await assertQrlNetwork((method, params) => h.qrlRequest({ method, params }));
      await h.qrlRequest({ method: "qrl_sendTransaction", params: [tx] });
    }
  };

/** Refund, release and credit-moving calldata. It carries the HTLCv3
 *  settlement gas rule on every transport, because a refund that lands on
 *  the credit path costs the initiator an extra transaction for no reason.
 *  No secret rides here, so there is no preflight and no broadcast guard. */
export const makeSettlementSender =
  (h: LegSenderHandles): LegSender =>
  async (leg, data, valueWei, ethTo = ETH_LEG.htlc) => {
    if (leg === "eth") {
      if (!h.browserProvider) throw new Error("Ethereum wallet not connected");
      await h.ensureSepolia();
      const signer = await h.browserProvider.getSigner();
      const from = await signer.getAddress();
      await assertDeliveryGasPolicy(leg);
      const estimate = await h.browserProvider.estimateGas({
        from,
        to: ethTo,
        data,
        value: valueWei,
      });
      const tx = await signer.sendTransaction({
        to: ethTo,
        data,
        value: valueWei,
        gasLimit: settlementGasLimit(estimate),
      });
      await tx.wait();
      return;
    }
    if (!h.qrlAccount) throw new Error("QRL wallet not connected");
    assertQip55ExecutionReady(h.qrlAccount, QRL_LEG.htlc);
    await assertQrlNetwork((method, params) => h.qrlRequest({ method, params }));
    await assertDeliveryGasPolicy(leg);
    const gasLimit = await estimateQrlSettlementGas({
      from: h.qrlAccount,
      to: QRL_LEG.htlc,
      chainId: QRL_LEG.chainIdHex,
      data,
      ...(valueWei > 0n ? { value: `0x${valueWei.toString(16)}` } : {}),
    });
    await h.qrlRequest({
      method: "qrl_sendTransaction",
      params: [qrlSettlementTx(h.qrlAccount, data, valueWei, h.qrlTransport, gasLimit)],
    });
  };

/** Send secret-bearing claim calldata only after an exact call from the
 *  actual sender succeeds against the same HTLC. The simulation and send
 *  share one signer/account within this operation. It prevents publishing
 *  a secret when the current payout would revert, while a token issuer or
 *  recipient can still change state between simulation and mining.
 *  `guard` runs after the simulation and immediately before the broadcast,
 *  and throwing from it abandons the claim without publishing anything. */
export const makePreflightedClaimSender =
  (h: LegSenderHandles): ClaimSender =>
  async (leg, data, valueWei, guard) => {
    if (leg === "eth") {
      if (!h.browserProvider) throw new Error("Ethereum wallet not connected");
      await h.ensureSepolia();
      const signer = await h.browserProvider.getSigner();
      const from = await signer.getAddress();
      try {
        const result = await h.browserProvider.send("eth_call", [
          { from, to: ETH_LEG.htlc, data, value: `0x${valueWei.toString(16)}` },
          "latest",
        ]);
        if (typeof result !== "string" || !/^0x[0-9a-fA-F]*$/.test(result)) {
          throw new Error("malformed simulation result");
        }
      } catch {
        throw new Error("Ethereum claim preflight rejected; the secret was not submitted");
      }
      // Claims fail closed on estimation: a claim sent without the credit
      // reserve can revert after the preimage check on a token that needs
      // more than a bare estimate.
      await assertDeliveryGasPolicy(leg);
      let estimate: bigint;
      try {
        estimate = await h.browserProvider.estimateGas({
          from,
          to: ETH_LEG.htlc,
          data,
          value: valueWei,
        });
      } catch {
        throw new Error("Ethereum claim gas estimation failed; the secret was not submitted");
      }
      await guard?.();
      try {
        const sent = await signer.sendTransaction({
          to: ETH_LEG.htlc,
          data,
          value: valueWei,
          gasLimit: settlementGasLimit(estimate),
        });
        await sent.wait();
      } catch {
        throw new Error("Ethereum claim submission failed; check chain state before retrying");
      }
      return;
    }

    if (!h.qrlAccount) throw new Error("QRL wallet not connected");
    assertQip55ExecutionReady(h.qrlAccount, QRL_LEG.htlc);
    await assertQrlNetwork((method, params) => h.qrlRequest({ method, params }));
    const callTx: Record<string, unknown> = {
      from: h.qrlAccount,
      to: QRL_LEG.htlc,
      chainId: QRL_LEG.chainIdHex,
      data,
      ...(valueWei > 0n ? { value: `0x${valueWei.toString(16)}` } : {}),
    };
    try {
      const result = await qrlRpc("qrl_call", [callTx, "latest"]);
      if (typeof result !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(result)) throw new Error("Invalid QRL simulation result");
    } catch {
      throw new Error("QRL claim preflight rejected; the secret was not submitted");
    }

    // Claims fail closed if strict estimation is unavailable, on both
    // transports. Falling back after a successful call could still publish
    // a secret in a transaction whose gas context cannot deliver, and the
    // HTLCv3 reserve is only guaranteed to a caller that carries it.
    await assertDeliveryGasPolicy(leg);
    let gasLimit: bigint;
    try {
      gasLimit = await estimateQrlSettlementGas(callTx);
    } catch {
      throw new Error("QRL claim gas estimation failed; the secret was not submitted");
    }
    const sendTx = qrlSettlementTx(
      h.qrlAccount,
      data,
      valueWei,
      h.qrlTransport,
      gasLimit,
    );
    // The network recheck runs before the cutoff guard, so nothing
    // network-bound sits between the guard reading the escrow's deadline and
    // the broadcast: a slow call there would widen the very window the guard
    // exists to close.
    await assertQrlNetwork((method, params) => h.qrlRequest({ method, params }));
    await guard?.();
    try {
      await h.qrlRequest({ method: "qrl_sendTransaction", params: [sendTx] });
    } catch {
      throw new Error("QRL claim submission failed; check chain state before retrying");
    }
  };

/** The exact-amount, USDT-safe ERC-20 lock sequence (up to three
 *  transactions, every send confirmed before the next):
 *  1. read allowance(owner, htlc); equal to the lock amount means a
 *     previous run already approved (crash-resume idempotency): skip
 *     straight to the lock.
 *  2. a stale NONZERO allowance on an approvalRace token (tUSDT) must
 *     be reset with approve(htlc, 0) first, or the next approve reverts.
 *  3. approve(htlc, exact amount), then the lock with value 0 (the
 *     amount rides in calldata and the HTLC pulls via transferFrom).
 *  Every send targets the configured HTLC or the registry token address
 *  only, and approve return data is never decoded (noReturnValue).
 *  `lockData` is the final calldata: classic lockToken for the swap flow,
 *  lockTokenOpen for a prelock. */
export async function sendEthTokenLock(opts: {
  send: LegSender;
  ethAccount: string | null;
  token: string;
  symbol: string;
  amount: bigint;
  /** The asset's approvalRace quirk (see config ETH_ASSETS). */
  approvalRace: boolean;
  lockData: string;
  onStage: (label: string) => void;
}): Promise<void> {
  const { send, ethAccount, token, symbol, amount, approvalRace, lockData, onStage } = opts;
  if (!ethAccount) throw new Error("Ethereum wallet not connected");
  const allowance = await allowanceOf(token, ethAccount, ETH_LEG.htlc);
  const needsApprove = allowance !== amount;
  const needsReset = needsApprove && allowance !== 0n && approvalRace;
  const total = 1 + (needsApprove ? 1 : 0) + (needsReset ? 1 : 0);
  let stepNo = 0;
  const stage = (label: string) => {
    stepNo += 1;
    onStage(total > 1 ? `${label} (${stepNo}/${total})` : label);
  };
  if (needsReset) {
    stage(`Reset ${symbol} approval`);
    await send("eth", buildApproveData(ETH_LEG.htlc, 0n), 0n, token);
  }
  if (needsApprove) {
    stage(`Approve ${symbol}`);
    await send("eth", buildApproveData(ETH_LEG.htlc, amount), 0n, token);
  }
  stage(`Lock ${symbol}`);
  await send("eth", lockData, 0n);
}
