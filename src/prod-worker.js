import { workerData, parentPort } from "node:worker_threads";
import { drivers } from "./drivers.js";
import { buildWorkload, MIX } from "./prod-workload.js";

const { engine, path, timeout, workerId, durationMs, users, orders, barrier } = workerData;
const gate = new Int32Array(barrier);

const db = await drivers[engine]({ path, timeout });
const workload = buildWorkload(db, { users, orders, workerId });

function isBusy(err) {
  const msg = String(err && err.message).toUpperCase();
  return msg.includes("BUSY") || msg.includes("LOCKED");
}

// Warm up: touch each op type so nothing is paying first-call cost mid-measurement.
for (let i = 0; i < 200; i++) {
  try {
    workload.pick().run();
  } catch (err) {
    if (!isBusy(err)) throw err;
  }
}

Atomics.add(gate, 0, 1);
Atomics.notify(gate, 0);
while (Atomics.load(gate, 1) === 0) Atomics.wait(gate, 1, 0, 50);

// Per-op-type latency samples. Production cares about the tail per endpoint,
// not one blended average, so they are kept separate.
const samples = Object.fromEntries(MIX.map((o) => [o.name, []]));
let busyRetries = 0;
let failures = 0;
let total = 0;

const started = process.hrtime.bigint();
const deadline = started + BigInt(durationMs) * 1_000_000n;

while (process.hrtime.bigint() < deadline) {
  // Check the clock every 200 ops rather than every op — hrtime is not free.
  for (let i = 0; i < 200; i++) {
    const op = workload.pick();
    const t0 = process.hrtime.bigint();
    for (let attempt = 0; ; attempt++) {
      try {
        op.run();
        break;
      } catch (err) {
        if (!isBusy(err) || attempt >= 200) {
          failures++;
          break;
        }
        busyRetries++;
      }
    }
    samples[op.name].push(Number(process.hrtime.bigint() - t0) / 1e6);
    total++;
  }
}
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

db.close();

parentPort.postMessage({ workerId, elapsedMs, total, busyRetries, failures, samples });
