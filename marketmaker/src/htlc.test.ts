import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  getChainId,
  simulateHtlcCall,
  submitPreflightedClaim,
  type LegRpc,
} from "./htlc.js";

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

  it("uses the QRL namespace and preserves the actual Q-prefixed sender", async () => {
    const sender = `Q${"4".repeat(40)}`;
    const claimData = `0x${"cd".repeat(68)}`;
    await withRpcResponse({ result: "0x" }, async (requests) => {
      await simulateHtlcCall(QRL_LEG, sender, claimData);
      assert.equal(requests[0]?.method, "qrl_call");
      assert.deepEqual(requests[0]?.params, [
        { from: sender, to: QRL_LEG.htlc, data: claimData, value: "0x0" },
        "latest",
      ]);
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
          QRL_LEG,
          `Q${"8".repeat(40)}`,
          claimData,
          async () => {
            throw new Error(`send failed with transaction data ${claimData}`);
          },
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(
            error.message,
            "qrl claim submission failed; reconcile chain state before retry",
          );
          assert.ok(!error.message.includes(claimData));
          return true;
        },
      );
    });
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
