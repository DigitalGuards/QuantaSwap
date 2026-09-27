# Order book concurrency load test

This document answers one question with numbers: what happens when hundreds of
takers try to make or take trades at once.

The harness lives in `server/src/loadtest/`, compiles through its own
`tsconfig.loadtest.json` into `dist-loadtest`, and runs with `npm run loadtest`.
`npm test` does not execute it and `npm run build` does not emit it, so it never
reaches the packaged runtime image. Every figure below comes from that harness
driving a real order-book process over loopback, with the production
persistence path, real ML-DSA-87 proofs and real fsync behaviour. Nothing in
the service was stubbed or instrumented for the test.

## How to run it

```bash
cd server
npm ci
nice -n 15 npm run loadtest -- --takers 200 --duration 20
```

The paired control that separates the persistence cost from the verification
cost runs the sequential scenario twice, once on the disk-backed filesystem and
once on a memory filesystem:

```bash
nice -n 15 npm run loadtest -- --takers 50 --duration 30 --scenarios f \
  --run-dir /tmp/orderbook-loadtest-disk
nice -n 15 npm run loadtest -- --takers 50 --duration 30 --scenarios f \
  --run-dir /dev/shm/orderbook-loadtest-memory
```

Flags: `--takers` (default 50), `--makers` (8), `--orders` (24), `--hot` (2),
`--rounds` (6), `--duration` seconds (20), `--concurrency` in-flight request cap
(64), `--sign-workers` (up to 6), `--niceness` (15), `--base-port` (18800),
`--scenarios a,b,c,d,e,f`, `--run-dir`, `--out` for the JSON result. Unknown
flags and flags without a value are rejected.

The harness lowers its own scheduling priority and that of the book and probe
processes, runs one scenario at a time, and caps in-flight requests, so it can
share a workstation. It exits non-zero when any documented cap assertion or any
invariant check fails.

**Run directories are kept.** Each run prints its directory and leaves the
per-scenario `orders.json`, feed file and identity cache in place for
inspection. At 24 orders a scenario directory holds about 7 MiB. Delete them
yourself when done.

Each scenario starts a fresh book with its own data directory, so per-source
daily caps and retained state from one scenario never leak into the next. The
harness refuses to start when the port is already bound, so an orphan from an
aborted run can never be measured by mistake.

## Method

Six scenarios, each preceded by seeding 24 signed public portable V2 orders
from 8 synthetic makers:

| Key | Scenario |
| --- | --- |
| a | Every taker submits a signed `FillIntentV2` for the same hot order at the same moment, for 6 rounds. |
| b | Takers spread over all 24 seeded orders, rotating one order per round. |
| c | Takers submit proposals while makers cancel and repost, 8 clients poll `GET /orders` at 5 Hz and 20 clients hold the SSE stream. |
| d | One saturating burst of one proposal per taker, then a steady state at one eighth of the burst concurrency. |
| e | The spread workload again with one shared forwarded source address for every client. |
| f | Strictly sequential, so measured latency is service time with no queueing. |

**Three phases per scenario, with separate metrics.** Preparation derives
identities, seeds the orders and signs every proof the run will send. The
measured window then sends only what was already prepared. The audit afterwards
verifies the invariants. Preparation and audit traffic go to their own metrics
sinks, so the reported latency, throughput and book CPU describe the measured
window alone. This matters: one ML-DSA-87 signature costs about 33 ms, and at
500 takers preparation takes 8 to 9 seconds, which is comparable to the
measured window itself.

Identities are ML-DSA-87 key pairs derived once per run from deterministic
seeds and cached in the run directory. A signed fill intent is valid for at
most 120 s, and each scenario reports how much of that was left when its
preparation finished.

**Per-source addressing.** The book already supports this through its real
trusted-proxy mechanism. It runs with `ORDERBOOK_TRUST_PROXY=loopback`, which
is the default, and the harness reaches it over loopback, so every synthetic
client presents its own `X-Forwarded-For` address and `resolveClientIp`
resolves it through the same code path a reverse proxy would use. No test-only
configuration branch was added to the service.

All synthetic addresses come from the documentation ranges reserved for this
purpose: `192.0.2.0/24` for makers and `198.51.100.0/24` plus `203.0.113.0/24`
for takers, from RFC 5737, and `2001:db8::/32` from RFC 3849 for readers,
stream subscribers, the shared source address and the harness probes. Each role
occupies a distinct block, the harness refuses a taker count above the 508
addressable hosts, and the only real address involved is loopback `127.0.0.1`.

