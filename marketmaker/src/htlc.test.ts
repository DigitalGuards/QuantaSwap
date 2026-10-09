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
  creditFilterTopics,
  decodeCreditedAmount,
  encodePushCredit,
  encodeWithdrawAll,
  getChainId,
  getBlockNumber,
  getSwapState,
  rpc,
  getCredit,
  getDeliveryGasPolicy,
  isContractRejection,
  settlementGasLimit,
  simulateHtlcCall,
  submitPreflightedClaim,
  type LegRpc,
} from "./htlc.js";
import {
  ContractExecutionError,
  Eip838ExecutionError,
  TransactionRevertInstructionError,
  TransactionRevertedWithoutReasonError,
} from "@theqrl/web3-errors";
import { encodeQrvmHtlc } from "./qrvmHtlc.js";

/** True when a string carries none of the textual revert hints, so a test can
 *  prove a structural classification did the work. */
const REJECTION_HINTS_ABSENT = (message: string): boolean =>
  !/revert|status 0|nocredit|insufficientcredit|transferfailed|invalidparams|unauthorized|out of gas/i.test(
    message,
  );

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
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as RpcRequest);
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, ...response }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };
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
      await assert.rejects(
        simulateHtlcCall(QRL_LEG, sender, claimData),
        /fresh 64-byte/,
      );
      assert.equal(requests.length, 0);
    });
  });

  it("fails closed and never reflects secret calldata from an RPC error", async () => {
    const claimData = `0x${"ef".repeat(68)}`;
    await withRpcResponse(
      {
        error: { message: `execution reverted; transaction data=${claimData}` },
      },
      async (requests) => {
        await assert.rejects(
          simulateHtlcCall(ETH_LEG, `0x${"5".repeat(40)}`, claimData),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(
              error.message,
              "eth HTLC preflight rejected; claim was not broadcast",
            );
            assert.ok(!error.message.includes(claimData));
            return true;
          },
        );
        assert.equal(
          requests.length,
          1,
          "preflight performs no send/broadcast RPC",
        );
        assert.equal(requests[0]?.method, "eth_call");
      },
    );
  });

  it("never invokes the broadcast callback when simulation fails", async () => {
    let submissions = 0;
    await withRpcResponse(
      { error: { message: "execution reverted" } },
      async () => {
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
      },
    );
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
    await withRpcResponse(
      { result: swapResult(1, NOW + MARGIN + 1) },
      async () => {
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
      },
    );
  });

  it("is the same rule the pure predicate states", () => {
    assert.equal(claimCutoffBlocked(NOW + MARGIN, NOW, MARGIN), true);
    assert.equal(claimCutoffBlocked(NOW + MARGIN + 1, NOW, MARGIN), false);
    assert.equal(claimCutoffBlocked(NOW - 1, NOW, MARGIN), true);
  });
});

