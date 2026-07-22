/**
 * Async (promise) API benchmark.
 *
 * Turso ships two APIs: the synchronous `/compat` one (used everywhere else in
 * this repo, so all engines run identical code) and an async `promise` one that
 * better-sqlite3 and node:sqlite have no equivalent for.
 *
 * The interesting question is NOT "is async faster" — per-query it is usually
 * slower, since it pays promise and threadpool overhead. It is:
 *
 *   1. Does the async API keep the Node EVENT LOOP responsive while the
 *      database is busy? A synchronous driver blocks the entire process for the
 *      duration of every query. On a 3 ms analytics query that means 3 ms where
 *      the server answers no HTTP requests, fires no timers, and reads no
 *      sockets. That, not throughput, is what a sync driver costs you in prod.
 *
 *   2. Do concurrent in-flight queries on ONE connection actually overlap?
 *      Turso's promise API serializes statement execution on a per-connection
 *      AsyncLock, so the expectation is NO — concurrency needs more connections.
 *      This measures whether that is what actually happens.
 *
 * Run:  node src/async-bench.js
 */
import { parseArgs } from "node:util";
import { copyFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { drivers, DATA_DIR, cleanup } from "./drivers.js";
import { quantile, formatDuration, formatOps } from "./stats.js";

const { values } = parseArgs({
  options: {
    duration: { type: "string", default: "5" }, // seconds per measurement
    concurrency: { type: "string", default: "1,4,16" },
    template: { type: "string", default: join(DATA_DIR, "prod-template-small.db") },
    json: { type: "string" },
  },
});

const durationMs = Number(values.duration) * 1000;
const concurrencies = values.concurrency.split(",").map((n) => Number(n.trim()));

if (!existsSync(values.template)) {
  console.error(
    `Template not found: ${values.template}\nRun \`npm run prod\` once to build it.`,
  );
  process.exit(1);
}

// Two query shapes: a trivial point read, and an analytics query heavy enough
// that blocking the event loop for its duration is visibly bad.
const QUERIES = {
  light: {
    sql: "SELECT id, email, name FROM users WHERE id = ?",
    args: () => [1 + Math.floor(Math.random() * 100_000)],
    method: "get",
  },
  heavy: {
    sql: `SELECT status, COUNT(*) AS n, SUM(amount_cents) AS total
          FROM orders WHERE created_at BETWEEN ? AND ? GROUP BY status`,
    args: () => {
      const from = 1735689600 + Math.floor(Math.random() * 28_000_000);
      return [from, from + 20_000_000];
    },
    method: "all",
  },
};

/**
 * Samples event-loop responsiveness. A timer asks to fire every `interval` ms;
 * however late it actually fires is time the loop was blocked and unable to
 * serve anything else.
 */
function watchEventLoop(intervalMs = 5) {
  const lags = [];
  let last = process.hrtime.bigint();
  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    const actual = Number(now - last) / 1e6;
    lags.push(Math.max(0, actual - intervalMs));
    last = now;
  }, intervalMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      lags.sort((a, b) => a - b);
      return lags;
    },
  };
}

function freshCopy(tag) {
  const path = join(DATA_DIR, `async-${tag}.db`);
  cleanup(path);
  copyFileSync(values.template, path);
  return path;
}

/**
 * Sync driver loop. Yields to the event loop between operations — otherwise the
 * timer could never fire at all and the comparison would be meaningless. This
 * models a server that handles one request per tick: the only blocking measured
 * is the query itself.
 */
async function runSync(queryName) {
  const q = QUERIES[queryName];
  const path = freshCopy("sync");
  const db = await drivers.turso({ path });
  const stmt = db.prepare(q.sql);

  // warmup
  for (let i = 0; i < 50; i++) stmt[q.method](...q.args());

  const watcher = watchEventLoop();
  const latencies = [];
  const deadline = Date.now() + durationMs;
  let ops = 0;

  const t0 = process.hrtime.bigint();
  while (Date.now() < deadline) {
    for (let i = 0; i < 20; i++) {
      const s = process.hrtime.bigint();
      stmt[q.method](...q.args());
      latencies.push(Number(process.hrtime.bigint() - s) / 1e6);
      ops++;
    }
    await sleep(0); // yield, as an event-loop-driven server would
  }
  const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
  const lags = watcher.stop();
  db.close();
  cleanup(path);

  latencies.sort((a, b) => a - b);
  return { mode: "sync (compat)", concurrency: 1, ops, elapsed, latencies, lags };
}