**Responsiveness measurement.** `GET /api/health` is sampled from a separate
process on a fixed 100 ms grid, so the harness's own event loop cannot inflate
the figure that is supposed to describe the book. One request is outstanding at
a time. When the book is slow the probe naturally takes fewer samples, so it
also reports how many grid slots a single slow reply consumed, and how many
replies were not 200, including its own 10 s client timeout. Samples stream out
one line at a time, so stopping the probe never discards what it measured.

**Invariant checks after every scenario.** The federation feed is read the way
a mirror peer catches up: one request with no cursor for the reset snapshot and
the feed identity, then a rewind to the oldest retained sequence and forward
paging of the append-only log. Log events and snapshot rows are counted
separately, because the snapshot is a store view and the log is a history. The
double-fill race asserts that the store kept exactly one of the two proofs the
harness sent and retained the loser as conflict evidence.

**Hardware class.** One consumer laptop-class x86-64 machine: a 10-core,
20-thread AMD mobile part, 23 GiB RAM, an NVMe-backed virtual disk under a
Linux virtual machine, Node 22.22. Harness, probe and book all ran at niceness
15. System load average peaked at 2.9 on 20 logical cores during the 500-taker
run, so the host itself was never saturated.

## Results

### Admissions are capacity-bound, and the ceiling does not move with demand

`POST /orders/:id/intents` during the measured window.

| N | Scenario | Submitted | Admitted | req/s | p50 ms | p95 ms | p99 ms | max ms | Book CPU |
| --: | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| 50 | a hot order | 300 | 8 | 97.0 | 164 | 346 | 429 | 444 | 60% |
| 50 | b spread | 300 | 189 | 55.6 | 613 | 5299 | 5364 | 5380 | 52% |
| 50 | c mixed | 300 | 176 | 14.6 | 482 | 5522 | 5592 | 5609 | 21% |
| 50 | d burst | 300 | 192 | 47.7 | 76 | 797 | 1096 | 1171 | 46% |
| 50 | e shared address | 300 | 4 | 446.2 | 46 | 657 | 660 | 660 | 100% |
| 100 | a hot order | 600 | 8 | 126.8 | 270 | 547 | 695 | 729 | 77% |
| 100 | b spread | 600 | 192 | 84.9 | 210 | 5473 | 7018 | 7050 | 66% |
| 100 | c mixed | 600 | 174 | 29.3 | 235 | 6479 | 7268 | 7300 | 28% |
| 100 | d burst | 600 | 192 | 57.7 | 7 | 1656 | 2281 | 2434 | 47% |
| 100 | e shared address | 600 | 4 | 815.9 | 5 | 652 | 725 | 725 | 102% |
| 200 | a hot order | 1200 | 8 | 149.3 | 333 | 360 | 1264 | 1333 | 89% |
| 200 | b spread | 1200 | 192 | 115.9 | 250 | 703 | 9664 | 10336 | 78% |
| 200 | c mixed | 1200 | 175 | 58.6 | 255 | 595 | 10836 | 10896 | 45% |
| 200 | d burst | 1200 | 192 | 65.0 | 7 | 700 | 4718 | 4975 | 46% |
| 200 | e shared address | 1200 | 4 | 1551.0 | 5 | 148 | 715 | 722 | 103% |
| 500 | a hot order | 3000 | 8 | 171.3 | 332 | 345 | 669 | 3001 | 98% |
| 500 | b spread | 3000 | 192 | 151.0 | 331 | 1042 | 1264 | 10140 | 91% |
| 500 | c mixed | 2938 | 173 | 140.5 | 321 | 507 | 6904 | 15042 | 88% |
| 500 | d burst | 1500 | 192 | 74.7 | 8 | 1141 | 5598 | 6587 | 51% |
| 500 | e shared address | 3000 | 4 | 3228.5 | 5 | 54 | 321 | 721 | 108% |

Admitted counts are flat in N and match the documented policy exactly. The
harness asserts this and fails the run otherwise; all 40 cap assertions across
these 24 scenario runs held.

