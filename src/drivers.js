/**
 * Uniform adapter over the three engines. All of them expose a synchronous,
 * better-sqlite3-shaped API, so the benchmark body is literally the same code
 * for each — no per-engine special casing that could skew results.
 */
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const PRAGMAS = [
  ["journal_mode", "WAL"],
  ["synchronous", "NORMAL"],
];

/**
 * Every benchmark runs against a real on-disk SQLite database. `:memory:` is
 * deliberately not supported: C SQLite cannot use WAL for in-memory databases
 * and silently falls back to journal_mode=memory, while Turso reports wal — so
 * the engines would not be journaling alike and the comparison would be
 * meaningless. Run `npm run verify` to confirm the on-disk config.
 */
export const DATA_DIR = process.env.BENCH_DATA_DIR
  ? process.env.BENCH_DATA_DIR
  : join(process.cwd(), "data");

export function dbPath(tag) {
  mkdirSync(DATA_DIR, { recursive: true });
  return join(DATA_DIR, `bench-${tag}-${process.pid}-${Date.now()}.db`);
}

export function cleanup(path) {
  if (!path) return;
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(path + suffix, { force: true });
  }
}

/**
 * Normalizes the two call styles: no argument for the single-threaded suite
 * (which gets a fresh database), or an explicit `{ path }` for the concurrent
 * suite, where every worker must open the *same* file.
 */
function resolveOpts(opts, tag) {
  const resolved = { ...(opts ?? {}) };
  if (resolved.path === ":memory:") {
    throw new Error(
      "in-memory databases are not supported: C SQLite cannot use WAL for :memory:, " +
        "which would make the cross-engine comparison unfair. Use an on-disk database.",
    );
  }
  if (!resolved.path) {
    resolved.path = dbPath(tag);
    resolved.owned = true; // we created it, so we delete it on close
  }
  return resolved;
}

/** better-sqlite3: the C SQLite baseline. */
async function betterSqlite3(optsOrMode) {
  const { default: Database } = await import("better-sqlite3");
  const { path, timeout, owned } = resolveOpts(optsOrMode, "bsq");
  const db = new Database(path, timeout ? { timeout } : {});
  for (const [key, value] of PRAGMAS) db.pragma(`${key} = ${value}`);
  return {
    name: "better-sqlite3",
    path,
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    transaction: (fn) => db.transaction(fn),
    close: () => {
      db.close();
      if (owned) cleanup(path);
    },
  };
}

/** node:sqlite: the SQLite that ships inside Node 22.5+. */
async function nodeSqlite(optsOrMode) {
  const { DatabaseSync } = await import("node:sqlite");
  const { path, timeout, owned } = resolveOpts(optsOrMode, "node");
  const db = new DatabaseSync(path, timeout ? { timeout } : {});
  for (const [key, value] of PRAGMAS) db.exec(`PRAGMA ${key} = ${value}`);
  return {
    name: "node:sqlite",
    path,
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    // node:sqlite has no transaction() helper, so we hand-roll one.
    transaction: (fn) => (...args) => {
      db.exec("BEGIN");
      try {
        const result = fn(...args);
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    close: () => {
      db.close();
      if (owned) cleanup(path);
    },
  };
}

/**
 * Turso: SQLite rewritten in Rust, via its better-sqlite3 compat layer.
 *
 * `turso` is the current stable release; `turso-next` is the unreleased
 * prerelease line, installed under an npm alias and not on any dist-tag. Both
 * expose the same compat API, so one factory covers them.
 */
function makeTurso(name, specifier, tag) {
  return async function (optsOrMode) {
    const { Database } = await import(specifier);
    return openTurso(Database, optsOrMode, name, tag);
  };
}

async function openTurso(Database, optsOrMode, name, tag) {
  const { path, timeout, owned } = resolveOpts(optsOrMode, tag);
  const db = new Database(path, timeout ? { timeout } : {});
  for (const [key, value] of PRAGMAS) {
    try {
      db.pragma(`${key} = ${value}`);
    } catch {
      // Turso does not implement every pragma yet; defaults are fine.
    }
  }
  return {
    name,
    path,
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    transaction: (fn) => db.transaction(fn),
    close: () => {
      db.close();
      if (owned) cleanup(path);
    },
  };
}

export const drivers = {
  "better-sqlite3": betterSqlite3,
  "node:sqlite": nodeSqlite,
  turso: makeTurso("turso", "@tursodatabase/database/compat", "turso"),
  "turso-next": makeTurso("turso-next", "turso-next/compat", "tursonext"),
};
