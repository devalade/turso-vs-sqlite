/**
 * Confirms every engine is actually running the configuration the benchmark
 * claims. Setting a pragma is not the same as it taking effect — some engines
 * silently ignore what they don't implement, which would make a "fair"
 * comparison quietly unfair.
 *
 *   npm run verify
 */
import { existsSync } from "node:fs";
import { drivers, DATA_DIR } from "./drivers.js";

const EXPECTED = { journal_mode: "wal", synchronous: 1 };

function read(db, pragma) {
  try {
    const row = db.prepare(`PRAGMA ${pragma}`).get();
    return row ? Object.values(row)[0] : undefined;
  } catch (err) {
    return `ERROR: ${err.message}`;
  }
}

let anyMismatch = false;

console.log(`\n\x1b[1mon-disk databases\x1b[0m  (${DATA_DIR})`);
const rows = [];

for (const name of Object.keys(drivers)) {
  const db = await drivers[name]();
  const journal = read(db, "journal_mode");
  const sync = read(db, "synchronous");

  // Self-reported pragmas can lie; a real WAL database grows a -wal sidecar.
  db.exec("CREATE TABLE _probe(id INTEGER PRIMARY KEY)");
  db.prepare("INSERT INTO _probe VALUES (1)").run();
  const walFile = existsSync(`${db.path}-wal`) ? "yes" : "no";

  const ok =
    String(journal).toLowerCase() === EXPECTED.journal_mode &&
    sync === EXPECTED.synchronous &&
    walFile === "yes";
  if (!ok) anyMismatch = true;
  rows.push([name, String(journal), String(sync), walFile, ok ? "ok" : "MISMATCH"]);
  db.close();
}

const header = ["engine", "journal_mode", "synchronous", "-wal file", "vs expected"];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (cs) => cs.map((c, i) => c.padEnd(widths[i])).join("  ");
console.log(`  ${line(header)}`);
console.log(`  ${widths.map((w) => "-".repeat(w)).join("  ")}`);
for (const r of rows) console.log(`  ${line(r)}`);

const journals = new Set(rows.map((r) => r[1].toLowerCase()));
if (journals.size > 1) {
  console.log(
    `  \x1b[33m! engines disagree on journal_mode (${[...journals].join(" vs ")}) ` +
      `— results are not directly comparable\x1b[0m`,
  );
}

console.log(
  anyMismatch
    ? "\n\x1b[31mNOT configured as expected — benchmark results are not comparable.\x1b[0m\n"
    : "\n\x1b[32mVerified: real on-disk WAL + synchronous=NORMAL on every engine.\x1b[0m\n",
);