- Scenario a admits **8** proposals at every taker count, which is
  `MAX_FILL_INTENTS_PER_ORDER`. The per-round breakdown is always
  `8, 0, 0, 0, 0, 0`: the eight slots are taken in the first instant and held
  for the full signed proposal lifetime, so nobody else can propose for up to
  120 s. At 500 takers, 2992 of 3000 proposals were refused with "this order
  already has too many pending fill intents".
- Scenario b admits **192**, which is 8 live proposals times 24 seeded orders.
- Scenario e admits **4**, which is `MAX_CONCURRENT_TAKES_PER_IP`. The refusal
  split is exact arithmetic on the documented budgets: the shared address gets
  120 mutations per minute, 24 of which seeding consumed, leaving 96 proposals
  that reach admission, of which 4 are admitted and 92 hit the concurrent cap.
  Everything beyond 120 is shed by the HTTP limiter before any verification.

At 200 takers the refusal mix is 1192 `order_live_intent_cap` in scenario a;
1008 in scenario b; 704 plus 321 `order_not_open` from maker cancellations in
scenario c; and 1104 `http_per_ip_rate_limit` plus 92 `source_concurrent_cap`
in scenario e.

### The book is CPU-bound under contention

This is the conclusion an earlier draft of this document got wrong, because its
measured window included the preparation phase and diluted the CPU average.

With preparation excluded, the book reaches **98% of one core** in the
hot-order race at 500 takers, 91% in the spread workload and 88% in the mixed
workload. Scenario e reads slightly above 100% because Node uses more than the
main thread for garbage collection and libuv work. The order book is one
single-threaded process, so one core is the ceiling, and at a few hundred
concurrent takers it is at that ceiling.

The verification arithmetic agrees. Scenario a at 500 takers processed 3000
proposals in a 17.5 s window and used 17.1 s of CPU, which is 5.7 ms per
proposal, matching the 5.8 ms queue-free verification cost measured below. The
book was not waiting; it was verifying.

Peak observed throughput for mutation-class requests that reach signature
verification is about **170 requests per second** on this machine. The
per-source HTTP limiter, which answers before the router, sheds at
**3228 requests per second**, roughly 19 times faster, at 108% of one core.

### Latency under load is queueing on top of that

Service time is stable. The queue is what grows. Scenario f, strictly
sequential with no queueing, at every taker count:

| N | Admitted p50 | Refused after verify p50 | Listing read p50 |
| --: | --: | --: | --: |
| 50 | 24.1 ms | 6.0 ms | 1.4 ms |
| 100 | 24.1 ms | 5.7 ms | 1.5 ms |
| 200 | 24.7 ms | 5.9 ms | 1.6 ms |
| 500 | 24.1 ms | 5.8 ms | 1.7 ms |

Meanwhile the concurrent tail on the same machine goes from 5.6 s at 50 takers
to 10.9 s at 200 and 15.0 s at 500 (scenario c max). The service sets
`ORDERBOOK_REQUEST_TIMEOUT_MS` to 15 s by default, so a little beyond this load
the book starts cutting off its own requests.

Reads suffer with writes, and at saturation they collapse. In scenario c,
`GET /orders` held a 3.2 to 3.3 ms p50 up to 200 takers while its p95 rose to
436 ms. At 500 takers its p50 jumped to **339 ms** and the poll rate the eight
readers achieved fell from 31.5 to 13.8 requests per second, without any of
them changing behaviour.

The externally probed `GET /api/health` tells the same story more bluntly. Its
p50 stays at 1.4 to 1.9 ms whenever the book has spare capacity. Under the
saturating spread and mixed workloads it stops answering usefully at all:

| N | Scenario | Probe samples | Grid ticks missed | Replies not 200 | Worst reply |
| --: | --- | --: | --: | --: | --: |
| 200 | b spread | 2 | 101 | 1 | 10.0 s (probe timeout) |
| 200 | c mixed | 97 | 107 | 1 | 10.0 s (probe timeout) |
| 500 | b spread | 15 | 183 | 1 | 10.0 s (probe timeout) |
| 500 | c mixed | 14 | 194 | 1 | 10.0 s (probe timeout) |

At 500 takers in the mixed workload the probe got 14 samples and lost 194 of
its roughly 209 grid slots waiting for replies, and one request exceeded its
10 s client timeout entirely. A liveness probe pointed at `/api/health` with
anything less than a very generous timeout will declare a healthy book dead
during a taker rush.

### Where the service time goes

The paired control runs the sequential scenario twice with identical
parameters, 50 takers, 120 admitted submissions followed by 50 submissions that
are certain to be refused after full verification, and a store that grows to
2.16 MiB:

