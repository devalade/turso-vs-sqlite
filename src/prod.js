/**
 * Production-profile benchmark.
 *
 * Differences from the micro-benchmarks that make this closer to real service
 * behaviour:
 *
 *  1. Working set is sized to exceed the page cache, so reads do real I/O
 *     instead of measuring RAM.
 *  2. Every connection runs a weighted READ+WRITE mix, so the write lock and
 *     the cache interact the way they do behind an app server.
 *  3. Load is sustained for a fixed duration under N concurrent threads.
 *  4. Reported metric is TAIL LATENCY per query type — p99 is what pages you at
 *     3am, not mean throughput.
 *  5. The dataset is seeded ONCE into a template and byte-copied per engine, so
 *     every engine reads an identical physical page layout.
 */
import { Worker } from "node:worker_threads";
import { parseArgs } from "node:util";
import { copyFileSync, existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drivers, DATA_DIR, cleanup } from "./drivers.js";
import { seed } from "./prod-schema.js";
import { MIX } from "./prod-workload.js";
import { quantile, formatDuration, formatOps } from "./stats.js";

const WORKER_PATH = fileURLToPath(new URL("./prod-worker.js", import.meta.url));

const SCALES = {
  small: { users: 100_000, ordersPerUser: 4 },   // ~120 MB
  medium: { users: 400_000, ordersPerUser: 5 },  // ~600 MB
  large: { users: 1_000_000, ordersPerUser: 6 }, // ~1.8 GB
};

const { values } = parseArgs({
  options: {
    engines: { type: "string", default: "better-sqlite3,node:sqlite,turso" },
    scale: { type: "string", default: "small" },
    threads: { type: "string", default: "4" },
    duration: { type: "string", default: "15" }, // seconds of sustained load
    cache: { type: "string", default: "-65536" }, // page cache: 64 MB, as a prod app would set
    timeout: { type: "string", default: "15000" },
    fresh: { type: "boolean", default: false }, // rebuild the template dataset
    json: { type: "string" },
  },
});

const scale = SCALES[values.scale];
if (!scale) {
  console.error(`Unknown scale "${values.scale}". Known: ${Object.keys(SCALES).join(", ")}`);
  process.exit(1);
}
const engines = values.engines.split(",").map((s) => s.trim()).filter(Boolean);
const threads = Number(values.threads);
const durationMs = Number(values.duration) * 1000;
const timeout = Number(values.timeout);

const templatePath = join(DATA_DIR, `prod-template-${values.scale}.db`);

