import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { drivers } from "./drivers.js";
import { workloads } from "./workloads.js";
import { summarize, formatDuration, formatOps } from "./stats.js";

const { values } = parseArgs({
  options: {
    engines: { type: "string", default: "better-sqlite3,node:sqlite,turso" },
    workloads: { type: "string", default: workloads.map((w) => w.name).join(",") },
    rows: { type: "string", default: "10000" }, // seeded dataset size
    iterations: { type: "string", default: "0" }, // 0 = auto-size per workload
    warmup: { type: "string", default: "0" },
    json: { type: "string" },
  },
});

const rows = Number(values.rows);
const selectedEngines = values.engines.split(",").map((s) => s.trim()).filter(Boolean);
const selectedWorkloads = values.workloads.split(",").map((s) => s.trim()).filter(Boolean);

for (const engine of selectedEngines) {
  if (!drivers[engine]) {
    console.error(`Unknown engine "${engine}". Known: ${Object.keys(drivers).join(", ")}`);
    process.exit(1);
  }
}

/** Batch workloads do 1000x the work per iteration, so they need far fewer. */
function iterationsFor(workload) {
  if (Number(values.iterations) > 0) return Number(values.iterations);
  return workload.opsPerIteration > 1 ? 50 : 20000;
}

function warmupFor(iterations) {
  if (Number(values.warmup) > 0) return Number(values.warmup);
  return Math.max(5, Math.floor(iterations * 0.1));
}

async function runOne(engineName, workload) {
  const db = await drivers[engineName]();
  try {
    const iterations = iterationsFor(workload);
    const warmup = warmupFor(iterations);
    const step = workload.setup(db, { rows });

    for (let i = 0; i < warmup; i++) step();

    const samples = new Array(iterations);
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      const t0 = process.hrtime.bigint();
      step();
      samples[i] = Number(process.hrtime.bigint() - t0) / 1e6;
    }
    const totalMs = Number(process.hrtime.bigint() - start) / 1e6;

    const totalOps = iterations * workload.opsPerIteration;
    return {
      engine: engineName,
      workload: workload.name,
      iterations,
      totalOps,
      totalMs,
      opsPerSec: (totalOps / totalMs) * 1000,
      latency: summarize(samples),
    };
  } finally {
    db.close();
  }
}

function printTable(workload, results) {
  const ok = results.filter((r) => !r.error);
  const fastest = ok.length ? Math.max(...ok.map((r) => r.opsPerSec)) : 0;

  console.log(`\n\x1b[1m${workload.name}\x1b[0m — ${workload.description}`);
  const header = ["engine", "ops/sec", "median", "p95", "p99", "vs best"];
  const rowsOut = results.map((r) => {
    if (r.error) return [r.engine, "ERROR", r.error.slice(0, 40), "", "", ""];
    return [
      r.engine,
      formatOps(r.opsPerSec),
      formatDuration(r.latency.median),
      formatDuration(r.latency.p95),
      formatDuration(r.latency.p99),
      r.opsPerSec === fastest ? "fastest" : `${(fastest / r.opsPerSec).toFixed(2)}x slower`,
    ];
  });

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rowsOut.map((r) => String(r[i]).length)),
  );
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log(`  ${line(header)}`);
  console.log(`  ${widths.map((w) => "-".repeat(w)).join("  ")}`);
  for (const r of rowsOut) console.log(`  ${line(r)}`);
}

const all = [];
console.log(
  `\non-disk WAL  rows=${rows}  node=${process.version}  platform=${process.platform}/${process.arch}`,
);

for (const name of selectedWorkloads) {
  const workload = workloads.find((w) => w.name === name);
  if (!workload) {
    console.error(`Unknown workload "${name}"`);
    process.exit(1);
  }
  const results = [];
  for (const engine of selectedEngines) {
    try {
      results.push(await runOne(engine, workload));
    } catch (err) {
      results.push({ engine, workload: workload.name, error: err.message });
    }
  }
  printTable(workload, results);
  all.push(...results);
}

if (values.json) {
  writeFileSync(
    values.json,
    JSON.stringify(
      { rows, node: process.version, platform: `${process.platform}/${process.arch}`, results: all },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${values.json}`);
}
console.log();
