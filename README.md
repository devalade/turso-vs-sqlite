# turso-vs-sqlite

Benchmarks [Turso](https://github.com/tursodatabase/turso) (the Rust rewrite of SQLite) against
C SQLite, using two bindings for the latter:

| Engine | Package | What it is |
| --- | --- | --- |
| `turso` | `@tursodatabase/database` | SQLite reimplemented in Rust, via its better-sqlite3 compat layer |
| `better-sqlite3` | `better-sqlite3` | The standard C SQLite N-API binding |
| `node:sqlite` | built into Node 22.5+ | C SQLite shipped inside Node itself |
| `turso-next` | `@tursodatabase/database@0.8.0-pre.1` | Turso's prerelease line, aliased as `turso-next` (opt-in, see below) |

All three expose a synchronous, better-sqlite3-shaped API, so **the benchmark body is
identical code for every engine** — no per-engine fast paths that would skew the comparison.

Three suites:

- **`src/prod.js` — production profile.** A realistic app workload against a dataset larger
  than the page cache, reporting tail latency. **Read this one first** — its conclusions
  differ substantially from the micro-benchmarks.
- **`src/bench.js` — single-threaded micro-benchmarks.** Isolated per-operation cost.
- **`src/concurrent.js` — concurrent micro-benchmarks.** Multi-threaded lock contention.

## Run it

```bash
npm install
npm run verify                    # confirm every engine really is on WAL
npm run prod                      # production profile — start here
npm run compare                   # micro-benchmarks, 3 runs, consolidated tables
npm run bench                     # single-threaded micro-benchmarks
npm run concurrent                # concurrent contention micro-benchmarks
```

Flags:

```bash
node src/bench.js \
  --engines turso,better-sqlite3 \   # subset of engines
  --workloads select-point,select-join \
  --rows 100000 \                    # seeded dataset size
  --iterations 5000 \                # 0 = auto-size per workload
  --warmup 500 \                     # 0 = 10% of iterations
  --json out.json
```

## Turso version

Benchmarked against **`@tursodatabase/database@0.7.1`**, the latest stable at time of writing
(published 2026-07-22). Turso is pre-1.0 and ships frequently, so re-check before trusting
these numbers:

```bash
npm view @tursodatabase/database dist-tags
```

A **`0.8.0-pre.1`** prerelease also exists, published outside any dist-tag (so plain
`npm install` will not pick it up). It's installed here under an alias for comparison:

```bash
npm i turso-next@npm:@tursodatabase/database@0.8.0-pre.1
node src/bench.js --engines turso,turso-next
```

Measured side by side, 0.8.0-pre.1 is **within noise of 0.7.1** on every workload — no
consistent direction, ±10% at the extremes (~9% faster on full-scan aggregate, ~11% slower on
batched inserts). So the gap against C SQLite reported below is not an artifact of testing a
stale build. Drop `turso-next` from `--engines` (or uninstall it) if you only care about
released versions.

## Workloads

| Name | What it measures |
| --- | --- |
| `insert-single` | One INSERT per iteration, autocommit — worst-case write path |
| `insert-tx-batch` | 1000 INSERTs in one transaction — bulk write throughput |
| `select-point` | Primary-key lookup — the most common OLTP read |
| `select-range-indexed` | Indexed range scan returning ~50 rows |
| `select-fullscan-agg` | `COUNT` + `AVG` over the whole table — scan speed |
| `select-join` | Two-table join on an indexed FK |
| `update-point` | Primary-key UPDATE, autocommit |

Every engine gets the same pragmas (`journal_mode=WAL`, `synchronous=NORMAL`) and the same
seeded data, generated from a fixed-seed PRNG so the datasets are byte-identical.

## Verifying the configuration

Setting a pragma isn't the same as it taking effect — an engine can silently ignore what it
doesn't implement, quietly making a "fair" comparison unfair. `npm run verify` reads the
pragmas back and proves WAL is real by checking a `-wal` sidecar actually appears on write:

```
on-disk databases  (./data)
  engine          journal_mode  synchronous  -wal file  vs expected
  better-sqlite3  wal           1            yes        ok
  node:sqlite     wal           1            yes        ok
  turso           wal           1            yes        ok
  turso-next      wal           1            yes        ok
```

**Verified: WAL is genuinely active on all four engines**, with `synchronous=NORMAL` (1)
everywhere, against real on-disk databases.

There is deliberately **no in-memory mode**. C SQLite cannot use WAL for `:memory:` databases
and silently falls back to `journal_mode=memory`, while Turso reports `wal` — the engines
would not be journaling alike, so the comparison would be meaningless. Passing
`path: ":memory:"` now throws rather than producing quietly incomparable numbers.

Turso never creates a `-shm` file (different shared-memory implementation); that's expected
and not a problem.

## Where the databases live

Benchmarks create real SQLite files under `./data/` (override with `BENCH_DATA_DIR`), deleted
on close. To keep one around and poke at it:

```bash
sqlite3 data/<file>.db 'PRAGMA journal_mode; SELECT count(*) FROM users;'
```

## Concurrent suite

`src/concurrent.js` spawns N `worker_threads`, each with **its own connection to the same
database file**, all released simultaneously from an `Atomics` barrier so they genuinely
contend rather than trickling in. Throughput for each role is measured over that role's own
window, not the global wall clock.

```bash
node src/concurrent.js \
  --engines turso,better-sqlite3 \
  --scenario write-contention,read-write-mix \
  --threads 1,2,4,8 \       # thread counts to sweep
  --ops 2000 \              # operations per worker
  --batchSize 1 \           # writes per transaction (>1 = batched writers)
  --timeout 10000 \         # busy timeout, ms
  --json out.json
```

| Scenario | Shape | What it shows |
| --- | --- | --- |
| `write-contention` | N writers, 0 readers | SQLite serializes writers, so this should *not* scale — it measures how gracefully each engine degrades under lock contention |
| `read-write-mix` | 1 writer + N readers | WAL's headline property: readers don't block on the writer, so reads *should* scale |

## Results

`npm run compare` runs **both suites N times and consolidates everything into one set of
tables**. Each repetition is a fresh child process, so JIT state and warmed page cache from
one run don't hand the next run an unearned advantage.

```bash
npm run compare                          # 3 runs, all 4 engines, both suites
node src/compare.js --runs 5             # more repetitions
node src/compare.js --skipConcurrent     # single-threaded suite only
```

Reported value is the **median across runs**, and `±` is the spread `(max−min)/median`.
**Read the spread before believing a gap** — anything under roughly ±30% difference on a row
with a ±30% spread is machine weather, not an engine difference.

Below: 3 runs, Node v24.14.1, darwin/arm64 (M-series, 8 threads), 10k seeded rows, on-disk WAL.

### Single-threaded throughput (ops/sec, higher is better)

| Workload | better-sqlite3 | node:sqlite | turso | turso-next | Best |
| --- | --- | --- | --- | --- | --- |
| insert-single | 70.3k ±50% | 81.1k ±25% | 88.7k ±16% | **93.3k ±11%** | turso-next (1.05x) |
| insert-tx-batch | 921.7k ±10% | **1.21M ±12%** | 314.7k ±10% | 307.9k ±6% | node:sqlite (1.31x) |
| select-point | **818.5k ±16%** | 636.1k ±13% | 386.9k ±11% | 381.9k ±18% | better-sqlite3 (1.29x) |
| select-range-indexed | **74.2k ±14%** | 51.8k ±13% | 13.1k ±10% | 13.2k ±7% | better-sqlite3 (1.43x) |
| select-fullscan-agg | **6.8k ±5%** | 6.1k ±2% | 1.5k ±3% | 1.6k ±1% | better-sqlite3 (1.13x) |
| select-join | **570.4k ±4%** | 479.9k ±5% | 196.3k ±2% | 201.5k ±1% | better-sqlite3 (1.19x) |
| update-point | 66.6k ±4% | 69.4k ±1% | 82.6k ±3% | **83.3k ±1%** | turso-next (1.01x) |

### Single-threaded p99 latency (lower is better)

| Workload | better-sqlite3 | node:sqlite | turso | turso-next |
| --- | --- | --- | --- | --- |
| insert-single | 29.3 µs ±43% | **25.2 µs ±12%** | 26.4 µs ±4% | 26.3 µs ±26% |
| insert-tx-batch | 3.311 ms ±21% | **2.961 ms ±15%** | 4.188 ms ±124% | 4.084 ms ±85% |
| select-point | **1.6 µs ±16%** | 2.0 µs ±10% | 3.2 µs ±8% | 3.3 µs ±18% |
| select-range-indexed | **17.3 µs ±9%** | 26.5 µs ±6% | 86.1 µs ±8% | 96.6 µs ±52% |
| select-fullscan-agg | **168.2 µs ±53%** | 184.4 µs ±25% | 773.5 µs ±21% | 709.5 µs ±2% |
| select-join | **2.1 µs ±4%** | 2.8 µs ±15% | 6.0 µs ±5% | 6.0 µs ±4% |
| update-point | 18.8 µs ±121% | 19.0 µs ±5% | 21.0 µs ±24% | **18.6 µs ±8%** |

### Concurrent — write-contention, writers (ops/sec)

| Threads | better-sqlite3 | node:sqlite | turso | turso-next | Best |
| --- | --- | --- | --- | --- | --- |
| 1 | 129.5k ±4% | **134.2k ±3%** | 128.3k ±6% | 114.4k ±1% | node:sqlite (1.04x) |
| 4 | 91.3k ±45% | 82.8k ±36% | **115.0k ±29%** | 101.9k ±17% | turso (1.13x) |
| 8 | 94.6k ±37% | 65.9k ±16% | **98.4k ±10%** | 89.5k ±11% | turso (1.04x) |

### Concurrent — read-write-mix (1 writer + N readers)

Readers (ops/sec):

| Readers | better-sqlite3 | node:sqlite | turso | turso-next | Best |
| --- | --- | --- | --- | --- | --- |
| 1 | **201.3k ±3%** | 148.4k ±37% | 113.1k ±15% | 111.5k ±39% | better-sqlite3 (1.36x) |
| 4 | 514.8k ±5% | **582.9k ±50%** | 250.3k ±7% | 236.0k ±6% | node:sqlite (1.13x) |
| 8 | **714.3k ±25%** | 599.2k ±24% | 264.3k ±10% | 254.8k ±11% | better-sqlite3 (1.19x) |

Writers in that same mix (ops/sec):

| Readers | better-sqlite3 | node:sqlite | turso | turso-next | Best |
| --- | --- | --- | --- | --- | --- |
| 1 | 86.4k ±0% | **92.1k ±24%** | 88.5k ±11% | 85.2k ±41% | node:sqlite (1.04x) |
| 4 | 56.7k ±10% | **67.5k ±25%** | 58.6k ±18% | 57.5k ±6% | node:sqlite (1.15x) |
| 8 | **53.4k ±12%** | 51.1k ±17% | 31.5k ±9% | 29.6k ±13% | better-sqlite3 (1.04x) |

### What holds up across 3 runs

Only the gaps far larger than their spread are trustworthy:

- **Turso is 4–6x slower on scans** (`select-range-indexed`, `select-fullscan-agg`) with
  spreads of only ±1–14%. This is the most solid finding in the whole benchmark.
- **Turso is ~3x slower on batched-transaction inserts** (315k vs. 1.21M), spread ±6–12%.
- **Turso is ~1.5–2x slower on point reads and joins**, spread ±1–18%. Real, if smaller.
- **Turso is modestly faster on autocommit single-row writes** (`insert-single`,
  `update-point`) — but `insert-single` carries a ±50% spread on better-sqlite3, so treat the
  insert win as unproven; `update-point` (±1–4%) is the credible one.
- **Nothing is conclusive in the concurrent write results.** Spreads of ±29–45% swamp the
  1.04–1.13x leads, so "turso wins write-contention at 4 and 8 threads" is *not* supported by
  3 runs. It was a cleaner-looking result in the earlier single run; repetition dissolved it.
- **Reads scale for every engine** under a concurrent writer, confirming WAL works, but Turso
  stays ~2–2.5x behind in absolute terms throughout.
- `turso` and `turso-next` (0.8.0-pre.1) remain indistinguishable everywhere.

## Production profile

The micro-benchmarks above measure isolated operations against a small, fully-cached table.
That is useful for attributing cost, but it is **not** how a service behaves. `src/prod.js`
runs a deliberately more realistic profile:

| Micro-benchmark | Production profile |
| --- | --- |
| 10k rows, fits in cache | ~100 MB–1.8 GB dataset, exceeds the page cache |
| narrow 5-column rows | wide rows with a JSON metadata column |
| one index | UNIQUE email index + two composite indexes, so writes pay index maintenance |
| one operation at a time | weighted **85% read / 15% write mix** on every connection |
| fixed iteration count | sustained load for a fixed duration under N threads |
| mean throughput | **tail latency per query type** — p50 / p99 / p99.9 |

```bash
npm run prod                                  # scale=small, 4 threads, 15s
npm run prod:medium                           # scale=medium, 30s
node src/prod.js --scale large --threads 8 --duration 60 --json out.json
node src/prod.js --fresh                      # rebuild the seeded template
```

Scales: `small` (100k users / 400k orders, ~100 MB), `medium` (400k / 2M, ~600 MB),
`large` (1M / 6M, ~1.8 GB). `--cache` sets `cache_size` (default 64 MB, as a tuned app would).

The dataset is seeded **once** into a template file and byte-copied per engine, so every
engine reads an identical physical page layout — a stronger fairness guarantee than reseeding.

The query mix is a billing-style app: point lookup by id, lookup by unique email, a customer's
recent orders (`ORDER BY ... LIMIT 20`), keyset pagination over a composite index, a revenue
dashboard aggregate, order inserts, and status updates.

### Production results

scale=small (~99 MB), 4 threads, 15s sustained, 64 MB cache. Throughput across 3 runs:

| Engine | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| better-sqlite3 | 9.8k | 8.7k | 9.3k |
| node:sqlite | **10.7k** | **10.5k** | **9.9k** |
| turso | 8.2k | 6.6k | 4.8k* |

\* the 4.8k was machine state during a long session, not a Turso regression — run in
isolation Turso gives 7.4k / 6.2k / 7.1k. Treat Turso as ~6.5–8k here.

p99 latency by query (the number that pages you at 3am):

| Query | Kind | better-sqlite3 | node:sqlite | turso |
| --- | --- | --- | --- | --- |
| user_by_id | read | 503 µs | **69 µs** | 237 µs |
| user_by_email | read | 513 µs | **71 µs** | 239 µs |
| orders_by_user | read | 531 µs | **74 µs** | 248 µs |
| users_by_plan_page | read | 575 µs | **178 µs** | 381 µs |
| revenue_dashboard | read | 5.833 ms | **5.691 ms** | 6.853 ms |
| insert_order | write | 5.398 ms | 5.109 ms | **1.203 ms** |
| update_order_status | write | 5.495 ms | 5.104 ms | **1.202 ms** |

### What production realism changes

The realistic profile **substantially contradicts** the micro-benchmarks:

- **The throughput gap collapses.** Turso is ~1.3–1.5x behind here, not the 2–6x the
  micro-benchmarks showed. Once real I/O and a heavy aggregate are in the mix, per-operation
  engine overhead stops dominating.
- **Turso wins write tail latency decisively** — p99 insert/update of ~1.2 ms vs ~5.1–5.4 ms
  for both C SQLite bindings, a **4x advantage**, stable across all 3 runs (1.20/1.27/1.86 ms
  vs 5.40/5.48/5.50 ms). This is the single most production-relevant result in this repo and
  it is invisible in the micro-benchmarks.
- **better-sqlite3 has the worst read tail** despite winning nearly every micro-benchmark: its
  p99 read is ~500 µs vs node:sqlite's ~70 µs. Same C engine underneath — so this is binding
  and scheduling behaviour under concurrent load, not SQLite itself.
- **One query dominates the budget.** `revenue_dashboard` is 10% of operations but ~3 ms each,
  so it consumes more wall time than every point lookup combined. In production you would
  cache or precompute it — and the engine choice would matter far less than doing that.

Which is to say: if your workload looks like this mix, **the engine is not your bottleneck.**

## Questions for the Turso team

This repo exists to ask better questions, not to render a verdict. Turso is pre-1.0 and the
numbers here are from one laptop. Specific things I'd like to understand:

1. **Scan performance is the largest gap.** `select-range-indexed` (~5x) and
   `select-fullscan-agg` (~4x) are the most reproducible results in the repo (spread ±1–14%
   across 3 runs). Is this a known gap, and is it a query-planner issue, a B-tree/page-layout
   issue, or the row-decoding path? Is it on the roadmap, or an accepted trade-off?

2. **Write tail latency is 4x BETTER than C SQLite** — p99 of ~1.2 ms vs ~5.1–5.4 ms on the
   production mix, consistently. Is that a deliberate design outcome (different commit or
   fsync scheduling)? And critically: **is it giving up any durability guarantee** relative to
   C SQLite at `synchronous=NORMAL`, or is it a genuine improvement?

3. **How much of the read gap is the compat layer?** All benchmarks here use
   `@tursodatabase/database/compat` for an apples-to-apples sync API against better-sqlite3.
   How much of the ~2x point-read gap is N-API/compat overhead vs the core engine? Would the
   async `promise` API show a different picture?

4. **How should `BEGIN CONCURRENT` / MVCC be benchmarked fairly?** I deliberately did not use
   it, since the C engines have no equivalent and it would be apples-to-oranges — but it seems
   central to Turso's pitch. What workload shape actually demonstrates the win, and what
   should it be compared against?

5. **Which pragmas are honored?** `journal_mode=WAL` and `synchronous=NORMAL` verifiably take
   effect (`npm run verify`). `cache_size` I set but did not verify. Is there a documented
   list of supported vs silently-ignored pragmas? Silently-ignored pragmas are an easy way for
   a third-party benchmark to become unfair without noticing.

6. **No `-shm` file is created.** WAL clearly works (a `-wal` sidecar appears and readers see
   writers' data), so this is presumably a different shared-memory design. Does that change
   anything for **multi-process** access to the same file, which this repo does not test?

7. **Is `:memory:` meant to report `journal_mode=wal`?** C SQLite falls back to
   `journal_mode=memory` for in-memory databases; Turso reports `wal`. Minor, but it silently
   makes in-memory cross-engine comparisons unfair (this repo therefore refuses to run them).

If any of the methodology here is wrong, PRs and issues are very welcome — the harness is
deliberately structured so every engine runs identical code paths.

## Caveats

- Turso defaults to `synchronous=FULL`; the harness explicitly sets it to `NORMAL` to match
  the others. Without that override its write numbers would look worse for the wrong reason.
- Latency percentiles come from `process.hrtime.bigint()` around each iteration, which adds
  a small constant overhead to sub-microsecond operations equally across engines.
- Run on an otherwise idle machine; every benchmark hits a real on-disk database, and macOS
  filesystem behavior makes those write numbers noisy. Three runs is enough to *expose* that noise (see the `±` columns) but not enough to
  average it out — the write-contention rows would need 10+ runs to separate engines that sit
  within ~15% of each other. Reach for `--runs 10` before making a decision on those.
- The concurrent suite uses threads within one process. Cross-*process* contention (separate
  PIDs sharing a file) exercises different locking paths and is not covered.
- Turso's `BEGIN CONCURRENT` / MVCC-style concurrent writes are a headline feature, but the
  compat layer used here takes the plain-transaction path that all three engines share. Using
  it would make the comparison apples-to-oranges, so it is deliberately not benchmarked; it
  may well be where Turso's concurrency story actually pays off.
- No network/replication: this measures the embedded engine only, not Turso's remote-database
  or sync offering.
- The production profile runs against a warm OS page cache (the template was just written or
  read). Genuinely cold-cache numbers need `sudo purge` on macOS between runs; expect the
  read tails to be considerably worse than reported here.
- Production results are 3 runs at `scale=small`. Throughput carries roughly ±25% run-to-run
  noise, so only the large, repeated gaps (the write-tail result) should be trusted.

## Reproducing

```bash
npm install
npm run verify     # confirm WAL + synchronous=NORMAL on every engine
npm run prod       # production profile (most representative)
npm run compare    # micro-benchmarks, 3 runs, consolidated
```

Results in this README: Node v24.14.1, darwin/arm64, Apple Silicon (8 threads), on-disk WAL,
APFS SSD. Numbers will differ on other hardware — especially the write paths, which are
dominated by fsync behaviour.

## License

MIT
