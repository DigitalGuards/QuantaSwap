import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Interface } from "ethers";
import {
  DELIVERY_GAS_LIMIT,
  DELIVERY_GAS_RESERVE,
  HTLC_ABI,
  NATIVE_TOKEN,
  QRL_NATIVE_TOKEN,
  SETTLEMENT_GAS_BUFFER,
  assertDeliveryGasPolicy,
  claimCutoffBlocked,
  encodePushCredit,
  encodeWithdrawAll,
  getChainId,
  getCredit,
  getDeliveryGasPolicy,
  settlementGasLimit,
  simulateHtlcCall,
  submitPreflightedClaim,
  type LegRpc,
} from "./htlc.js";
import { encodeQrvmHtlc } from "./qrvmHtlc.js";

const htlcAbi = new Interface(HTLC_ABI);

interface RpcRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params: unknown[];
}

async function withRpcResponse<T>(
  response: Record<string, unknown>,
  run: (requests: RpcRequest[]) => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  const requests: RpcRequest[] = [];
  globalThis.fetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as RpcRequest);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...response }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    return await run(requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const ETH_LEG: LegRpc = {
  url: "https://eth.invalid",
  ns: "eth",
  htlc: `0x${"1".repeat(40)}`,
};
const QRL_LEG: LegRpc = {
  url: "https://qrl.invalid",
  ns: "qrl",
  htlc: `Q${"2".repeat(40)}`,
};

describe("secret-bearing claim preflight", { concurrency: false }, () => {
  it("simulates the exact ETH call from the actual sender at latest", async () => {
    const sender = `0x${"3".repeat(40)}`;
    const claimData = `0x${"ab".repeat(68)}`;
    await withRpcResponse({ result: "0x" }, async (requests) => {
      await simulateHtlcCall(ETH_LEG, sender, claimData, 0n);
      assert.deepEqual(requests, [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [
            { from: sender, to: ETH_LEG.htlc, data: claimData, value: "0x0" },
            "latest",
          ],
        },
      ]);
    });
  });

  it("blocks the legacy Q40 HTLC before a QRL simulation request", async () => {
    const sender = `Q${"4".repeat(128)}`;
    const claimData = `0x${"cd".repeat(68)}`;
    await withRpcResponse({ result: "0x" }, async (requests) => {
      await assert.rejects(simulateHtlcCall(QRL_LEG, sender, claimData), /fresh 64-byte/);
      assert.equal(requests.length, 0);
    });
  });

  it("fails closed and never reflects secret calldata from an RPC error", async () => {
    const claimData = `0x${"ef".repeat(68)}`;
    await withRpcResponse(
      { error: { message: `execution reverted; transaction data=${claimData}` } },
      async (requests) => {
        await assert.rejects(
          simulateHtlcCall(ETH_LEG, `0x${"5".repeat(40)}`, claimData),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, "eth HTLC preflight rejected; claim was not broadcast");
            assert.ok(!error.message.includes(claimData));
            return true;
          },
        );
        assert.equal(requests.length, 1, "preflight performs no send/broadcast RPC");
        assert.equal(requests[0]?.method, "eth_call");
      },
    );
  });

  it("never invokes the broadcast callback when simulation fails", async () => {
    let submissions = 0;
    await withRpcResponse({ error: { message: "execution reverted" } }, async () => {
      await assert.rejects(
        submitPreflightedClaim(
          ETH_LEG,
          `0x${"6".repeat(40)}`,
          `0x${"12".repeat(68)}`,
          async () => {
            submissions += 1;
            return "0xnever";
          },
        ),
        /preflight rejected; claim was not broadcast/,
      );
    });
    assert.equal(submissions, 0);
  });

  it("invokes the broadcast callback exactly once after a successful simulation", async () => {
    let submissions = 0;
    await withRpcResponse({ result: "0x" }, async () => {
      const hash = await submitPreflightedClaim(
        ETH_LEG,
        `0x${"7".repeat(40)}`,
        `0x${"34".repeat(68)}`,
        async () => {
          submissions += 1;
          return "0xtxhash";
        },
      );
      assert.equal(hash, "0xtxhash");
    });
    assert.equal(submissions, 1);
  });

  it("sanitizes submission errors that may reflect claim calldata", async () => {
    const claimData = `0x${"56".repeat(68)}`;
    await withRpcResponse({ result: "0x" }, async () => {
      await assert.rejects(
        submitPreflightedClaim(
          ETH_LEG,
          `0x${"8".repeat(40)}`,
          claimData,
          async () => {
            throw new Error(`send failed with transaction data ${claimData}`);
          },
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(
            error.message,
            "eth claim submission failed; reconcile chain state before retry",
          );
          assert.ok(!error.message.includes(claimData));
          return true;
        },
      );
    });
  });
});

/** getSwap as the ETH leg's HTLC would answer it. */
function swapResult(status: number, timeout: number): string {
  return htlcAbi.encodeFunctionResult("getSwap", [
    [
      `0x${"9".repeat(40)}`,
      `0x${"a".repeat(40)}`,
      `0x${"0".repeat(40)}`,
      1n,
      BigInt(timeout),
      BigInt(status),
      `0x${"0".repeat(64)}`,
    ],
  ]);
}