| Measure | Disk-backed | Memory filesystem |
| --- | --: | --: |
| Admitted, verify plus persist, p50 | 24.7 ms | 9.2 ms |
| Refused after verification, p50 | 5.9 ms | 6.1 ms |
| Sequential listing read, p50 | 1.8 ms | 1.6 ms |
| Admitted, first quarter of the run | 23.0 ms | 8.3 ms |
| Admitted, last quarter of the run | 25.6 ms | 10.3 ms |
| Admitted throughput | 35.3/s | 76.7/s |
| Book CPU during the window | 49% of one core | 98% of one core |

The refused-after-verification figure is the same on both filesystems, which is
what makes the split trustworthy. It gives:

| Component | Cost | Share of 24.7 ms |
| --- | --: | --: |
| ML-DSA-87 verification plus parsing a ~15 KB signed body | ~5.9 ms | 24% |
| Serialising and rewriting the store plus the feed append | ~3.3 ms | 13% |
| fsync durability barrier | ~15.5 ms | 63% |

A standalone micro-benchmark on the same machine puts one ML-DSA-87 verify at
3.4 ms and one sign at 32.9 ms, consistent with the 5.9 ms figure once JSON
parsing of the 15 KB body is included.

The memory-filesystem column is the important one for planning. Removing the
durability barrier a bit more than doubles admitted throughput, and the book
immediately hits **98% of one core**. The barrier is the current wall; one core
of ML-DSA-87 verification plus JSON serialisation is the next one, and it is
close behind.

### Write amplification is the structural problem

`OrderStore.persist()` serialises the entire order map to JSON, writes it to a
temporary file, fsyncs the file, renames it, and fsyncs the directory, on
**every** mutation. The federation feed then appends the event and fsyncs again.

Measured from the persisted files:

- One retained `FillIntentV2` record is **15,261 bytes** of JSON. It carries a
  4627-byte ML-DSA-87 signature and a 2592-byte public key, both hex-encoded.
- One order row is **18,252 bytes**, for the same reason: it holds the maker's
  signature and public key.
- 24 orders each holding the 8-proposal maximum produce a **3.21 MiB**
  `orders.json` with a **3.21 MiB** federation feed beside it.
- At the documented ceiling of 64 retained public portable orders with full
  proposal sets, the same per-record sizes give
  `64 x 18,252 + 512 x 15,261 = 8.57 MiB` rewritten and fsynced per mutation.

So admitting one 15 KB proposal at the currently measured depth rewrites and
fsyncs 3.21 MiB, an amplification of about 220 to 1, rising to about 590 to 1
at the documented ceiling. On this machine the fixed fsync barrier still
dominates at these sizes; the byte-count term measures at roughly 1 ms per MiB,
visible as the 8.3 ms to 10.3 ms drift across the memory-filesystem run. On a
slower device, or at the 64-order ceiling, the byte-count term grows while the
barrier stays, so both terms matter.

### SSE fan-out is not the bottleneck

20 subscribers, 12 tracked order creations per run. Completeness is counted
over every tracked order, including any that reached no subscriber at all:

| N | Publish latency p50 | p95 | Fan-out spread p50 | p95 | Tracked | Observed | Incomplete | Dropped |
| --: | --: | --: | --: | --: | --: | --: | --: | --: |
| 50 | 51 ms | 885 ms | 25 ms | 31 ms | 12 | 12 | 0 | 0 |
| 100 | 236 ms | 1049 ms | 23 ms | 31 ms | 12 | 12 | 0 | 0 |
| 200 | 308 ms | 869 ms | 24 ms | 31 ms | 12 | 12 | 0 | 0 |
| 500 | 340 ms | 1102 ms | 25 ms | 33 ms | 12 | 12 | 0 | 0 |

Publish latency is measured from the creating client's request start to the
first subscriber's frame, so it includes the queueing that request suffered.
Fan-out spread, the gap between the first and last subscriber receiving the
same frame, is a flat 23 to 25 ms at the median with a ceiling of 33 ms, and it
stays flat as the taker count grows. Every tracked order reached every subscriber and no
subscriber was dropped for backpressure. The rising publish latency is the
mutation queue.