/** Async driver loop, with `concurrency` queries in flight at once. */
async function runAsync(queryName, concurrency) {
  const q = QUERIES[queryName];
  const path = freshCopy("async");
  const { connect } = await import("@tursodatabase/database");
  const db = await connect(path);
  await db.exec("PRAGMA journal_mode = WAL");
  await db.exec("PRAGMA synchronous = NORMAL");
  const stmt = await db.prepare(q.sql);

  for (let i = 0; i < 50; i++) await stmt[q.method](...q.args());

  const watcher = watchEventLoop();
  const latencies = [];
  const deadline = Date.now() + durationMs;
  let ops = 0;

  const t0 = process.hrtime.bigint();
  while (Date.now() < deadline) {
    // `concurrency` queries issued without awaiting in between — if the engine
    // can overlap them, throughput rises with concurrency.
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        const s = process.hrtime.bigint();
        await stmt[q.method](...q.args());
        latencies.push(Number(process.hrtime.bigint() - s) / 1e6);
        ops++;
      }),
    );
  }
  const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
  const lags = watcher.stop();
  await db.close();
  cleanup(path);

  latencies.sort((a, b) => a - b);
  return { mode: `async (promise)`, concurrency, ops, elapsed, latencies, lags };
}

function summarize(r) {
  return {
    mode: r.mode,
    concurrency: r.concurrency,
    opsPerSec: (r.ops / r.elapsed) * 1000,
    p50: quantile(r.latencies, 0.5),
    p99: quantile(r.latencies, 0.99),
    loopP50: r.lags.length ? quantile(r.lags, 0.5) : 0,
    loopP99: r.lags.length ? quantile(r.lags, 0.99) : 0,
    loopMax: r.lags.length ? r.lags[r.lags.length - 1] : 0,
  };
}

function table(header, rows) {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cs) => cs.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log(`  ${line(header)}`);
  console.log(`  ${widths.map((w) => "-".repeat(w)).join("  ")}`);
  for (const r of rows) console.log(`  ${line(r)}`);
}

const mb = statSync(values.template).size / 1024 / 1024;
console.log(
  `\nasync vs sync API — turso only (no C SQLite binding offers an async API)` +
    `\ndataset=${mb.toFixed(0)} MB  duration=${values.duration}s per measurement`,
);

const out = [];
for (const queryName of ["light", "heavy"]) {
  console.log(
    `\n\x1b[1m${queryName} query\x1b[0m \x1b[2m— ${
      queryName === "light" ? "point lookup by primary key" : "grouped aggregate over a date range"
    }\x1b[0m`,
  );

  const rows = [];
  const syncResult = summarize(await runSync(queryName));
  out.push({ query: queryName, ...syncResult });
  rows.push([
    syncResult.mode, syncResult.concurrency, formatOps(syncResult.opsPerSec),
    formatDuration(syncResult.p50), formatDuration(syncResult.p99),
    formatDuration(syncResult.loopP50), formatDuration(syncResult.loopP99),
    formatDuration(syncResult.loopMax),
  ]);

  for (const c of concurrencies) {
    const r = summarize(await runAsync(queryName, c));
    out.push({ query: queryName, ...r });
    rows.push([
      r.mode, r.concurrency, formatOps(r.opsPerSec),
      formatDuration(r.p50), formatDuration(r.p99),
      formatDuration(r.loopP50), formatDuration(r.loopP99), formatDuration(r.loopMax),
    ]);
  }

  table(
    ["api", "in-flight", "ops/sec", "q p50", "q p99", "loop p50", "loop p99", "loop max"],
    rows,
  );
}

console.log(
  `\n\x1b[2m"loop" columns are event-loop delay: how late a 5 ms timer actually fired.` +
    `\nHigh values mean the process could not serve anything else during that time.\x1b[0m`,
);

if (values.json) {
  writeFileSync(values.json, JSON.stringify({ durationMs, results: out }, null, 2));
  console.log(`\nWrote ${values.json}`);
}
console.log();
