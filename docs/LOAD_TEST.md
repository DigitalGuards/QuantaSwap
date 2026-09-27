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

Everything from here to
[Recommendations](#recommendations-ranked-by-impact) is the measurement that
motivated the write-path work, kept as it was recorded. The
[After write-path changes](#after-write-path-changes) section at the end is the
same harness on the same machine against the new code.

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

Items 1, 2 and 4 have since landed. This list is kept as it was written; the
measurements of what they changed are in
[After write-path changes](#after-write-path-changes).

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

## After write-path changes

Four changes landed in the write path after the measurements above:

1. **Group commit.** A mutation changes memory, marks the store dirty and
   returns. One commit at a time serialises the whole order map, rewrites
   `orders.json`, fsyncs it, and appends that batch's public events to the feed
   log under one further barrier. The commit runs at the end of the event-loop
   turn, so every mutation that completed in that turn shares one durability
   barrier. A request still reports success only after the commit that carries
   its mutation completed.
2. **Shed before verify.** The order state, its remaining runway, the per-order
   live-proposal count and the caller's concurrent and daily source budgets now
   answer before ML-DSA-87 verification on `POST /orders/:id/intents`. A request
   whose `auth.nonce` matches a retained proposal skips that gate and is
   verified, and every check that reads signed content stays behind
   verification.
3. **An in-flight bound for mutations**, `ORDERBOOK_MAX_INFLIGHT_MUTATIONS`, 32
   by default, of which `ORDERBOOK_RESERVED_MAKER_MUTATIONS`, 8 by default,
   only the maker write routes can reach. Past the bound a mutation is refused
   with `503`, `Retry-After: 1` and `X-Refusal-Stage: pre-verification`. Reads,
   heartbeats, the SSE stream, `/api/health` and `/api/status` are never gated.
4. **A separate bound and deadline for reading bodies**,
   `ORDERBOOK_MAX_INFLIGHT_BODY_READS` (256, at most 8 per source) and
   `ORDERBOOK_BODY_READ_TIMEOUT_MS` (3 s). A mutation takes its in-flight slot
   only once its body is in hand.

Same machine, same flags, same harness. Every figure below is a fresh run of
`nice -n 15 npm run loadtest -- --takers <N> --duration 20 --scenarios a,b,c,e`
plus the paired sequential control, exactly as documented above.

**How a shed is counted.** The harness no longer guesses from the message
text. The book marks every refusal it produced before verifying anything with
`X-Refusal-Stage: pre-verification`, and the harness reads that header. This
matters for correctness of the numbers below: the same message can be a cheap
shed for a new nonce and a fully verified refusal for a proposal the order
already retains, so the earlier draft of this section, which classified by
message, could not have told those apart.

### The same work finishes in a fraction of the time

`POST /orders/:id/intents` during the measured window, before and after. Each
cell is `before -> after`.

| N | Scenario | Submitted | Admitted | req/s | p50 ms | p95 ms | p99 ms | max ms |
| --: | --- | --: | --- | --- | --- | --- | --- | --- |
| 50 | a hot order | 300 | 8 -> 8 | 97.0 -> 201.8 | 164 -> 10 | 346 -> 101 | 429 -> 131 | 444 -> 131 |
| 50 | b spread | 300 | 189 -> 191 | 55.6 -> 180.4 | 613 -> 213 | 5299 -> 1639 | 5364 -> 1642 | 5380 -> 1644 |
| 50 | c mixed | 300 | 176 -> 179 | 14.6 -> 14.6 | 482 -> 192 | 5522 -> 1753 | 5592 -> 1753 | 5609 -> 1753 |
| 50 | e shared address | 300 | 4 -> 4 | 446.2 -> 1829.2 | 46 -> 7 | 657 -> 147 | 660 -> 149 | 660 -> 150 |
| 100 | a hot order | 600 | 8 -> 8 | 126.8 -> 379.1 | 270 -> 13 | 547 -> 133 | 695 -> 159 | 729 -> 161 |
| 100 | b spread | 600 | 192 -> 192 | 84.9 -> 368.9 | 210 -> 26 | 5473 -> 1330 | 7018 -> 1608 | 7050 -> 1609 |
| 100 | c mixed | 600 | 174 -> 180 | 29.3 -> 28.9 | 235 -> 35 | 6479 -> 1693 | 7268 -> 1740 | 7300 -> 1740 |
| 100 | e shared address | 600 | 4 -> 4 | 815.9 -> 2319.1 | 5 -> 14 | 652 -> 138 | 725 -> 153 | 725 -> 169 |
| 200 | a hot order | 1200 | 8 -> 8 | 149.3 -> 696.8 | 333 -> 11 | 360 -> 90 | 1264 -> 197 | 1333 -> 200 |
| 200 | b spread | 1200 | 192 -> 192 | 115.9 -> 609.0 | 250 -> 12 | 703 -> 284 | 9664 -> 1883 | 10336 -> 1955 |
| 200 | c mixed | 1200 | 175 -> 175 | 58.6 -> 58.1 | 255 -> 19 | 595 -> 794 | 10836 -> 3350 | 10896 -> 3351 |
| 200 | e shared address | 1200 | 4 -> 4 | 1551.0 -> 4817.4 | 5 -> 5 | 148 -> 64 | 715 -> 190 | 722 -> 206 |
| 500 | a hot order | 3000 | 8 -> 8 | 171.3 -> 1306.4 | 332 -> 14 | 345 -> 38 | 669 -> 193 | 3001 -> 313 |
| 500 | b spread | 3000 | 192 -> 192 | 151.0 -> 1538.7 | 331 -> 11 | 1042 -> 248 | 1264 -> 343 | 10140 -> 1639 |
| 500 | c mixed | 2938 -> 3000 | 173 -> 180 | 140.5 -> 146.5 | 321 -> 11 | 507 -> 189 | 6904 -> 1755 | 15042 -> 2070 |
| 500 | e shared address | 3000 | 4 -> 4 | 3228.5 -> 5345.5 | 5 -> 9 | 54 -> 18 | 321 -> 70 | 721 -> 139 |

Admitted counts are still flat in N and still match the documented policy
exactly. All 40 cap assertions across these 16 scenario runs held, as did every
invariant check, with zero transport errors and no 5xx replies other than the
bound's own refusals.

Scenario c is bound by its 20 s duration, so its request rate cannot rise; what
moved there is the tail, from 10.9 s at 200 takers and 15.0 s at 500 to between
1.7 s and 3.4 s. That scenario is the noisiest of the four, because its maker
cancel and repost cycles compete with the taker stream inside one 20 s window:
repeated runs at 200 takers put its p99 between 1.7 s and 3.4 s. The other
three scenarios drain a fixed pre-signed batch as fast as the book will take
it, so their rate is the capacity figure. The same batch now drains in:

| N | Scenario a | Scenario b |
| --: | --- | --- |
| 50 | 3.1 s -> 1.5 s | 5.4 s -> 1.7 s |
| 100 | 4.7 s -> 1.6 s | 7.1 s -> 1.6 s |
| 200 | 8.0 s -> 1.7 s | 10.4 s -> 2.0 s |
| 500 | 17.5 s -> 2.3 s | 19.9 s -> 2.0 s |

The drain time is now nearly flat in the taker count, which is what a shedding
path that costs almost nothing looks like.

### Refusing a proposal costs a fiftieth of what it did

Book CPU as a percentage is no longer comparable between the two runs, because
the same work now finishes in a quarter to a tenth of the wall time. CPU
milliseconds per submitted mutation-class request is comparable:

| N | Scenario | CPU ms per submitted request |
| --: | --- | --- |
| 200 | a hot order | 5.96 -> 0.39 |
| 200 | b spread | 6.73 -> 1.58 |
| 500 | a hot order | 5.70 -> 0.41 |
| 500 | b spread | 6.03 -> 0.72 |
| 500 | c mixed | 6.26 -> 1.30 |

The clearest case is the hot-order race at 500 takers. It used to spend 17.1 s
of CPU to refuse 2992 proposals that could not be admitted. It now spends
1.23 s of CPU for the whole scenario, admissions included, and reaches 54% of
one core where it used to sit at 98%. Per refused proposal that is 5.7 ms
before and 0.41 ms after, a factor of 14.

The harness reports those refusals in their own bucket, on the book's own
statement of the stage it answered at. At 200 takers scenario a shows all 1192
refusals shed before verification at an 11.4 ms p50 and zero refused after
verification. The sequential control still measures the post-verification
refusal path, because its refusals are `account_pending_intent`, the check that
deliberately stays behind verification.

### Reads and the health probe stay answerable

`GET /orders` in the mixed workload, where eight clients poll at 5 Hz:

| N | p50 ms | p95 ms | achieved req/s |
| --: | --- | --- | --- |
| 50 | 3.2 -> 2.6 | 436 -> 49 | 31.5 -> 37.0 |
| 100 | 3.3 -> 3.0 | n/a -> 131 | n/a -> 34.6 |
| 200 | 3.2 -> 2.8 | 436 -> 132 | 31.5 -> 34.6 |
| 500 | 339 -> 2.5 | n/a -> 80 | 13.8 -> 36.7 |

The read collapse at 500 takers is gone. The eight pollers keep 36.7 requests
per second at a 2.5 ms median, where the earlier run had them down to 13.8 per
second at a 339 ms median. The before column reports the two figures the
earlier run recorded: a 3.2 to 3.3 ms p50 with a 436 ms p95 up to 200 takers,
and the collapse at 500.

The externally probed `GET /api/health`, for the four cases the earlier run
called unusable:

| N | Scenario | Probe samples | Grid ticks missed | Replies not 200 | Worst reply |
| --: | --- | --- | --- | --- | --- |
| 200 | b spread | 2 -> 1 | 101 -> 18 | 1 -> 0 | 10.0 s -> 1.82 s |
| 200 | c mixed | 97 -> 190 | 107 -> 16 | 1 -> 0 | 10.0 s -> 0.52 s |
| 500 | b spread | 15 -> 4 | 183 -> 15 | 1 -> 0 | 10.0 s -> 1.52 s |
| 500 | c mixed | 14 -> 183 | 194 -> 21 | 1 -> 0 | 10.0 s -> 2.02 s |

No probe request exceeded its 10 s client timeout in any run, at any taker
count. In the 20 s mixed workload the probe now takes almost every sample it
schedules, 190 of about 205 at 200 takers and 183 at 500.

Read the spread rows with care. Scenario b's measured window collapsed to about
2 s, so the probe only has 20 grid slots to sample in the first place, and
losing 15 of them means the book was saturated for most of a 2 s burst rather
than most of a 10 s one. The sample counts are small for that reason, and the
missed-tick count is still the honest signal: the window where `/api/health` is
slow shrank from about 10 s to about 2 s, and it never stopped answering.

### Queue-free service time is unchanged

The paired control, 50 takers, strictly sequential, run once on the disk-backed
filesystem and once on a memory filesystem:

| Measure | Disk before | Disk after | Memory before | Memory after |
| --- | --: | --: | --: | --: |
| Admitted, verify plus persist, p50 | 24.7 ms | 26.3 ms | 9.2 ms | 10.3 ms |
| Refused after verification, p50 | 5.9 ms | 6.4 ms | 6.1 ms | 7.1 ms |
| Sequential listing read, p50 | 1.8 ms | 1.8 ms | 1.6 ms | 2.5 ms |
| Admitted, first quarter | 23.0 ms | 25.6 ms | 8.3 ms | 9.1 ms |
| Admitted, last quarter | 25.6 ms | 27.0 ms | 10.3 ms | 11.5 ms |
| Admitted throughput | 35.3/s | 32.8/s | 76.7/s | 66.6/s |
| Book CPU during the window | 49% | 51% | 98% | 98% |

This is the expected result and it is worth stating plainly: with one request in
flight there is nothing to batch, so a group commit carries exactly one
mutation and costs the same barrier it always did, plus one event-loop hop. The
one to two millisecond difference is that hop and run-to-run noise. Every gain
above comes from concurrency, and the component split measured earlier still
holds: about 6 ms of verification and parsing, about 3.5 ms of serialising and
rewriting, and about 16 ms of fsync barrier, now shared.

### A promised body no longer holds a writer's slot

The first version of the in-flight bound took its slot before the body was
read, which turned a cheap client trick into a full write outage. A probe
reproduced it: two sockets sending nothing but `POST /api/orders` headers and a
`Content-Length` held the only two slots of a bound set to 2, and a legitimate
create then answered `503` for the whole 15 s request timeout while
`/api/health` still said `ok`. The bound now covers verification and the commit,
the body is read first under its own bound and a 3 s deadline, and the same
probe answers `201`. A half-open request is answered `408` at the deadline and
its remaining bytes are discarded without being buffered.

Bursts of genuinely simultaneous sockets against a book with the default
settings, which give takers 24 of the 32 slots:

| Burst | Created | Refused 503 | Wall |
| --: | --: | --: | --: |
| 12 unsigned creates | 12 | 0 | 60 ms |
| 64 unsigned creates | 46 | 18 | 300 ms |
| 12 unsigned creates, bound 2 and 1 reserved | 5 | 7 | 58 ms |

The 64-request burst admits more than the 24-slot ceiling because slots recycle
inside the 300 ms the burst takes.

### The in-flight bound is insurance, and 32 is the right default

At the harness's 64-request in-flight cap the default bound is reached, but
only just: one refusal in the spread workload at 200 takers and 28 at 500. That
figure describes the harness. Its 64 workers each hold one request at a time
and pace themselves on a shared machine, so the concurrency that reaches the
book is lower than the cap suggests, and the bursts above show the bound
engaging exactly as specified when the concurrency is real.

Lowering the bound buys latency and pays for it in admissions. Measured at 200
takers on scenarios b and c, with an eighth of each bound reserved for maker
routes:

| Bound | b admitted | b req/s | b max ms | c admitted | c p99 ms | c probe missed | Gate refusals |
| --- | --: | --: | --: | --: | --: | --: | --: |
| 8 | 72 | 1013.1 | 1161 | 64 | 943 | 9 | 189 in b, 82 in c |
| 32 (default) | 192 | 609.0 | 1955 | 175 | 3350 | 16 | 1 in b, 0 in c |
| 1024 | 192 | 677.8 | 1749 | 180 | 1913 | 19 | 0 |

At 8 the probe and the tail are the best of the three, and the book sheds work
the policy would have admitted: 72 proposals in the spread workload against the
192 the policy allows, and 64 in the mixed workload against 180. An earlier run
at that setting also refused a maker repost. A maker repricing its book cancels
and reposts every listing inside one mutation window, 28 listings at current
production depth, so the bound has to leave room for that burst; the maker
routes now have reserved headroom for exactly this reason. 32 keeps every
documented admission ceiling reachable while holding the health probe inside
2 s, and 1024 measures the same as 32 within noise at this concurrency.

### What the numbers say about the recommendations not taken

- **Recommendation 3, keeping signature material out of the store rows.** Still
  the right next structural change, and now the dominant remaining cost of an
  admitted mutation. A group commit still rewrites the whole 3.21 MiB file, so
  the amplification per mutation only falls with the batch size, and at the
  documented 64-order ceiling it becomes 8.57 MiB per commit. The memory
  filesystem column above shows the byte-count term as the 9.1 ms to 11.5 ms
  drift across the run with the barrier removed.
- **Recommendation 5, more than one core of verification.** The case for it is
  weaker than it was. One core of ML-DSA-87 verification was the wall behind
  the fsync barrier, and it still bounds admitted throughput, but the cost per
  refused proposal fell by a factor of 14 and refusals are the overwhelming
  majority of a rush. At 500 takers racing one order the book now answers
  1306 requests per second on 54% of one core. A verifier pool would raise the
  admitted ceiling only, which the per-order and per-source policy caps already
  hold well below what one core can verify.
- **Recommendation 6, how long a consumed proposal slot is held.** Unchanged and
  still an economic decision. The per-round figures are still `8, 0, 0, 0, 0, 0`
  in the hot-order race at every taker count. What changed is only the price of
  saying no.
- **Recommendation 7, liveness probes.** Still sound advice, with a smaller
  margin needed. No probe request exceeded 2.1 s in any run here, against a 10 s
  client timeout exceeded at 200 and 500 takers before, so a supervision timeout
  of a few seconds is now defensible where it was not.

### Reproducing these numbers

```bash
cd server
npm ci
for takers in 50 100 200 500; do
  nice -n 15 npm run loadtest -- --takers "$takers" --duration 20 \
    --scenarios a,b,c,e
done
nice -n 15 npm run loadtest -- --takers 50 --duration 30 --scenarios f \
  --run-dir /tmp/orderbook-loadtest-disk
nice -n 15 npm run loadtest -- --takers 50 --duration 30 --scenarios f \
  --run-dir /dev/shm/orderbook-loadtest-memory
```

The admission settings are read from the environment the harness inherits, so
the sensitivity run is the same command with them set:

```bash
ORDERBOOK_MAX_INFLIGHT_MUTATIONS=8 ORDERBOOK_RESERVED_MAKER_MUTATIONS=2 \
  nice -n 15 npm run loadtest -- --takers 200 --duration 20 --scenarios b,c
```
