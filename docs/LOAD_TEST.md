# Order book concurrency load test

This document answers one question with numbers: what happens when hundreds of
takers try to make or take trades at once.

The harness lives in `server/src/loadtest/`, compiles with the package, is
excluded from `npm test`, and runs with `npm run loadtest`. Every figure below
comes from that harness driving a real `dist/server.js` process over loopback,
with the production persistence path, real ML-DSA-87 proofs and real fsync
behaviour. Nothing in the service was stubbed or instrumented for the test.

## How to run it

```bash
cd server
npm ci
nice -n 15 npm run loadtest -- --takers 200 --duration 20
```

Useful flags: `--takers` (default 50), `--makers` (8), `--orders` (24),
`--hot` (2), `--rounds` (6), `--duration` seconds (20), `--concurrency`
in-flight request cap (64), `--scenarios a,b,c,d,e,f`, `--run-dir`,
`--out` for the JSON result. The harness lowers its own scheduling priority
and that of the book process, runs one scenario at a time, and caps in-flight
requests, so it can share a workstation.

Each scenario starts a fresh book with its own data directory, so per-source
daily caps and retained state from one scenario never leak into the next.

## Method

Six scenarios, each preceded by seeding 24 signed public portable V2 orders
from 8 synthetic makers:

| Key | Scenario |
| --- | --- |
| a | Every taker submits a signed `FillIntentV2` for the same hot order at the same moment, for 6 rounds. |
| b | Takers spread over all 24 seeded orders, rotating one order per round. |
| c | Takers submit intents while makers cancel and repost, 8 clients poll `GET /orders` at 5 Hz and 20 clients hold the SSE stream. |
| d | One saturating burst of one intent per taker, then a steady state at one eighth of the burst concurrency. |
| e | The spread workload again with one shared forwarded source address for every client. |
| f | Strictly sequential submissions, so measured latency is service time with no queueing. |

Identities are ML-DSA-87 key pairs derived once per run from deterministic
seeds and cached in the run directory. Proofs are signed ahead of the measured
window by a small worker pool, because one signature costs about 33 ms and a
signed fill intent is only valid for 120 s.

**Per-source addressing.** The book already supports this through its real
trusted-proxy mechanism. It runs with `ORDERBOOK_TRUST_PROXY=loopback`, which
is the default, and the harness reaches it over loopback, so every synthetic
client presents its own `X-Forwarded-For` address and `resolveClientIp`
resolves it through the same code path a reverse proxy would use. No test-only
configuration branch was added to the service.

All synthetic addresses come from the documentation ranges reserved for this
purpose: `192.0.2.0/24`, `198.51.100.0/24` and `203.0.113.0/24` from RFC 5737
for makers and takers, and `2001:db8::/32` from RFC 3849 for readers, stream
subscribers and the harness probes. The only real address involved is loopback
`127.0.0.1`.

**Responsiveness measurement.** `GET /api/health` is sampled every 100 ms from
a separate process, so the harness's own event loop, which drives up to 64
concurrent clients, cannot inflate the figure that is supposed to describe the
book. That probe also reports its own timer drift; drift stayed at or below
5.4 ms at the 99th percentile in every run, so its latency numbers describe
the book and not the measurement.

**Hardware class.** One consumer laptop-class x86-64 machine: a 10-core,
20-thread AMD mobile part at roughly 2 GHz base, 23 GiB RAM, an NVMe-backed
virtual disk under a Linux virtual machine, Node 22.22. Harness, probe and
book all ran at niceness 15. System load average peaked at 3.7 on 20 logical
cores during the 500-taker run, so the host was never saturated.

## Results

### Admissions are capacity-bound, and the ceiling does not move with demand

`POST /orders/:id/intents`, one row per scenario and taker count.

