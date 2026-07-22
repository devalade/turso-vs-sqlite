/**
 * Runs both suites N times and prints one consolidated comparison.
 *
 * Each repetition is a fresh child process: JIT state, connection pools and
 * warmed page cache from one run must not leak into the next, or run 3 gets an
 * unearned advantage over run 1.
 *
 * Reported value is the MEDIAN across runs, with the spread ((max-min)/median)
 * next to it — on a noisy laptop the spread is what tells you whether a gap is
 * real or just weather.
 */
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { formatOps, formatDuration } from "./stats.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    engines: { type: "string", default: "better-sqlite3,node:sqlite,turso,turso-next" },
    threads: { type: "string", default: "1,4,8" },
    rows: { type: "string", default: "10000" },
    ops: { type: "string", default: "2000" },
    skipConcurrent: { type: "boolean", default: false },
    json: { type: "string", default: "results-compare.json" },
  },
});

const RUNS = Number(values.runs);
const ENGINES = values.engines.split(",").map((s) => s.trim()).filter(Boolean);

function run(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--no-warnings", join(HERE, script), ...args],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`)),
    );
  });
}

async function collect(script, args, tag, index) {
  const out = join(tmpdir(), `cmp-${tag}-${process.pid}-${index}.json`);
  await run(script, [...args, "--json", out]);
  const parsed = JSON.parse(readFileSync(out, "utf8"));
  rmSync(out, { force: true });
  return parsed;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Aggregates repeated samples into {median, spread%}. */
function agg(samples) {
  if (!samples.length) return null;
  const med = median(samples);
  const spread = med ? ((Math.max(...samples) - Math.min(...samples)) / med) * 100 : 0;
  return { median: med, spread, runs: samples.length };
}

function cell(a, format) {
  if (!a) return "—";
  return `${format(a.median)} ±${a.spread.toFixed(0)}%`;
}

/** Matrix table: one row per label, one column per engine, plus a winner column. */
function matrix(title, subtitle, rowLabels, data, { higherIsBetter = true, format = formatOps } = {}) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
  if (subtitle) console.log(`\x1b[2m${subtitle}\x1b[0m`);

  const header = ["", ...ENGINES, "best"];
  const rowsOut = rowLabels.map((label) => {
    const cells = ENGINES.map((e) => data[label]?.[e]);
    const valid = cells.map((c, i) => ({ c, e: ENGINES[i] })).filter((x) => x.c);
    let best = "—";
    if (valid.length) {
      const pick = valid.reduce((a, b) =>
        (higherIsBetter ? b.c.median > a.c.median : b.c.median < a.c.median) ? b : a,
      );
      const others = valid.filter((x) => x.e !== pick.e);
      const runnerUp = others.length
        ? others.reduce((a, b) =>
            (higherIsBetter ? b.c.median > a.c.median : b.c.median < a.c.median) ? b : a,
          )
        : null;
      const lead = runnerUp
        ? higherIsBetter
          ? pick.c.median / runnerUp.c.median
          : runnerUp.c.median / pick.c.median
        : 1;
      best = runnerUp ? `${pick.e} (${lead.toFixed(2)}x)` : pick.e;
    }
    return [label, ...cells.map((c) => cell(c, format)), best];
  });

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rowsOut.map((r) => String(r[i]).length)),
  );
  const line = (cs) => cs.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log(`  ${line(header)}`);
  console.log(`  ${widths.map((w) => "-".repeat(w)).join("  ")}`);
  for (const r of rowsOut) console.log(`  ${line(r)}`);
}

// ---------------------------------------------------------------- run suites

console.log(
  `\n\x1b[1mComparison: ${RUNS} runs x ${ENGINES.length} engines\x1b[0m` +
    `\nnode=${process.version}  platform=${process.platform}/${process.arch}` +
    `\neach run is a fresh process; reported value is the median, ± is (max-min)/median`,
);

const singleRuns = [];
const concurrentRuns = [];

for (let i = 0; i < RUNS; i++) {
  process.stderr.write(`\n\x1b[2m— run ${i + 1}/${RUNS} —\x1b[0m\n`);

  process.stderr.write("  single-threaded suite...\n");
  singleRuns.push(
    await collect("bench.js", ["--engines", ENGINES.join(","), "--rows", values.rows], "single", i),
  );

  if (!values.skipConcurrent) {
    process.stderr.write("  concurrent suite...\n");
    concurrentRuns.push(
      await collect(
        "concurrent.js",
        ["--engines", ENGINES.join(","), "--threads", values.threads, "--ops", values.ops, "--rows", values.rows],
        "conc",
        i,
      ),
    );
  }
}

// ------------------------------------------------------- single-threaded table

const singleData = {};
const singleLatency = {};
const workloadNames = [];
for (const runResult of singleRuns) {
  for (const r of runResult.results) {
    if (r.error) continue;
    if (!workloadNames.includes(r.workload)) workloadNames.push(r.workload);
    ((singleData[r.workload] ??= {})[r.engine] ??= []).push(r.opsPerSec);
    ((singleLatency[r.workload] ??= {})[r.engine] ??= []).push(r.latency.p99);
  }
}
for (const w of Object.keys(singleData)) {
  for (const e of Object.keys(singleData[w])) singleData[w][e] = agg(singleData[w][e]);
  for (const e of Object.keys(singleLatency[w])) singleLatency[w][e] = agg(singleLatency[w][e]);
}

matrix(
  "Single-threaded throughput (ops/sec, higher is better)",
  `median of ${RUNS} runs, ${values.rows} seeded rows, on-disk WAL`,
  workloadNames,
  singleData,
);

matrix(
  "Single-threaded p99 latency (lower is better)",
  "same runs, 99th-percentile per-operation latency in ms",
  workloadNames,
  singleLatency,
  { higherIsBetter: false, format: formatDuration },
);

// ------------------------------------------------------------ concurrent tables

if (concurrentRuns.length) {
  const scenarios = [...new Set(concurrentRuns[0].results.map((r) => r.scenario))];
  for (const scenario of scenarios) {
    for (const role of ["writers", "readers"]) {
      const data = {};
      const labels = [];
      for (const runResult of concurrentRuns) {
        for (const r of runResult.results) {
          if (r.error || r.scenario !== scenario || !r[role]) continue;
          const label = `${r.threads} thread${r.threads > 1 ? "s" : ""}`;
          if (!labels.includes(label)) labels.push(label);
          ((data[label] ??= {})[r.engine] ??= []).push(r[role].opsPerSec);
        }
      }
      if (!labels.length) continue;
      labels.sort((a, b) => parseInt(a) - parseInt(b));
      for (const l of Object.keys(data)) {
        for (const e of Object.keys(data[l])) data[l][e] = agg(data[l][e]);
      }
      matrix(
        `Concurrent — ${scenario} — ${role} (ops/sec, higher is better)`,
        `median of ${RUNS} runs, ${values.ops} ops/worker`,
        labels,
        data,
      );
    }
  }
}

if (values.json) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    values.json,
    JSON.stringify(
      { runs: RUNS, engines: ENGINES, node: process.version, single: singleRuns, concurrent: concurrentRuns },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${values.json}`);
}
console.log();
