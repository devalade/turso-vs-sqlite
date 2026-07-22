/**
 * A production-shaped schema and dataset: a small SaaS billing app.
 *
 * Differences from the micro-benchmark schema that actually matter:
 *  - wide rows (a JSON metadata column), so pages hold fewer rows and the
 *    B-tree is deeper — closer to a real table than 5 skinny columns
 *  - a secondary UNIQUE index on email and two composite indexes, so writes
 *    pay realistic index-maintenance cost instead of only touching the PK
 *  - a dataset sized to exceed the page cache, so reads hit real I/O
 */

export const SCHEMA = `
CREATE TABLE users (
  id           INTEGER PRIMARY KEY,
  email        TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  plan         TEXT    NOT NULL,
  country      TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE UNIQUE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_plan_created ON users(plan, created_at);

CREATE TABLE orders (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  status       TEXT    NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency     TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  metadata     TEXT    NOT NULL
);
CREATE INDEX idx_orders_user_created ON orders(user_id, created_at);
CREATE INDEX idx_orders_status_created ON orders(status, created_at);
`;

export const PLANS = ["free", "starter", "pro", "enterprise"];
export const STATUSES = ["pending", "paid", "refunded", "failed", "disputed"];
export const COUNTRIES = ["US", "GB", "FR", "DE", "JP", "BR", "IN", "CA", "AU", "NG"];

const EPOCH = 1735689600; // 2025-01-01

/** Deterministic PRNG — the dataset must be identical run to run. */
export function makeRng(seed = 1337) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Realistic-width JSON blob, ~120-180 bytes. */
function metadataFor(rng, id) {
  return JSON.stringify({
    source: rng() < 0.5 ? "web" : "mobile",
    campaign: `cmp_${Math.floor(rng() * 400)}`,
    ip: `${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}.12.9`,
    ua: "Mozilla/5.0 (compatible; benchmark/1.0)",
    ref: `order-${id}`,
    retries: Math.floor(rng() * 3),
  });
}

/**
 * Seeds the dataset. Inserts in chunked transactions rather than one giant one
 * so the WAL doesn't grow without bound, and builds indexes AFTER the bulk load
 * — which is what you'd do in production, and avoids paying index maintenance
 * on every one of several million inserts.
 */
export function seed(db, { users, ordersPerUser, onProgress }) {
  const rng = makeRng();

  // Tables first, indexes later.
  const [tablesDDL, indexDDL] = splitDDL(SCHEMA);
  db.exec(tablesDDL);

  const insertUser = db.prepare(
    "INSERT INTO users (id, email, name, plan, country, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertOrder = db.prepare(
    "INSERT INTO orders (id, user_id, status, amount_cents, currency, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );

  const CHUNK = 25_000;
  let orderId = 0;

  for (let start = 1; start <= users; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, users);
    const chunk = db.transaction(() => {
      for (let id = start; id <= end; id++) {
        const created = EPOCH + Math.floor(rng() * 31_536_000);
        insertUser.run(
          id,
          `user${id}@example.com`,
          `User Number ${id}`,
          PLANS[Math.floor(rng() * PLANS.length)],
          COUNTRIES[Math.floor(rng() * COUNTRIES.length)],
          created,
          created + Math.floor(rng() * 2_592_000),
        );
        for (let k = 0; k < ordersPerUser; k++) {
          orderId++;
          insertOrder.run(
            orderId,
            id,
            STATUSES[Math.floor(rng() * STATUSES.length)],
            Math.floor(rng() * 500_00) + 100,
            "USD",
            created + Math.floor(rng() * 2_592_000),
            metadataFor(rng, orderId),
          );
        }
      }
    });
    chunk();
    onProgress?.(end, users);
  }

  db.exec(indexDDL);
  return { users, orders: orderId };
}

/** Splits the schema into table DDL and index DDL. */
function splitDDL(sql) {
  const statements = sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  const tables = statements.filter((s) => /^CREATE TABLE/i.test(s));
  const indexes = statements.filter((s) => /^CREATE (UNIQUE )?INDEX/i.test(s));
  return [tables.join(";\n") + ";", indexes.join(";\n") + ";"];
}
