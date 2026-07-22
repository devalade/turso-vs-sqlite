import { workerData, parentPort } from "node:worker_threads";
import { drivers } from "./drivers.js";

const { engine, path, timeout, role, workerId, ops, batchSize, rows, barrier } = workerData;

// barrier[0] = number of workers that have finished setup, barrier[1] = go flag.
const gate = new Int32Array(barrier);

const db = await drivers[engine]({ path, timeout });

let step;
if (role === "writer") {
  const stmt = db.prepare("INSERT INTO events (worker_id, seq, payload) VALUES (?, ?, ?)");
  let seq = 0;
  if (batchSize > 1) {
    const batch = db.transaction(() => {
      for (let i = 0; i < batchSize; i++) stmt.run(workerId, seq++, `payload-${workerId}-${seq}`);
    });
    step = batch;
  } else {
    step = () => stmt.run(workerId, seq++, `payload-${workerId}-${seq}`);
  }
} else {
  const stmt = db.prepare("SELECT id, name, email, age FROM users WHERE id = ?");
  let i = workerId * 7919; // co-prime-ish offset so readers don't march in lockstep
  step = () => stmt.get((i++ % rows) + 1);
}

/** Contention shows up as SQLITE_BUSY / locked; retry, but count it. */
function isBusy(err) {
  const msg = String(err && err.message).toUpperCase();
  return msg.includes("BUSY") || msg.includes("LOCKED");
}

// Warm the code paths, then join the barrier.
for (let i = 0; i < 5; i++) {
  try {
    step();
  } catch (err) {
    if (!isBusy(err)) throw err;
  }
}

Atomics.add(gate, 0, 1);
Atomics.notify(gate, 0);
while (Atomics.load(gate, 1) === 0) Atomics.wait(gate, 1, 0, 50);

const latencies = new Array(ops);
let busyRetries = 0;
let failures = 0;

const started = process.hrtime.bigint();
for (let i = 0; i < ops; i++) {
  const t0 = process.hrtime.bigint();
  for (let attempt = 0; ; attempt++) {
    try {
      step();
      break;
    } catch (err) {
      if (!isBusy(err) || attempt >= 100) {
        failures++;
        break;
      }
      busyRetries++;
    }
  }
  latencies[i] = Number(process.hrtime.bigint() - t0) / 1e6;
}
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

db.close();

parentPort.postMessage({
  workerId,
  role,
  elapsedMs,
  latencies,
  busyRetries,
  failures,
  opsCompleted: ops * (role === "writer" ? batchSize : 1),
});
