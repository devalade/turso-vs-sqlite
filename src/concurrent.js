/**
 * Concurrent-access benchmark: N writer threads and M reader threads, each with
 * its own connection to the SAME database file, released from a shared barrier
 * so they genuinely contend.
 *
 * This is the part the single-threaded suite cannot measure: SQLite in WAL mode
 * serializes writers but lets readers run alongside the writer, and how well an
 * engine handles that is a real differentiator.
 */
import { Worker } from "node:worker_threads";
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drivers, dbPath, cleanup } from "./drivers.js";
import { summarize, formatDuration, formatOps } from "./stats.js";

const WORKER_PATH = fileURLToPath(new URL("./concurrent-worker.js", import.meta.url));

const { values } = parseArgs({
  options: {
    engines: { type: "string", default: "better-sqlite3,node:sqlite,turso" },
    scenario: { type: "string", default: "write-contention,read-write-mix" },
    threads: { type: "string", default: "1,2,4,8" },
    ops: { type: "string", default: "2000" }, // per worker
    batchSize: { type: "string", default: "1" }, // writes per transaction
    rows: { type: "string", default: "10000" }, // seeded reader dataset
    timeout: { type: "string", default: "10000" }, // busy timeout, ms
    json: { type: "string" },
  },
});

const selectedEngines = values.engines.split(",").map((s) => s.trim()).filter(Boolean);
const scenarios = values.scenario.split(",").map((s) => s.trim()).filter(Boolean);
const threadCounts = values.threads.split(",").map((s) => Number(s.trim())).filter(Boolean);
const opsPerWorker = Number(values.ops);
const batchSize = Number(values.batchSize);
const rows = Number(values.rows);
const timeout = Number(values.timeout);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
  age INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, worker_id INTEGER NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL
);
`;

/**
 * Scenarios describe how a thread budget is split between writers and readers.
 * `write-contention` puts every thread on the write lock; `read-write-mix` keeps
 * one writer and adds readers, which is the WAL case that should scale.
 */
const SCENARIOS = {
  "write-contention": {
    description: "All threads writing — pure write-lock contention",
    split: (n) => ({ writers: n, readers: 0 }),
  },
  "read-write-mix": {
    description: "1 writer + N readers — WAL readers should not block on the writer",
    split: (n) => ({ writers: 1, readers: n }),
  },
};

async function prepareDatabase(engine, path) {
  const db = await drivers[engine]({ path, timeout });
  try {
    db.exec(SCHEMA);
    const insert = db.prepare(
      "INSERT INTO users (id, name, email, age, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    const fill = db.transaction(() => {
      for (let i = 1; i <= rows; i++) {
        insert.run(i, `user_${i}`, `user_${i}@example.com`, 18 + (i % 60), 1700000000 + i);
      }
    });
    fill();
  } finally {
    db.close();
  }
}

function spawn(spec, barrier) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, { workerData: { ...spec, barrier } });
    let result;
    worker.on("message", (msg) => {
      result = msg;
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) reject(new Error(`worker exited with code ${code}`));
      else if (!result) reject(new Error("worker exited without reporting"));
      else resolve(result);
    });
  });
}

async function runScenario(engine, scenarioName, threadCount) {
  const { writers, readers } = SCENARIOS[scenarioName].split(threadCount);
  const total = writers + readers;
  const path = dbPath(`conc-${engine.replace(/\W/g, "")}`);

  await prepareDatabase(engine, path);

  const barrier = new SharedArrayBuffer(8);
  const gate = new Int32Array(barrier);

  const specs = [];
  for (let i = 0; i < writers; i++) {
    specs.push({ engine, path, timeout, role: "writer", workerId: i, ops: opsPerWorker, batchSize, rows });
  }
  for (let i = 0; i < readers; i++) {
    specs.push({
      engine, path, timeout, role: "reader",
      workerId: writers + i, ops: opsPerWorker, batchSize: 1, rows,
    });
  }

  try {
    const pending = specs.map((spec) => spawn(spec, barrier));

    // Wait for every worker to finish opening + warming up before starting the clock.
    while (Atomics.load(gate, 0) < total) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const started = process.hrtime.bigint();
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1);

    const results = await Promise.all(pending);
    const wallMs = Number(process.hrtime.bigint() - started) / 1e6;

    const group = (role) => {
      const rs = results.filter((r) => r.role === role);
      if (!rs.length) return null;
      const opsDone = rs.reduce((a, r) => a + r.opsCompleted, 0);
      const latencies = rs.flatMap((r) => r.latencies);
      // Throughput is measured over this role's own window (all its threads
      // start together at the barrier, so the slowest one bounds the group).
      // Dividing by the global wall clock instead would understate whichever
      // role finishes first.
      const roleMs = Math.max(...rs.map((r) => r.elapsedMs));
      return {
        threads: rs.length,
        ops: opsDone,
        elapsedMs: roleMs,
        opsPerSec: (opsDone / roleMs) * 1000,
        busyRetries: rs.reduce((a, r) => a + r.busyRetries, 0),
        failures: rs.reduce((a, r) => a + r.failures, 0),
        latency: summarize(latencies),
      };
    };

    return {
      engine, scenario: scenarioName, threads: threadCount, wallMs,
      writers: group("writer"), readers: group("reader"),
    };
  } finally {
    cleanup(path);
  }
}

function printScenario(scenarioName, results) {
  console.log(`\n\x1b[1m${scenarioName}\x1b[0m — ${SCENARIOS[scenarioName].description}`);

  const roles = results.some((r) => r.readers) ? ["writers", "readers"] : ["writers"];
  for (const role of roles) {
    if (roles.length > 1) console.log(`\n  \x1b[2m${role}\x1b[0m`);
    const header = ["engine", "threads", "ops/sec", "median", "p99", "busy-retries", "scaling"];
    const rowsOut = [];

    for (const engine of [...new Set(results.map((r) => r.engine))]) {
      const forEngine = results.filter((r) => r.engine === engine).sort((a, b) => a.threads - b.threads);
      const baseline = forEngine[0]?.[role]?.opsPerSec;
      for (const r of forEngine) {
        if (r.error) {
          rowsOut.push([engine, r.threads, "ERROR", r.error.slice(0, 30), "", "", ""]);
          continue;
        }
        const g = r[role];
        if (!g) continue;
        rowsOut.push([
          engine, r.threads, formatOps(g.opsPerSec),
          formatDuration(g.latency.median), formatDuration(g.latency.p99),
          g.busyRetries + (g.failures ? ` (+${g.failures} failed)` : ""),
          baseline ? `${(g.opsPerSec / baseline).toFixed(2)}x` : "-",
        ]);
      }
    }

    const widths = header.map((h, i) =>
      Math.max(h.length, ...rowsOut.map((r) => String(r[i]).length)),
    );
    const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
    console.log(`  ${line(header)}`);
    console.log(`  ${widths.map((w) => "-".repeat(w)).join("  ")}`);
    for (const r of rowsOut) console.log(`  ${line(r)}`);
  }
}

console.log(
  `\nconcurrent  ops/worker=${opsPerWorker}  batchSize=${batchSize}  rows=${rows}  ` +
    `busyTimeout=${timeout}ms  node=${process.version}  platform=${process.platform}/${process.arch}`,
);
console.log(`\x1b[2mscaling is relative to each engine's own ${threadCounts[0]}-thread result\x1b[0m`);

const all = [];
for (const scenarioName of scenarios) {
  if (!SCENARIOS[scenarioName]) {
    console.error(`Unknown scenario "${scenarioName}". Known: ${Object.keys(SCENARIOS).join(", ")}`);
    process.exit(1);
  }
  const results = [];
  for (const engine of selectedEngines) {
    for (const threadCount of threadCounts) {
      try {
        results.push(await runScenario(engine, scenarioName, threadCount));
      } catch (err) {
        results.push({ engine, scenario: scenarioName, threads: threadCount, error: err.message });
      }
    }
  }
  printScenario(scenarioName, results);
  all.push(...results);
}

if (values.json) {
  // Latency arrays are huge; the summaries are already computed.
  writeFileSync(values.json, JSON.stringify({ opsPerWorker, batchSize, rows, timeout, results: all }, null, 2));
  console.log(`\nWrote ${values.json}`);
}
console.log();