| N | Scenario | Submitted | Admitted | req/s | p50 ms | p95 ms | p99 ms | max ms | Book CPU |
| --: | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| 50 | a hot order | 300 | 8 | 70.7 | 167 | 357 | 442 | 459 | 50% |
| 50 | b spread | 300 | 189 | 43.5 | 608 | 5711 | 5784 | 5801 | 48% |
| 50 | c mixed | 300 | 173 | 13.7 | 529 | 6183 | 6306 | 6327 | 20% |
| 50 | d burst | 300 | 192 | 40.7 | 76 | 814 | 1130 | 1201 | 44% |
| 50 | e shared address | 300 | 4 | 163.0 | 46 | 676 | 678 | 679 | 51% |
| 100 | a hot order | 600 | 8 | 86.8 | 288 | 637 | 794 | 828 | 57% |
| 100 | b spread | 600 | 192 | 62.8 | 208 | 5889 | 7489 | 7520 | 52% |
| 100 | c mixed | 600 | 174 | 26.4 | 215 | 6955 | 7753 | 7787 | 26% |
| 100 | d burst | 600 | 192 | 48.4 | 7 | 1740 | 2365 | 2514 | 41% |
| 100 | e shared address | 600 | 4 | 204.8 | 5 | 786 | 853 | 854 | 40% |
| 200 | a hot order | 1200 | 8 | 102.7 | 336 | 353 | 1221 | 1288 | 63% |
| 200 | b spread | 1200 | 192 | 86.3 | 246 | 703 | 9653 | 10312 | 59% |
| 200 | c mixed | 1200 | 175 | 49.5 | 261 | 587 | 11014 | 11072 | 39% |
| 200 | d burst | 1200 | 192 | 54.4 | 7 | 701 | 4746 | 5006 | 39% |
| 200 | e shared address | 1200 | 4 | 276.7 | 6 | 151 | 687 | 699 | 25% |
| 500 | a hot order | 3000 | 8 | 110.7 | 333 | 350 | 672 | 3049 | 65% |
| 500 | b spread | 3000 | 192 | 101.6 | 332 | 1044 | 1206 | 10479 | 63% |
| 500 | c mixed | 2858 | 173 | 96.8 | 316 | 493 | 7312 | 15439 | 64% |
| 500 | d burst | 1448 | 192 | 50.0 | 8 | 1217 | 6672 | 7181 | 37% |
| 500 | e shared address | 3000 | 4 | 313.0 | 6 | 52 | 325 | 708 | 14% |

Admitted counts are flat in N and match the documented policy exactly:

- Scenario a admits **8** proposals at every taker count, which is
  `MAX_FILL_INTENTS_PER_ORDER`. The per-round breakdown is always
  `8, 0, 0, 0, 0, 0`: the eight slots are taken in the first instant and held
  for the full signed intent lifetime, so nobody else can propose for up to
  120 s. At 500 takers, 2992 of 3000 proposals were refused with
  "this order already has too many pending fill intents".
- Scenario b admits **192**, which is 8 live intents times 24 seeded orders.
- Scenario e admits **4**, which is `MAX_CONCURRENT_TAKES_PER_IP`. The
  rejection split is exact arithmetic on the documented budgets: the shared
  address gets 120 mutations per minute, 24 of which were consumed by seeding,
  leaving 96 proposals that reach admission, of which 4 are admitted and 92 hit
  the concurrent cap. Everything beyond 120 is refused by the cheap HTTP
  limiter before any work happens.

The rejection reason mix confirms it. At 200 takers: scenario a is 1192
`order_live_intent_cap`; scenario b is 1008 `order_live_intent_cap`; scenario c
is 704 `order_live_intent_cap` plus 321 `order_not_open` from maker
cancellations; scenario e is 1104 `http_per_ip_rate_limit` plus 92
`source_concurrent_cap`.

### Latency under load is queueing, and the tail grows with N

Service time is stable. The queue is what grows.

Scenario f, strictly sequential with no queueing, at every taker count:

| N | Admitted intent p50 | p95 | max | Sequential `GET /orders` p50 |
| --: | --: | --: | --: | --: |
| 50 | 26.5 ms | 29.5 ms | 34.7 ms | 1.5 ms |
| 100 | 29.8 ms | 36.7 ms | 38.9 ms | 1.5 ms |
| 200 | 24.3 ms | 26.9 ms | 31.6 ms | 1.5 ms |
| 500 | 24.6 ms | 27.3 ms | 44.2 ms | 1.5 ms |