describe("claim cutoff at broadcast", { concurrency: false }, () => {
  const NOW = 1_800_000_000;
  const MARGIN = 600;
  const hashlock = `0x${"12".repeat(32)}`;

  it("abandons a claim whose escrow deadline moved inside the margin", async () => {
    // FINALITY.md section 3.3: claim() closes at the escrow timeout, so a
    // claim that mines at or after it reverts with the preimage already
    // public. A margin checked when the decision was taken is not a margin
    // at broadcast.
    let submissions = 0;
    await withRpcResponse({ result: swapResult(1, NOW + MARGIN) }, async () => {
      await assert.rejects(
        submitPreflightedClaim(
          ETH_LEG,
          `0x${"7".repeat(40)}`,
          `0x${"34".repeat(68)}`,
          async () => {
            submissions += 1;
            return "0xtxhash";
          },
          { hashlock, marginS: MARGIN, nowS: () => NOW },
        ),
        /abandoned inside the escrow's safety margin/,
      );
    });
    assert.equal(submissions, 0);
  });

  it("broadcasts while the escrow deadline is outside the margin", async () => {
    await withRpcResponse({ result: swapResult(1, NOW + MARGIN + 1) }, async () => {
      assert.equal(
        await submitPreflightedClaim(
          ETH_LEG,
          `0x${"7".repeat(40)}`,
          `0x${"34".repeat(68)}`,
          async () => "0xtxhash",
          { hashlock, marginS: MARGIN, nowS: () => NOW },
        ),
        "0xtxhash",
      );
    });
  });

  it("is the same rule the pure predicate states", () => {
    assert.equal(claimCutoffBlocked(NOW + MARGIN, NOW, MARGIN), true);
    assert.equal(claimCutoffBlocked(NOW + MARGIN + 1, NOW, MARGIN), false);
    assert.equal(claimCutoffBlocked(NOW - 1, NOW, MARGIN), true);
  });
});

describe("HTLCv3 settlement gas rule and payout credits", { concurrency: false }, () => {
  it("adds the delivery budget and the credit reserve to an estimate", () => {
    // docs/audit/HTLCV3_SCOPE.md A1 and A2: a bare estimate lands on the
    // credit path, because crediting is cheaper than a real transfer.
    assert.equal(SETTLEMENT_GAS_BUFFER, DELIVERY_GAS_LIMIT + DELIVERY_GAS_RESERVE);
    assert.equal(SETTLEMENT_GAS_BUFFER, 250_000n);
    assert.equal(settlementGasLimit(37_038n), 287_038n);
  });

  it("reads a credit and the published gas policy on the Ethereum leg", async () => {
    await withRpcResponse(
      { result: htlcAbi.encodeFunctionResult("creditOf", [42n]) },
      async (requests) => {
        assert.equal(await getCredit(ETH_LEG, NATIVE_TOKEN, `0x${"a".repeat(40)}`), 42n);
        assert.equal(requests[0]?.method, "eth_call");
      },
    );
    await withRpcResponse(
      {
        result: htlcAbi.encodeFunctionResult("deliveryGasPolicy", [
          DELIVERY_GAS_LIMIT,
          DELIVERY_GAS_RESERVE,
        ]),
      },
      async () => {
        assert.deepEqual(await getDeliveryGasPolicy(ETH_LEG), {
          gasLimit: DELIVERY_GAS_LIMIT,
          gasReserve: DELIVERY_GAS_RESERVE,
        });
        await assertDeliveryGasPolicy(ETH_LEG);
      },
    );
  });

  it("refuses a contract that publishes a different budget", async () => {
    await withRpcResponse(
      { result: htlcAbi.encodeFunctionResult("deliveryGasPolicy", [1n, 2n]) },
      async () => {
        await assert.rejects(
          assertDeliveryGasPolicy(ETH_LEG),
          /was not written for \(1\/2\); refusing to settle/,
        );
      },
    );
  });

  it("encodes withdrawAll and pushCredit for both legs", () => {
    const account = `0x${"a".repeat(40)}`;
    assert.equal(
      encodeWithdrawAll("eth", NATIVE_TOKEN, account),
      htlcAbi.encodeFunctionData("withdrawAll", [NATIVE_TOKEN, account]),
    );
    assert.equal(
      encodePushCredit("eth", NATIVE_TOKEN, account),
      htlcAbi.encodeFunctionData("pushCredit", [NATIVE_TOKEN, account]),
    );
    const qrlAccount = `Q${"a".repeat(128)}`;
    assert.equal(
      encodeWithdrawAll("qrl", QRL_NATIVE_TOKEN, qrlAccount),
      encodeQrvmHtlc("withdrawAll", [QRL_NATIVE_TOKEN, qrlAccount]),
    );
    // A 64-byte QRL account can never ride in the 20-byte Ethereum codec.
    assert.throws(() => encodeWithdrawAll("eth", NATIVE_TOKEN, qrlAccount));
    assert.throws(() => encodePushCredit("eth", NATIVE_TOKEN, qrlAccount));
  });
});

describe("chain identity RPC", { concurrency: false }, () => {
  it("reads each leg's namespaced chain ID", async () => {
    await withRpcResponse({ result: "0xaa36a7" }, async (requests) => {
      assert.equal(await getChainId(ETH_LEG), "0xaa36a7");
      assert.equal(requests[0]?.method, "eth_chainId");
      assert.deepEqual(requests[0]?.params, []);
    });
  });
});
