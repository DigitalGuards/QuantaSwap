// Wallet transaction sender for both legs, shared by the swap flow and
// the prelock post flow (which escrows before an order even exists, so it
// cannot live inside SwapFlow). Extracted verbatim from SwapFlow; the
// behavior notes below are load-bearing.

import type { BrowserProvider } from "ethers";
import { ETH_LEG, QRL_LEG, type LegKey } from "../config";
import { allowanceOf, buildApproveData, qrlRpc } from "./htlc";
import type { QrlTransport } from "../hooks/useQrlWallet";

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

export type ClaimSender = (leg: LegKey, data: string, valueWei: bigint) => Promise<void>;

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
      let tx: Record<string, unknown> = {
        from: h.qrlAccount,
        to: QRL_LEG.htlc,
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
        let gasLimit = 1_500_000;
        try {
          const estimated = (await qrlRpc("qrl_estimateGas", [tx])) as string;
          gasLimit = Number((BigInt(estimated) * 130n) / 100n);
        } catch {
          // estimation can fail on some proxies; fall back to a safe limit
        }
        tx = {
          from: h.qrlAccount,
          to: QRL_LEG.htlc,
          value: valueWei.toString(),
          data,
          gas: gasLimit,
          gasLimit,
          type: "0x2",
        };
      }
      await h.qrlRequest({ method: "qrl_sendTransaction", params: [tx] });
    }
  };

/** Send secret-bearing claim calldata only after an exact call from the
 *  actual sender succeeds against the same HTLC. The simulation and send
 *  share one signer/account within this operation. It prevents publishing
 *  a secret when the current payout would revert, while a token issuer or
 *  recipient can still change state between simulation and mining. */
export const makePreflightedClaimSender =
  (h: LegSenderHandles): ClaimSender =>
  async (leg, data, valueWei) => {
    if (leg === "eth") {
      if (!h.browserProvider) throw new Error("Ethereum wallet not connected");
      await h.ensureSepolia();
      const signer = await h.browserProvider.getSigner();
      const from = await signer.getAddress();
      const tx = { to: ETH_LEG.htlc, data, value: valueWei };
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
      try {
        const sent = await signer.sendTransaction(tx);
        await sent.wait();
      } catch {
        throw new Error("Ethereum claim submission failed; check chain state before retrying");
      }
      return;
    }

    if (!h.qrlAccount) throw new Error("QRL wallet not connected");
    const callTx: Record<string, unknown> = {
      from: h.qrlAccount,
      to: QRL_LEG.htlc,
      data,
      ...(valueWei > 0n ? { value: `0x${valueWei.toString(16)}` } : {}),
    };
    try {
      await qrlRpc("qrl_call", [callTx, "latest"]);
    } catch {
      throw new Error("QRL claim preflight rejected; the secret was not submitted");
    }

    let sendTx = callTx;
    if (h.qrlTransport === "extension") {
      // Claims fail closed if strict estimation is unavailable. Falling
      // back after a successful call could still publish a secret in a
      // transaction whose extension-selected gas context cannot execute.
      let estimated: string;
      try {
        estimated = (await qrlRpc("qrl_estimateGas", [callTx])) as string;
      } catch {
        throw new Error("QRL claim gas estimation failed; the secret was not submitted");
      }
      const gasLimit = Number((BigInt(estimated) * 130n) / 100n);
      if (!Number.isSafeInteger(gasLimit) || gasLimit <= 0) {
        throw new Error("QRL claim gas estimate was invalid");
      }
      sendTx = {
        from: h.qrlAccount,
        to: QRL_LEG.htlc,
        value: valueWei.toString(),
        data,
        gas: gasLimit,
        gasLimit,
        type: "0x2",
      };
    }
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