One caveat: every book frame carries the whole listing. At 24 orders that is
cheap. At the 64-order ceiling the payload grows, and the cost of serialising
it once per coalesced push grows with it. The listing payload excludes
proposals, so it stays far smaller than `orders.json`.

### Fairness and correctness

Across all 24 scenario runs the harness asserted and confirmed every one of the
following. The run exits non-zero if any of them fails.

- **Documented ordering.** The maker view from `GET /orders/:id/intents`
  matched the documented rule, lowest `max(auth.issuedAt, receivedAt)` then
  `auth.issuedAt` then semantic `intentDigest`, in every inspection, over up to
  64 live proposals per check. No backdated proposal ever jumped an earlier
  arrival.
- **Documented ceilings.** No order ever held more than 8 live proposals. The
  hot order admitted exactly 8, the shared source exactly 4, and the spread
  workload never exceeded either the per-order or the per-source product.
- **No double fill.** The harness races two contradictory `FillV2` proofs, each
  selecting a different admitted proposal, at the same order at the same
  instant, and then checks the served row: the stored `fillDigest` equalled
  exactly one of the two proofs the harness sent, the losing proof appeared in
  `conflictDigests`, and the order ended in `locking`. Both requests returned
  200 every time. This is the documented equivocation behaviour and it held at
  every load level.
- **Store and log agree.** The append-only log was paged from its oldest
  retained sequence in every run, and its `fill-intent-v2` event count equalled
  the number of admitted proposals exactly, every time. No open row was missing
  its `order-v2` proof from either the log or the reset snapshot.
- **Restart reloads identical state.** After each scenario the book was stopped
  and restarted on the same data files. The served listing was identical row by
  row and the retained proposal count per order was identical, every time.
- **No crash, no timeout, no transport error.** Zero transport errors and zero
  5xx responses across all runs, including 3000-proposal bursts.

On starvation: at 500 takers racing one order, 492 takers got nothing, and in
scenario b 308 of 500 got nothing. That is the documented capacity policy
working, and it does not contradict the documented ordering rule. What is worth
naming is the *duration* of the lockout. A live proposal holds its slot until
its signed expiry, up to 120 s, including after the maker has already chosen a
different proposal and including after the taker released it. So one order
admits at most 8 proposals per 2 minutes no matter how many takers want it. The
per-round figures make this concrete: `8, 0, 0, 0, 0, 0`.

## Where the bottleneck is

Ranked by measured contribution:

1. **The synchronous whole-store rewrite plus fsync per mutation.** 63% of
   admitted service time is the fsync barrier and another 13% is the rewrite.
   Removing the barrier takes admitted throughput from 35.3/s to 76.7/s on
   identical inputs.
2. **One core of ML-DSA-87 verification, immediately behind it.** With the
   barrier gone the sequential workload alone saturates a core. Under
   contention on disk the book already reaches 98% of one core at 500 takers,
   so both walls are in play at the same load.
3. **Signature verification runs before every admission check.** At 5.9 ms per
   proposal this is a quarter of the admitted cost and the *whole* cost of a
   refused one. In scenario a at 500 takers the book spent 17.1 s of CPU to
   refuse 2992 proposals that could not possibly be admitted, because the
   order's eight slots were full from the first instant. The contrast with the
   HTTP limiter is stark: it sheds at 3228 requests per second because it
   answers first.
4. **Everything else queues behind the above.** Reads and health checks share
   the one event loop. `GET /orders` degrades from a 3.2 ms p50 to 339 ms, and
   `/api/health` stops answering inside 10 s, at 500 takers.
5. **SSE fan-out is not a bottleneck** at this scale. 23 to 25 ms of spread
   across 20 subscribers, flat in taker count.

## Recommendations, ranked by impact

1. **Stop rewriting the whole store on every mutation.** Options, cheapest
   first: coalesce mutations that arrive in the same tick into one persist,
   since bursts are exactly the case that hurts; or move the order store to an
   append-and-compact log, the way the federation feed already works; or keep
   the whole-file rewrite and group-commit the fsync across concurrent
   mutations. Expect a bit more than 2x on admitted throughput, and expect the
   next wall to be one core of verification.
2. **Move the cheap admission checks in front of signature verification.** The
   order-state check, the runway check, the per-order live-proposal count and
   the per-source concurrent and daily caps all need only the order and the
   client address, and none needs the verified proposal. A full order could
   then refuse in microseconds. This promotion matters more than it looks:
   scenario a shows the book burning a near-full core to refuse proposals it
   already knows it cannot accept, and it is the difference between 170 and
   3228 requests per second on the shedding path. It changes the status code a
   client sees when it sends an invalid signature to a full order, from 401 to
   429, so it needs a deliberate decision and test updates. It changes no
   admission policy number.