/** Builds the shared dataset once; every engine gets a byte-identical copy. */
async function buildTemplate() {
  if (existsSync(templatePath) && !values.fresh) {
    const mb = statSync(templatePath).size / 1024 / 1024;
    console.log(`reusing template ${templatePath} (${mb.toFixed(0)} MB) — pass --fresh to rebuild`);
    return;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  cleanup(templatePath);

  console.log(
    `seeding template: ${scale.users.toLocaleString()} users x ${scale.ordersPerUser} orders ` +
      `= ${(scale.users * scale.ordersPerUser).toLocaleString()} orders...`,
  );
  const t0 = Date.now();
  // Seeded with better-sqlite3; the file format is shared, so which engine
  // writes it is irrelevant — and this way the layout is identical for all.
  const db = await drivers["better-sqlite3"]({ path: templatePath, timeout });
  try {
    const counts = seed(db, {
      users: scale.users,
      ordersPerUser: scale.ordersPerUser,
      onProgress: (done, totalUsers) => {
        if (done % 100_000 === 0 || done === totalUsers) {
          process.stderr.write(`  ${done.toLocaleString()}/${totalUsers.toLocaleString()} users\r`);
        }
      },
    });
    // Fold the WAL back into the main file so the copy is self-contained.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const mb = statSync(templatePath).size / 1024 / 1024;
    console.log(
      `\nseeded ${counts.orders.toLocaleString()} orders in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
        `-> ${mb.toFixed(0)} MB`,
    );
  } finally {
    db.close();
  }
}

function spawn(spec, barrier) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, { workerData: { ...spec, barrier } });
    let result;
    worker.on("message", (m) => (result = m));
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) reject(new Error(`worker exited ${code}`));
      else if (!result) reject(new Error("worker exited without reporting"));
      else resolve(result);
    });
  });
}

async function runEngine(engine) {
  const path = join(DATA_DIR, `prod-run-${engine.replace(/\W/g, "")}.db`);
  cleanup(path);
  copyFileSync(templatePath, path);

  // Apply the production cache size to the copy before the workers open it.
  const setup = await drivers[engine]({ path, timeout });
  try {
    setup.exec(`PRAGMA cache_size = ${values.cache}`);
  } catch {
    /* engine may not support it; reported by verify */
  }
  const orders = setup.prepare("SELECT COUNT(*) AS n FROM orders").get().n;
  setup.close();

  const barrier = new SharedArrayBuffer(8);
  const gate = new Int32Array(barrier);

  const specs = Array.from({ length: threads }, (_, i) => ({
    engine, path, timeout, workerId: i, durationMs, users: scale.users, orders,
  }));

  try {
    const pending = specs.map((s) => spawn(s, barrier));
    while (Atomics.load(gate, 0) < threads) await new Promise((r) => setTimeout(r, 10));

    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1);

    const results = await Promise.all(pending);
    const wallMs = Math.max(...results.map((r) => r.elapsedMs));
    const total = results.reduce((a, r) => a + r.total, 0);

    const perOp = {};
    for (const op of MIX) {
      const merged = results.flatMap((r) => r.samples[op.name]);
      if (!merged.length) continue;
      merged.sort((a, b) => a - b);
      perOp[op.name] = {
        kind: op.kind,
        count: merged.length,
        p50: quantile(merged, 0.5),
        p95: quantile(merged, 0.95),
        p99: quantile(merged, 0.99),
        p999: quantile(merged, 0.999),
        max: merged[merged.length - 1],
      };
    }

    const sizeMb = statSync(path).size / 1024 / 1024;
    return {
      engine, threads, wallMs, total,
      opsPerSec: (total / wallMs) * 1000,
      busyRetries: results.reduce((a, r) => a + r.busyRetries, 0),
      failures: results.reduce((a, r) => a + r.failures, 0),
      dbSizeMb: sizeMb,
      perOp,
    };
  } finally {
    cleanup(path);
  }
}

// ------------------------------------------------------------------- report

function table(header, rows) {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cs) => cs.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log(`  ${line(header)}`);
  console.log(`  ${widths.map((w) => "-".repeat(w)).join("  ")}`);
  for (const r of rows) console.log(`  ${line(r)}`);
}

await buildTemplate();

console.log(
  `\nproduction profile: scale=${values.scale}  threads=${threads}  ` +
    `duration=${values.duration}s  cache_size=${values.cache} pages  mix=85% read / 15% write`,
);

const all = [];
for (const engine of engines) {
  process.stderr.write(`\nrunning ${engine}...\n`);
  try {
    all.push(await runEngine(engine));
  } catch (err) {
    all.push({ engine, error: err.message });
    console.error(`  ${engine} failed: ${err.message}`);
  }
}

const ok = all.filter((r) => !r.error);

console.log(`\n\x1b[1mSustained throughput\x1b[0m`);
table(
  ["engine", "ops/sec", "total ops", "db size", "busy retries", "failures"],
  ok.map((r) => [
    r.engine, formatOps(r.opsPerSec), r.total.toLocaleString(),
    `${r.dbSizeMb.toFixed(0)} MB`, r.busyRetries.toLocaleString(), r.failures.toLocaleString(),
  ]),
);

for (const metric of ["p50", "p99", "p999"]) {
  console.log(
    `\n\x1b[1m${metric === "p999" ? "p99.9" : metric} latency by query\x1b[0m` +
      `\x1b[2m  (lower is better)\x1b[0m`,
  );
  table(
    ["query", "kind", ...ok.map((r) => r.engine)],
    MIX.filter((op) => ok.some((r) => r.perOp[op.name])).map((op) => [
      op.name,
      op.kind,
      ...ok.map((r) => (r.perOp[op.name] ? formatDuration(r.perOp[op.name][metric]) : "—")),
    ]),
  );
}

if (values.json) {
  writeFileSync(
    values.json,
    JSON.stringify({ scale: values.scale, ...scale, threads, durationMs, results: all }, null, 2),
  );
  console.log(`\nWrote ${values.json}`);
}
console.log();