describe(
  "HTLCv3 settlement gas rule and payout credits",
  { concurrency: false },
  () => {
    it("adds the delivery budget and the credit reserve to an estimate", () => {
      // docs/audit/HTLCV3_SCOPE.md A1 and A2: a bare estimate lands on the
      // credit path, because crediting is cheaper than a real transfer.
      assert.equal(
        SETTLEMENT_GAS_BUFFER,
        DELIVERY_GAS_LIMIT + DELIVERY_GAS_RESERVE,
      );
      assert.equal(SETTLEMENT_GAS_BUFFER, 250_000n);
      assert.equal(settlementGasLimit(37_038n), 287_038n);
    });

    it("reads a credit and the published gas policy on the Ethereum leg", async () => {
      await withRpcResponse(
        { result: htlcAbi.encodeFunctionResult("creditOf", [42n]) },
        async (requests) => {
          assert.equal(
            await getCredit(ETH_LEG, NATIVE_TOKEN, `0x${"a".repeat(40)}`),
            42n,
          );
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
  },
);

describe("PayoutCredited filter widths", { concurrency: false }, () => {
  // Pinned against a real HTLCv3 log on the private QRL v3 devnet, tx
  // 0x3791b66310c199f9807e12b5c8a0794e57b3df4f4e87dae95305d1e86dcab6a3. Every
  // QRVM-512 topic is a 64-byte word: a 32-byte value sits in the high half,
  // an address fills the word. A topic built the Ethereum way matches nothing,
  // and a filter that matches nothing reads as a delivered payout.
  const accountHex =
    "64f616d40a895750df633414e9dafad5426444fcd5acec79e01640a1278648c8" +
    "b949633f721a2503dc54c51026f3ea08e5123faa5b2e458d412c3dc822af900f";
  const hashlock =
    "0xcf36ed676a65c67d7a9cb2bdb006cdf1fc116bb305ca283f538256ba4ca3e1b9";

  it("matches the topics of a real devnet log", () => {
    const topics = creditFilterTopics(
      "qrl",
      QRL_NATIVE_TOKEN,
      `Q${accountHex.toUpperCase()}`,
      hashlock,
    );
    assert.deepEqual(topics, [
      `0xf2697db9906dec024a78bb07c851ec99b2ff405724ae7ed468537578f6030109${"0".repeat(64)}`,
      `0x${"0".repeat(128)}`,
      `0x${accountHex}`,
      `0x${hashlock.slice(2)}${"0".repeat(64)}`,
    ]);
    for (const topic of topics) assert.equal(topic.length, 2 + 128);
  });

  it("uses Ethereum widths on the Ethereum leg", () => {
    const topics = creditFilterTopics(
      "eth",
      NATIVE_TOKEN,
      `0x${"a".repeat(40)}`,
      hashlock,
    );
    for (const topic of topics) assert.equal(topic.length, 2 + 64);
    assert.equal(topics[2], `0x${"0".repeat(24)}${"a".repeat(40)}`);
    assert.equal(topics[3], hashlock);
  });

  it("decodes one data word per target and refuses any other width", () => {
    assert.equal(
      decodeCreditedAmount(
        "qrl",
        `0x${11000n.toString(16).padStart(128, "0")}`,
      ),
      11000n,
    );
    assert.equal(
      decodeCreditedAmount("eth", `0x${11000n.toString(16).padStart(64, "0")}`),
      11000n,
    );
    assert.equal(
      decodeCreditedAmount("qrl", `0x${11000n.toString(16).padStart(64, "0")}`),
      null,
    );
    assert.equal(decodeCreditedAmount("eth", "0x"), null);
  });
});

describe("credit failure classification", { concurrency: false }, () => {
  // Only the contract refusing a call counts towards giving up on a credit.
  // Counting a timeout or an unreachable node would park real money for a
  // reason that says nothing about whether the credit can move, and missing a
  // real refusal lets one unpayable payee pin an order forever.
  it("counts a refusal reported as plain text", () => {
    for (const message of [
      "execution reverted",
      "execution reverted: TransferFailed",
      "eth claim submission failed: reverted",
      "NoCredit()",
      "InsufficientCredit",
      "transaction failed with status 0",
    ]) {
      assert.equal(isContractRejection(new Error(message)), true, message);
    }
  });

  it("counts the @theqrl/web3 revert shapes, whose own message says nothing", () => {
    // ContractExecutionError.message is the generic "Error happened while
    // trying to execute a function inside a smart contract"; the reason lives
    // under innerError. Reading the outer message alone classified every QRL
    // revert as transient, so the cap never filled on that leg.
    const contractError = new ContractExecutionError({
      code: 3,
      message: "execution reverted",
      data: "0xb5d5b5ba",
    });
    assert.match(
      contractError.message,
      /Error happened while trying to execute/,
    );
    assert.equal(
      REJECTION_HINTS_ABSENT(contractError.message),
      true,
      "the outer message must carry no revert hint, or this test proves nothing",
    );
    assert.equal(isContractRejection(contractError), true);

    assert.equal(
      isContractRejection(
        new Eip838ExecutionError({ code: 3, message: "execution reverted" }),
      ),
      true,
    );
    assert.equal(
      isContractRejection(
        new TransactionRevertInstructionError("reverted", "0xb5d5b5ba", {
          status: "0x0",
        }),
      ),
      true,
    );
    assert.equal(
      isContractRejection(
        new TransactionRevertedWithoutReasonError({ status: "0x0" }),
      ),
      true,
    );
  });

  it("counts the ethers revert shape", () => {
    // ethers reports a revert as code CALL_EXCEPTION, sometimes with the
    // provider's own error nested under info.
    assert.equal(
      isContractRejection({ code: "CALL_EXCEPTION", shortMessage: "" }),
      true,
    );
    assert.equal(
      isContractRejection({
        code: "UNKNOWN_ERROR",
        info: { error: { code: 3, data: "0xb5d5b5ba" } },
      }),
      true,
    );
    assert.equal(
      isContractRejection({ message: "", receipt: { status: 0n } }),
      true,
    );
  });

  it("does not count a fault that never reached the contract", () => {
    for (const message of [
      "qrl sendTransaction timed out after 180000ms",
      "connect ECONNREFUSED",
      "fetch failed",
      "RPC eth_call failed: HTTP 502",
      "HTTP 429 rate limit",
      "nonce too low",
      "replacement transaction underpriced",
      "socket hang up",
      "The operation was aborted",
      "connection not open",
      "something nobody has seen before",
    ]) {
      assert.equal(isContractRejection(new Error(message)), false, message);
    }
    // A timeout inside a contract call is still a timeout, however it is
    // wrapped: the transient shapes are read over the whole chain first.
    const wrapped = new ContractExecutionError({
      code: 3,
      message: "request timed out",
    });
    assert.equal(isContractRejection(wrapped), false);
  });

  it("walks a bounded chain and survives a cycle", () => {
    const deep = {
      message: "",
      cause: { message: "", cause: new Error("execution reverted") },
    };
    assert.equal(isContractRejection(deep), true);
    const cyclic: Record<string, unknown> = { message: "unclear" };
    cyclic["cause"] = cyclic;
    assert.equal(isContractRejection(cyclic), false);
    // Past the depth bound nothing is read, which fails to the safe side.
    let buried: unknown = new Error("execution reverted");
    for (let i = 0; i < 10; i += 1) buried = { message: "", cause: buried };
    assert.equal(isContractRejection(buried), false);
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

describe("untrusted RPC and ABI results", { concurrency: false }, () => {
  it("rejects absent results and malformed error objects", async () => {
    for (const response of [{}, { error: [] }, { error: "failure" }]) {
      await withRpcResponse(response, async () => {
        await assert.rejects(rpc(ETH_LEG.url, "eth_call", []), TypeError);
      });
    }
  });

  it("rejects non-hex and unsafe block heights", async () => {
    for (const result of [
      null,
      {},
      [],
      true,
      42,
      "",
      "42",
      "0x20000000000000",
    ]) {
      await withRpcResponse({ result }, async () => {
        await assert.rejects(getBlockNumber(ETH_LEG), TypeError);
      });
    }
    await withRpcResponse({ result: "0x2a" }, async () => {
      assert.equal(await getBlockNumber(ETH_LEG), 42);
    });
  });

  it("preserves every valid EVM status and refuses unknown statuses or unsafe timeouts", async () => {
    for (const status of [0, 1, 2, 3]) {
      await withRpcResponse(
        { result: swapResult(status, 1_800_000_000) },
        async () => {
          const swap = await getSwapState(ETH_LEG, `0x${"1".repeat(64)}`);
          assert.equal(swap.status, status);
          assert.equal(swap.amount, 1n);
          assert.equal(swap.timeout, 1_800_000_000);
        },
      );
    }
    for (const result of [
      swapResult(4, 100),
      swapResult(1, Number.MAX_SAFE_INTEGER + 1),
    ]) {
      await withRpcResponse({ result }, async () => {
        await assert.rejects(
          getSwapState(ETH_LEG, `0x${"1".repeat(64)}`),
          TypeError,
        );
      });
    }
  });
});