3. **Stop persisting full signature material inline in the store rows.** 94% of
   a retained proposal record and most of an order row is a hex-encoded
   signature and public key. Keying proofs by `intentDigest` in a side store
   would cut the rewritten bytes by more than an order of magnitude, shrink the
   feed by the same factor, and keep the 64-order ceiling from turning a
   3.2 MiB rewrite into an 8.6 MiB one.
4. **Bound concurrent in-flight requests in the book.** A small queue with a
   fast 503 or 429 at the door would convert a 15 s tail into an immediate,
   honest rejection, and would keep `GET /orders` and `GET /api/health`
   responsive while takers rush. Today the tail reaches the configured 15 s
   request timeout at 500 concurrent sources.
5. **Give verification more than one core, once the two items above are done.**
   A pool of verifier workers, or several book processes behind the proxy with
   the store partitioned or shared, is the only way past the 170 requests per
   second ceiling. This is a larger change than the rest and it only pays off
   after the persistence barrier is gone.
6. **Reconsider how long a consumed proposal slot is held.** An order admits 8
   proposals per 120 s regardless of demand. Releasing the slot when the maker
   publishes a `FillV2` that selects a different proposal, or shortening the
   default signed proposal lifetime, would raise the effective admission rate
   for a hot order without touching `MAX_FILL_INTENTS_PER_ORDER`. This is an
   economic and protocol decision, and the slot-holding rule exists on purpose,
   so it wants evidence from real usage first.
7. **Do not point an aggressive liveness probe at `/api/health` under load.**
   It exceeded a 10 s client timeout at 200 and 500 takers. Any
   restart-on-failure supervision needs a much larger timeout, or it will
   restart a healthy book during a rush.

## Limits of this test

The numbers describe shape and ratio. They are not an absolute capacity figure
for any real deployment.

- **One machine, loopback only.** Client and server shared 20 logical cores and
  one NVMe-backed virtual disk. There is no network latency, no TLS, no reverse
  proxy and no Cloudflare in the path. Real deployments add all four, which
  raises absolute latency and changes where queues form.
- **The fsync figure is device specific.** 15.5 ms is what this virtual disk
  costs. A server NVMe with a power-loss-protected cache would be much faster,
  and a network block device much slower. The ratio between the persistence
  path and the verification path is the transferable result.
- **The harness is a competing workload.** It ran at the same niceness as the
  book. The responsiveness probe is a separate process for exactly this reason
  and its per-tick grid drift stayed at or below 1.1 ms at the 99th percentile
  in every run, but the client side still consumed cores a real deployment
  would not.
- **In-flight concurrency was capped at 64** to keep the workstation usable.
  The taker count is the population; 64 is how many of them can have a request
  outstanding at once. A real rush with 500 genuinely simultaneous sockets
  would produce a longer tail than measured here.
- **Signed proposals live 120 s**, which bounds how long one pre-signed batch
  can drive load. Runs end when the pre-signed supply drains or the duration
  expires, whichever comes first, and each scenario reports which one it hit.
  Scenario a is bounded by its round count, so `--duration` only caps it.
- **The health probe keeps one request outstanding**, so when the book is slow
  it takes few samples. Its percentiles at those moments come from a handful of
  observations; the missed-tick count is the more reliable signal of how long
  the endpoint was unusable.
- **Paths not exercised.** Federation peer sync ran with zero peers. Feed
  compaction never triggered, because it needs more than 4096 retained events
  and the admission caps make that unreachable inside a short run. Presence
  expiry, the 48 h open-order TTL and the retained-artifact ceilings were not
  reached. Storage-failure handling and graceful shutdown under active load
  were not tested beyond the clean restart check.
- **Synthetic identities.** Every taker used a distinct forwarded address,
  which is the best case for the per-source budgets. A real adversary rotating
  addresses gets the same result, and the code comments already say these caps
  are fairness for demo traffic and not sybil resistance. Scenario e measures
  the opposite extreme, where every client shares one address. The double-fill
  probe deliberately keeps using per-maker addresses even in that scenario, so
  the shared source's mutation budget cannot refuse a correctness check.