Meanwhile the concurrent tail on the same machine goes from 5.8 s at 50 takers
to 10.3 s at 200 and 15.4 s at 500 (scenario c max). The book is a
single-threaded Node process with no admission queue in front of the expensive
work, so with `C` requests in flight the last one waits behind all the others.
The measured p99 tracks in-flight concurrency times service time closely.

The 15.4 s maximum at 500 takers matters operationally: the service sets
`ORDERBOOK_REQUEST_TIMEOUT_MS` to 15 s by default, so a little beyond this load
the book starts cutting its own requests off.

Reads suffer with writes. In scenario c, `GET /orders` went from a 1.5 ms
sequential service time to p95 452 ms and max 865 ms at 200 takers, purely from
waiting behind mutations. The externally probed `GET /api/health` shows the
same: p50 stayed at 1.5 to 2.1 ms in every run, while p99 reached 1.35 s at 100
and 200 takers and 2.18 s at 500. A health check that is normally
sub-millisecond becomes a multi-second wait under a taker rush, which is worth
knowing for any liveness probe pointed at it.

### Where the time goes

The harness measures the same sequential scenario twice, once with the data
directory on the disk-backed filesystem and once on a memory filesystem.
Identical parameters, 50 takers, 120 sequential admitted intents, a store that
grows to 2.16 MiB:

| Path | Disk-backed | Memory filesystem |
| --- | --: | --: |
| Admitted intent, p50 | 24.4 ms | 8.9 ms |
| Admitted intent, first quarter of the run | 23.2 ms | 8.1 ms |
| Admitted intent, last quarter of the run | 25.4 ms | 10.3 ms |
| Admitted throughput | 32.0/s | 61.4/s |

Rejected proposals, which pay signature verification and stop before
persistence, cost 6.0 to 6.1 ms at the p50 in the uncontended measurements, and
that figure is the same on both filesystems. That gives a clean split of the
24.4 ms admitted service time:

| Component | Cost | Share |
| --- | --: | --: |
| ML-DSA-87 verification plus parsing a ~14 KB signed body | ~6.0 ms | 25% |
| Serialising and rewriting the store plus the feed append | ~2.9 ms | 12% |
| fsync durability barrier | ~15.5 ms | 63% |

A standalone micro-benchmark on the same machine puts one ML-DSA-87 verify at
3.4 ms and one sign at 32.9 ms, which is consistent with the 6.0 ms figure once
JSON parsing of the 14 KB body is included.

### Write amplification is the structural problem

`OrderStore.persist()` serialises the entire order map to JSON, writes it to a
temporary file, fsyncs the file, renames it, and fsyncs the directory. This
happens on **every** mutation. The federation feed then appends the event and
fsyncs again.

Measured sizes at the end of a run:

- One retained `FillIntentV2` record is **~15.3 KB** of JSON. It carries a
  4627-byte ML-DSA-87 signature and a 2592-byte public key, both hex-encoded.
- 24 orders each holding the 8-intent maximum produce a **3.2 MiB**
  `orders.json`, with a **3.2 MiB** federation feed beside it.
- At the documented ceiling of 64 retained public portable orders, the same
  arithmetic gives roughly **7.8 MiB** rewritten and fsynced per mutation.

So admitting one 15 KB proposal at full book depth rewrites and fsyncs about
3.2 MiB, a write amplification of roughly 220 to 1. On this machine the fixed
fsync barrier still dominates at these sizes; the byte-count term measures at
about 1 ms per MiB, visible as the 8.1 ms to 10.3 ms drift across the memory
filesystem run. On a slower device, or at the 64-order ceiling, the byte-count
term grows while the barrier stays, so both terms matter.

### SSE fan-out is not the bottleneck

20 subscribers, 12 tracked order creations per run:

