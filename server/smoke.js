// End-to-end smoke test for the order book service: boots the built server
// on a throwaway port + data file and walks the full order lifecycle,
// including the rejections that keep the book clean. Run via `npm test`.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 18000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}/api`;
const dataFile = join(mkdtempSync(join(tmpdir(), "quantaswap-ob-")), "orders.json");

// PRESENCE_TTL_S=1 so maker-presence expiry is testable with a short sleep.
const child = spawn(process.execPath, [new URL("./dist/server.js", import.meta.url).pathname], {
  env: { ...process.env, PORT: String(PORT), ORDERBOOK_DATA: dataFile, PRESENCE_TTL_S: "1" },
  stdio: ["ignore", "inherit", "inherit"],
});

/** Second instance for the legacy-persistence section; spawned late,
 *  killed in the shared finally. */
let child2 = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL: ${name}`);
  }
}

async function api(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

async function waitForHealth(base = BASE) {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`${base}/health`);
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
  check("asset-less create defaults to ETH", created.body.order.asset === "ETH");

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
  check("accept mints a taker token", typeof accepted.body.takerToken === "string");
  check("taker token not leaked on order", accepted.body.order.takerTokenHash === undefined);

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

  console.log("per-IP take caps:");
  // Distinct forged IPs per role; the loopback socket is trusted for
  // proxy headers, which is exactly how nginx fronts this in prod.
  const makerHdr = { "X-Forwarded-For": "203.0.113.100" };
  const taker = { takerEthAccount: ETH_B, takerQrlAccount: QRL_B };
  const mk = async () => {
    const r = await api(
      "POST",
      "/orders",
      {
        direction: "eth->qrl",
        fromAmount: ONE_ETH.toString(),
        toAmount: ONE_ETH.toString(),
        makerEthAccount: ETH_A,
        makerQrlAccount: QRL_A,
      },
      makerHdr,
    );
    return { id: r.body.order.id, token: r.body.makerToken };
  };

  // Mirror MAX_CONCURRENT_TAKES_PER_IP / MAX_TAKES_PER_IP_PER_DAY in
  // src/store.ts; keep in sync.
  const CONCURRENT_CAP = 4;
  const DAILY_CAP = 24;

  const greedy = { "X-Forwarded-For": "203.0.113.7" };
  const opens = [];
  for (let i = 0; i <= CONCURRENT_CAP; i += 1) opens.push(await mk());
  let greedyOk = true;
  for (let i = 0; i < CONCURRENT_CAP; i += 1) {
    const took = await api("POST", `/orders/${opens[i].id}/accept`, taker, greedy);
    greedyOk = greedyOk && took.status === 200;
  }
  check(`${CONCURRENT_CAP} concurrent takes allowed`, greedyOk);
  const over = await api("POST", `/orders/${opens[CONCURRENT_CAP].id}/accept`, taker, greedy);
  check("take past the concurrency cap rejected", over.status === 429);
  const other = await api("POST", `/orders/${opens[CONCURRENT_CAP].id}/accept`, taker, {
    "X-Forwarded-For": "203.0.113.8",
  });
  check("other visitors can still take", other.status === 200);

  const drip = { "X-Forwarded-For": "203.0.113.9" };
  let dripOk = true;
  for (let i = 0; i < DAILY_CAP; i += 1) {
    // Unique maker IP per lap: DAILY_CAP create+cancel pairs from a single
    // IP would trip the per-minute mutation window before the take cap.
    const dripMaker = { "X-Forwarded-For": `203.0.114.${i + 1}` };
    const posted = await api(
      "POST",
      "/orders",
      {
        direction: "eth->qrl",
        fromAmount: ONE_ETH.toString(),
        toAmount: ONE_ETH.toString(),
        makerEthAccount: ETH_A,
        makerQrlAccount: QRL_A,
      },
      dripMaker,
    );
    const o = { id: posted.body.order.id, token: posted.body.makerToken };
    const took = await api("POST", `/orders/${o.id}/accept`, taker, drip);
    dripOk = dripOk && took.status === 200;
    await api("POST", `/orders/${o.id}/cancel`, { token: o.token }, dripMaker);
  }
  check(`${DAILY_CAP} spaced takes allowed`, dripOk);
  const oOver = await mk();
  const tOver = await api("POST", `/orders/${oOver.id}/accept`, taker, drip);
  check("take past the daily cap rejected", tOver.status === 429);

  console.log("taker release:");
  const walker = { "X-Forwarded-For": "203.0.113.20" };
  const held = [];
  for (let i = 0; i < CONCURRENT_CAP; i += 1) held.push(await mk());
  const takes = [];
  for (const o of held) {
    takes.push(await api("POST", `/orders/${o.id}/accept`, taker, walker));
  }
  const [r1, r2] = held;
  const [w1, w2] = takes;
  const r3 = await mk();
  const blocked = await api("POST", `/orders/${r3.id}/accept`, taker, walker);
  check("slots full before release", blocked.status === 429);

  const badRelease = await api("POST", `/orders/${r1.id}/release`, { token: "f".repeat(64) }, walker);
  check("release with wrong token rejected", badRelease.status === 403);

  const released = await api(
    "POST",
    `/orders/${r1.id}/release`,
    { token: w1.body.takerToken },
    walker,
  );
  check(
    "release before lock reopens the order",
    released.status === 200 &&
      released.body.order.status === "open" &&
      released.body.order.takerEthAccount === null,
  );
  const relisted = await api("GET", "/orders");
  check("released order listed again", relisted.body.orders.some((o) => o.id === r1.id));

  const retake = await api("POST", `/orders/${r3.id}/accept`, taker, walker);
  check("release frees the concurrency slot", retake.status === 200);

  const staleToken = await api(
    "POST",
    `/orders/${r1.id}/release`,
    { token: w1.body.takerToken },
    walker,
  );
  check("released taker token is dead", staleToken.status === 403);

  // Maker announces on the second take, then the taker walks away: the
  // listing stays locking (funds are chain-governed) but stops occupying
  // one of the taker's slots.
  const rnow = Math.floor(Date.now() / 1000);
  await api("POST", `/orders/${r2.id}/hashlock`, {
    token: r2.token,
    hashlock: `0x${"2".repeat(64)}`,
    initiatorTimeout: rnow + 7200,
    responderTimeout: rnow + 3600,
  });
  const lateRelease = await api(
    "POST",
    `/orders/${r2.id}/release`,
    { token: w2.body.takerToken },
    walker,
  );
  check(
    "release after lock keeps the order locking",
    lateRelease.status === 200 && lateRelease.body.order.status === "locking",
  );
  check("release is visible to the maker", lateRelease.body.order.released === true);
  const freshView = await api("GET", `/orders/${r3.id}`);
  check("unreleased order reads released=false", freshView.body.order.released === false);
  const r4 = await mk();
  const afterLate = await api("POST", `/orders/${r4.id}/accept`, taker, walker);
  check("late release frees the concurrency slot too", afterLate.status === 200);

  console.log("maker presence:");
  const p1 = await mk();
  const fresh = await api("GET", `/orders/${p1.id}`);
  check("fresh order shows the maker online", fresh.body.order.makerSeen === true);
  await sleep(1200); // one presence TTL
  const stale = await api("GET", `/orders/${p1.id}`);
  check("silent maker goes offline", stale.body.order.makerSeen === false);
  const hbBad = await api("POST", `/orders/${p1.id}/heartbeat`, { token: "f".repeat(64) });
  check("heartbeat with wrong token rejected", hbBad.status === 403);
  const hb = await api("POST", `/orders/${p1.id}/heartbeat`, { token: p1.token });
  check("heartbeat revives presence", hb.status === 200 && hb.body.order.makerSeen === true);

  console.log("take-by-terms:");
  // Fresh direction (qrl->eth) so leftovers from earlier sections cannot
  // match. Taker pays toAmount (ETH), receives fromAmount (QRL).
  const mkBid = async (fromQrlWei, toEthWei) => {
    const r = await api(
      "POST",
      "/orders",
      {
        direction: "qrl->eth",
        fromAmount: fromQrlWei.toString(),
        toAmount: toEthWei.toString(),
        makerEthAccount: ETH_A,
        makerQrlAccount: QRL_A,
      },
      makerHdr,
    );
    return { id: r.body.order.id, token: r.body.makerToken };
  };
  const terms = {
    direction: "qrl->eth",
    maxPay: ONE_ETH.toString(),
    minReceive: (18n * 10n ** 17n).toString(), // at least 1.8 QRL for 1 ETH
    ...taker,
  };
  const sniper = { "X-Forwarded-For": "203.0.113.30" };

  const offlineBest = await mkBid(3n * 10n ** 18n, ONE_ETH); // best rate, but will be offline
  await sleep(1200);
  const bidA = await mkBid(2n * 10n ** 18n, ONE_ETH); // rate 2.0, online
  const bidB = await mkBid(19n * 10n ** 17n, ONE_ETH); // rate 1.9, online
  const takeBest = await api("POST", "/orders/take", terms, sniper);
  check(
    "take-by-terms fills the best online order, skipping offline makers",
    takeBest.status === 200 &&
      takeBest.body.order.id === bidA.id &&
      typeof takeBest.body.takerToken === "string",
  );
  const takeNext = await api("POST", "/orders/take", terms, sniper);
  check(
    "racing second take falls through to the next rung within bounds",
    takeNext.status === 200 && takeNext.body.order.id === bidB.id,
  );
  const takeEmpty = await api("POST", "/orders/take", terms, {
    "X-Forwarded-For": "203.0.113.31",
  });
  check(
    "take-by-terms with no online match is a clean conflict",
    takeEmpty.status === 409 && !String(takeEmpty.body.error).includes("no longer open"),
  );
  await api("POST", `/orders/${offlineBest.id}/heartbeat`, { token: offlineBest.token });
  const takeRevived = await api("POST", "/orders/take", terms, {
    "X-Forwarded-For": "203.0.113.31",
  });
  check(
    "a heartbeat puts the order back in the matchable set",
    takeRevived.status === 200 && takeRevived.body.order.id === offlineBest.id,
  );
  const offlineById = await mkBid(2n * 10n ** 18n, ONE_ETH);
  await sleep(1200);
  const explicitTake = await api("POST", `/orders/${offlineById.id}/accept`, taker, {
    "X-Forwarded-For": "203.0.113.32",
  });
  check("offline orders stay takeable by explicit id", explicitTake.status === 200);

  console.log("per-asset orders:");
  const HUNDRED_USDC = 100n * 10n ** 6n; // 6-decimal base units
  const TWO_QRL = 2n * ONE_ETH; // QRL is native, always 18 decimals
  const stableTaker = { "X-Forwarded-For": "203.0.113.40" };

  const usdcDust = await api(
    "POST",
    "/orders",
    {
      direction: "eth->qrl",
      asset: "USDC",
      fromAmount: "999999", // one base unit below 1 USDC
      toAmount: TWO_QRL.toString(),
      makerEthAccount: ETH_A,
      makerQrlAccount: QRL_A,
    },
    makerHdr,
  );
  check(
    "sub-minimum USDC rejected with the per-asset floor",
    usdcDust.status === 400 && String(usdcDust.body.error).includes("1 USDC"),
  );

  const qrlSideDust = await api(
    "POST",
    "/orders",
    {
      direction: "eth->qrl",
      asset: "USDC",
      fromAmount: HUNDRED_USDC.toString(),
      toAmount: "1000", // QRL side keeps the 18-decimal wei floor
      makerEthAccount: ETH_A,
      makerQrlAccount: QRL_A,
    },
    makerHdr,
  );
  check("QRL side of a USDC order keeps the wei floor", qrlSideDust.status === 400);

  const badAsset = await api(
    "POST",
    "/orders",
    {
      direction: "eth->qrl",
      asset: "DOGE",
      fromAmount: ONE_ETH.toString(),
      toAmount: ONE_ETH.toString(),
      makerEthAccount: ETH_A,
      makerQrlAccount: QRL_A,
    },
    makerHdr,
  );
  check("unknown asset rejected", badAsset.status === 400);

  const nullAsset = await api(
    "POST",
    "/orders",
    {
      direction: "eth->qrl",
      asset: null,
      fromAmount: ONE_ETH.toString(),
      toAmount: ONE_ETH.toString(),
      makerEthAccount: ETH_A,
      makerQrlAccount: QRL_A,
    },
    makerHdr,
  );
  check("null asset rejected (only absent means ETH)", nullAsset.status === 400);

  // Cross-match guard: an ETH order whose raw numbers overlap a USDC
  // request (1 ETH escrowed = 1e18 >= any USDC minReceive, same QRL
  // toAmount) must never fill it. Freshly created, so it is online and
  // WOULD match if the filter were not asset-scoped.
  const ethOverlap = await api(
    "POST",
    "/orders",
    {
      direction: "eth->qrl",
      fromAmount: ONE_ETH.toString(),
      toAmount: TWO_QRL.toString(),
      makerEthAccount: ETH_A,
      makerQrlAccount: QRL_A,
    },
    makerHdr,
  );
  const usdcTerms = {
    direction: "eth->qrl",
    asset: "USDC",
    maxPay: TWO_QRL.toString(), // QRL wei the taker pays
    minReceive: HUNDRED_USDC.toString(), // USDC base units the taker receives
    ...taker,
  };
  const crossMatch = await api("POST", "/orders/take", usdcTerms, stableTaker);
  check("take-by-terms never cross-matches assets", crossMatch.status === 409);

  const usdcCreated = await api(
    "POST",
    "/orders",
    {
      direction: "eth->qrl",
      asset: "USDC",
      fromAmount: HUNDRED_USDC.toString(), // 1e8, below the old 1e15 wei floor
      toAmount: TWO_QRL.toString(),
      makerEthAccount: ETH_A,
      makerQrlAccount: QRL_A,
    },
    makerHdr,
  );
  check(
    "USDC order accepted at 6-decimal amounts",
    usdcCreated.status === 201 && usdcCreated.body.order.asset === "USDC",
  );
  const usdcListed = await api("GET", "/orders");
  check(
    "asset field present in the order list",
    usdcListed.body.orders.some((o) => o.id === usdcCreated.body.order.id && o.asset === "USDC"),
  );

  const usdcTake = await api("POST", "/orders/take", usdcTerms, stableTaker);
  check(
    "USDC take fills the USDC order",
    usdcTake.status === 200 &&
      usdcTake.body.order.id === usdcCreated.body.order.id &&
      usdcTake.body.order.asset === "USDC",
  );
  const ethTerms = {
    direction: "eth->qrl",
    maxPay: TWO_QRL.toString(),
    minReceive: ONE_ETH.toString(),
    ...taker,
  };
  const ethTake = await api("POST", "/orders/take", ethTerms, stableTaker);
  check(
    "asset-less take defaults to ETH and leaves USDC alone",
    ethTake.status === 200 && ethTake.body.order.id === ethOverlap.body.order.id,
  );

  console.log("book stream:");
  const streamRes = await fetch(`${BASE}/orders/stream`);
  check(
    "stream connects as an event stream",
    streamRes.status === 200 && streamRes.headers.get("content-type") === "text/event-stream",
  );
  const reader = streamRes.body.getReader();
  const dec = new TextDecoder();
  const nextChunk = () =>
    Promise.race([
      reader.read().then((r) => dec.decode(r.value ?? new Uint8Array())),
      sleep(3000).then(() => {
        throw new Error("stream timeout");
      }),
    ]);
  const firstEvent = await nextChunk();
  check("stream sends the book on connect", firstEvent.includes("event: book"));
  const streamedOrder = await mk();
  let streamed = "";
  for (let i = 0; i < 5 && !streamed.includes(streamedOrder.id); i += 1) {
    streamed += await nextChunk();
  }
  check("stream pushes book changes", streamed.includes(streamedOrder.id));
  check("stream payload carries the asset field", streamed.includes('"asset":"ETH"'));
  await reader.cancel().catch(() => undefined);

  console.log("legacy persistence:");
  // A pre-stablecoin data file: full order rows, no asset field. The
  // store must hydrate them as ETH so prod data survives the rollout.
  const PORT2 = PORT + 2000;
  const BASE2 = `http://127.0.0.1:${PORT2}/api`;
  const legacyFile = join(mkdtempSync(join(tmpdir(), "quantaswap-ob-legacy-")), "orders.json");
  const legacyNow = Math.floor(Date.now() / 1000);
  writeFileSync(
    legacyFile,
    JSON.stringify([
      {
        id: "00000000000000ab",
        direction: "eth->qrl",
        fromAmount: ONE_ETH.toString(),
        toAmount: TWO_QRL.toString(),
        makerEthAccount: ETH_A,
        makerQrlAccount: QRL_A,
        status: "open",
        takerEthAccount: null,
        takerQrlAccount: null,
        hashlock: null,
        initiatorTimeout: null,
        responderTimeout: null,
        createdAt: legacyNow,
        updatedAt: legacyNow,
        makerTokenHash: "0".repeat(64),
      },
    ]),
  );
  child2 = spawn(process.execPath, [new URL("./dist/server.js", import.meta.url).pathname], {
    env: { ...process.env, PORT: String(PORT2), ORDERBOOK_DATA: legacyFile, PRESENCE_TTL_S: "90" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  await waitForHealth(BASE2);
  const legacyList = await fetch(`${BASE2}/orders`).then((r) => r.json());
  const legacyRow = legacyList.orders.find((o) => o.id === "00000000000000ab");
  check("legacy asset-less row still listed", legacyRow !== undefined);
  check("legacy row hydrates as ETH", legacyRow !== undefined && legacyRow.asset === "ETH");
} catch (err) {
  failures += 1;
  console.error("smoke run crashed:", err);
} finally {
  child.kill("SIGTERM");
  if (child2 !== null) child2.kill("SIGTERM");
}

if (failures > 0) {
  console.error(`\n${failures} smoke check(s) failed`);
  process.exit(1);
}
console.log("\nall smoke checks passed");
