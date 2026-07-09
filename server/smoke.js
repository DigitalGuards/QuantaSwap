// End-to-end smoke test for the order book service: boots the built server
// on a throwaway port + data file and walks the full order lifecycle,
// including the rejections that keep the book clean. Run via `npm test`.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 18000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}/api`;
const dataFile = join(mkdtempSync(join(tmpdir(), "quantaswap-ob-")), "orders.json");

const child = spawn(process.execPath, [new URL("./dist/server.js", import.meta.url).pathname], {
  env: { ...process.env, PORT: String(PORT), ORDERBOOK_DATA: dataFile },
  stdio: ["ignore", "inherit", "inherit"],
});

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL: ${name}`);
  }
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

async function waitForHealth() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become healthy");
}

const ETH_A = `0x${"a".repeat(40)}`;
const ETH_B = `0x${"b".repeat(40)}`;
const QRL_A = `Q${"c".repeat(40)}`;
const QRL_B = `Q${"d".repeat(40)}`;
const ONE_ETH = 10n ** 18n;

try {
  await waitForHealth();
  console.log("lifecycle:");

  const dust = await api("POST", "/orders", {
    direction: "eth->qrl",
    fromAmount: "1000",
    toAmount: ONE_ETH.toString(),
    makerEthAccount: ETH_A,
    makerQrlAccount: QRL_A,
  });
  check("dust amount rejected", dust.status === 400);

  const badAddr = await api("POST", "/orders", {
    direction: "eth->qrl",
    fromAmount: ONE_ETH.toString(),
    toAmount: ONE_ETH.toString(),
    makerEthAccount: "0x1234",
    makerQrlAccount: QRL_A,
  });
  check("bad address rejected", badAddr.status === 400);

  const created = await api("POST", "/orders", {
    direction: "eth->qrl",
    fromAmount: ONE_ETH.toString(),
    toAmount: (ONE_ETH * 2n).toString(),
    makerEthAccount: ETH_A,
    makerQrlAccount: QRL_A,
  });
  check("order created", created.status === 201 && typeof created.body.makerToken === "string");
  const { id } = created.body.order;
  const token = created.body.makerToken;
  check("token not leaked on order", created.body.order.makerTokenHash === undefined);

  const list = await api("GET", "/orders");
  check("order listed while open", list.body.orders.some((o) => o.id === id));

  const earlyHashlock = await api("POST", `/orders/${id}/hashlock`, {
    token,
    hashlock: `0x${"1".repeat(64)}`,
    initiatorTimeout: Math.floor(Date.now() / 1000) + 7200,
    responderTimeout: Math.floor(Date.now() / 1000) + 3600,
  });
  check("hashlock before accept rejected", earlyHashlock.status === 409);

  const accepted = await api("POST", `/orders/${id}/accept`, {
    takerEthAccount: ETH_B,
    takerQrlAccount: QRL_B,
  });
  check("order accepted", accepted.status === 200 && accepted.body.order.status === "accepted");

  const doubleAccept = await api("POST", `/orders/${id}/accept`, {
    takerEthAccount: ETH_B,
    takerQrlAccount: QRL_B,
  });
  check("second accept rejected", doubleAccept.status === 409);

  const wrongToken = await api("POST", `/orders/${id}/hashlock`, {
    token: "f".repeat(64),
    hashlock: `0x${"1".repeat(64)}`,
    initiatorTimeout: Math.floor(Date.now() / 1000) + 7200,
    responderTimeout: Math.floor(Date.now() / 1000) + 3600,
  });
  check("wrong maker token rejected", wrongToken.status === 403);

  const now = Math.floor(Date.now() / 1000);
  const badWindow = await api("POST", `/orders/${id}/hashlock`, {
    token,
    hashlock: `0x${"1".repeat(64)}`,
    initiatorTimeout: now + 4000,
    responderTimeout: now + 3600,
  });
  check("timelock invariant enforced", badWindow.status === 400);

  const locked = await api("POST", `/orders/${id}/hashlock`, {
    token,
    hashlock: `0x${"1".repeat(64)}`,
    initiatorTimeout: now + 7200,
    responderTimeout: now + 3600,
  });
  check("hashlock announced", locked.status === 200 && locked.body.order.status === "locking");

  const fetched = await api("GET", `/orders/${id}`);
  check(
    "taker sees hashlock + timeouts",
    fetched.body.order.hashlock === `0x${"1".repeat(64)}` &&
      fetched.body.order.initiatorTimeout === now + 7200,
  );

  const gone = await api("GET", "/orders");
  check("locking order not listed as open", !gone.body.orders.some((o) => o.id === id));

  const cancelForeign = await api("POST", `/orders/${id}/cancel`, { token: "f".repeat(64) });
  check("cancel with wrong token rejected", cancelForeign.status === 403);

  const cancelled = await api("POST", `/orders/${id}/cancel`, { token });
  check("maker can cancel", cancelled.status === 200 && cancelled.body.order.status === "cancelled");

  const missing = await api("GET", "/orders/0000000000000000");
  check("unknown order 404s", missing.status === 404);
} catch (err) {
  failures += 1;
  console.error("smoke run crashed:", err);
} finally {
  child.kill("SIGTERM");
}

if (failures > 0) {
  console.error(`\n${failures} smoke check(s) failed`);
  process.exit(1);
}
console.log("\nall smoke checks passed");