| N | Publish latency p50 | p95 | Fan-out spread p50 | p95 | Dropped | Undelivered |
| --: | --: | --: | --: | --: | --: | --: |
| 50 | 53 ms | 1328 ms | 24 ms | 30 ms | 0 | 0 |
| 100 | 229 ms | 1071 ms | 24 ms | 34 ms | 0 | 0 |
| 200 | 317 ms | 893 ms | 23 ms | 32 ms | 0 | 0 |
| 500 | 433 ms | 962 ms | 23 ms | 32 ms | 0 | 0 |

Publish latency is measured from the creating client's request start to the
first subscriber's frame, so it includes the queueing the creating request
suffered. Fan-out spread, the gap between the first and last subscriber
receiving the same frame, is a flat 23 to 25 ms at the median and never exceeds
34 ms, and it does not grow with taker count. No subscriber was dropped for
backpressure and every tracked order reached every subscriber. The rising
publish latency comes from the mutation queue.

One caveat: every book frame carries the whole listing. At 24 orders that is
cheap. At the 64-order ceiling with full intent sets it would be a much larger
payload, and the cost of serialising it once per coalesced push would grow. The
listing payload excludes intents, so it stays far smaller than `orders.json`.

### Fairness and correctness

Across all 24 scenario runs, every invariant held:

- **Documented ordering.** The maker view from `GET /orders/:id/intents` matched
  the documented rule, lowest `max(auth.issuedAt, receivedAt)` then
  `auth.issuedAt` then semantic `intentDigest`, in every inspection, over up to
  64 live intents per check. No backdated proposal ever jumped an earlier
  arrival.
- **No double fill.** The harness races two contradictory `FillV2` proofs, each
  selecting a different admitted intent, at the same order at the same instant.
  Both requests returned 200 every time, exactly one fill was stored every
  time, the loser was retained as one conflict proof, and the order ended in
  `locking`. This is the documented equivocation behaviour and it held under
  every load level.
- **Book and feed agree.** The number of admitted proposals equalled the number
  of `fill-intent-v2` events on the federation feed in every run, and no open
  row was missing its `order-v2` proof from the feed.
- **Restart reloads identical state.** After each scenario the book was stopped
  and restarted on the same data files. The served listing was identical row by
  row every time, and the retained intent count per order was identical every
  time.
- **No crash, no timeout, no transport error.** Zero transport errors and zero
  5xx responses across all runs, including 3000-proposal bursts.

On starvation: at 500 takers racing one order, 492 takers got nothing, and in
scenario b 308 of 500 got nothing. That is the documented capacity policy
working, and it does not contradict the documented ordering rule. What is worth
naming is the *duration* of the lockout. A live intent holds its slot until its
signed expiry, up to 120 s, including after the maker has already chosen a
different proposal and including after the taker released it. So one order
admits at most 8 proposals per 2 minutes no matter how many takers want it. The
per-round figures make this concrete: `8, 0, 0, 0, 0, 0`.

## Where the bottleneck is

Ranked by measured contribution:

1. **The synchronous whole-store rewrite plus fsync per mutation.** 63% of
   admitted service time is the fsync barrier and another 12% is the rewrite.
   Removing the durability barrier alone nearly doubles admitted throughput,
   from 32/s to 61/s, on identical inputs.
2. **Everything is serialised behind that.** The book is one Node process with
   one event loop and no bound on concurrent in-flight requests, so reads and
   health checks queue behind writes. Book CPU never exceeded 65% of one core
   in any run, including at 500 takers, which rules out CPU saturation as the
   limit.
3. **Signature verification runs before every admission check.** At 6.0 ms per
   proposal this is a quarter of the admitted cost, and it is the *whole* cost
   of a rejected proposal. In scenario a at 500 takers the book spent 16.7 s of
   CPU to refuse 2992 proposals that could not possibly be admitted, because
   the order's eight slots were full from the first instant.
4. **SSE fan-out is not a bottleneck** at this scale. 23 to 25 ms of spread
   across 20 subscribers, flat in taker count.

## Recommendations, ranked by impact

1. **Stop rewriting the whole store on every mutation.** This is the single
   biggest lever. Options, cheapest first: batch and coalesce mutations that
   arrive in the same tick into one persist, since bursts are exactly the case
   that hurts; or move to an append-and-compact log for the order store, the
   way the federation feed already works; or keep the whole-file rewrite and
   group-commit the fsync across concurrent mutations. Expect roughly a 2x
   improvement in admitted throughput from removing the per-mutation barrier,
   based on the memory-filesystem control.
2. **Stop persisting full signature material inline in the store.** 94% of a
   retained intent record is a hex-encoded signature and public key. Storing
   proofs in a side file or a content-addressed blob keyed by `intentDigest`,
   and keeping the order rows small, would cut the rewritten bytes by more than
   an order of magnitude and make the whole-store rewrite tolerable even if it
   stays. This also shrinks the federation feed by the same factor.
3. **Move the cheap admission checks in front of signature verification.** The
   order-state check, the runway check, the per-order live-intent count and the
   per-source concurrent and daily caps all need only the order and the client
   address, and none of them needs the verified intent. Checking them first
   would let a full order refuse proposals in microseconds, down from 6 ms
   each. This changes the status code a client sees when it sends an invalid
   signature to a full order, from 401 to 429, so it needs a deliberate
   decision and test updates. It does not change any admission policy number.
4. **Bound concurrent in-flight requests in the book.** A small queue with a
   fast 503 or 429 at the door would convert a 15 s tail into an immediate,
   honest rejection, and would keep `GET /api/health` and `GET /orders`
   responsive while takers rush. Today the tail reaches the configured 15 s
   request timeout at 500 concurrent sources.
5. **Reconsider how long a consumed intent slot is held.** An order admits 8
   proposals per 120 s regardless of demand. Releasing the slot when the maker
   publishes a `FillV2` that selects a different proposal, or shortening the
   default signed intent lifetime, would raise the effective admission rate for
   a hot order without touching `MAX_FILL_INTENTS_PER_ORDER`. This is an
   economic and protocol decision, and the slot-holding rule exists on purpose,
   so it wants evidence from real usage before it is changed.
6. **Do not point an aggressive liveness probe at `/api/health` under load.**
   Its p99 reached 2.18 s. Any restart-on-failure supervision needs a timeout
   comfortably above that, or it will restart a healthy book during a rush.

## Limits of this test

The numbers describe shape and ratio. They are not an absolute capacity figure
for any real deployment.

- **One machine, loopback only.** Client and server shared 20 logical cores and
  one NVMe-backed virtual disk. There is no network latency, no TLS, no reverse
  proxy and no Cloudflare in the path. Real deployments add all four, which
  raises absolute latency and changes where queues form.
- **The fsync figure is device specific.** 15.5 ms is what this virtual disk
  costs. A server NVMe with a power-loss-protected cache would be much faster,
  and a network block device much slower. The *ratio* between the persistence
  path and the verification path is the transferable result.
- **The harness is a competing workload.** It ran at the same niceness as the
  book. The responsiveness probe was moved to its own process for exactly this
  reason and its timer drift stayed under 5.4 ms at p99, but the client side
  still consumed cores that a real deployment would not.
- **In-flight concurrency was capped at 64** to keep the workstation usable.
  The taker count is the population; 64 is how many of them can have a request
  outstanding at once. A real rush with 500 genuinely simultaneous sockets
  would produce a longer tail than measured here.
- **Signed intents live 120 s**, which bounds how long one pre-signed batch can
  drive load. Runs end when the pre-signed supply drains or the duration
  expires, whichever comes first, and each scenario reports which one it hit.
  Scenario a is bounded by its round count, so `--duration` only caps it.
- **Paths not exercised.** Federation peer sync ran with zero peers. Feed
  compaction never triggered, because it needs more than 4096 retained events
  and the admission caps make that unreachable inside a short run. Presence
  expiry, the 48 h open-order TTL and the retained-artifact ceilings were not
  reached. Storage-failure handling and graceful shutdown under active load
  were not tested beyond the clean restart check.
- **Synthetic identities.** Every taker used a distinct forwarded address, which
  is the best case for the per-source budgets. A real adversary rotating
  addresses gets the same result, and the code comments already say these caps
  are fairness for demo traffic and not sybil resistance. Scenario e measures
  the opposite extreme, where every client shares one address.
