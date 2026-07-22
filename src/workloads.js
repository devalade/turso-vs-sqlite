/**
 * Each workload declares how to build its schema, how many logical DB ops one
 * iteration performs (so throughput stays comparable across workloads), and the
 * work itself. `setup` returns the per-iteration function.
 */

const SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  age INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_users_age ON users(age);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL
);
CREATE INDEX idx_orders_user ON orders(user_id);
`;

/** Deterministic PRNG so every engine sees byte-identical data. */
function makeRng(seed = 42) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function seedData(db, rows) {
  const rng = makeRng();
  const insertUser = db.prepare(
    "INSERT INTO users (id, name, email, age, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const insertOrder = db.prepare(
    "INSERT INTO orders (id, user_id, amount, status) VALUES (?, ?, ?, ?)",
  );
  const statuses = ["pending", "shipped", "delivered", "cancelled"];
  const fill = db.transaction(() => {
    for (let i = 1; i <= rows; i++) {
      insertUser.run(i, `user_${i}`, `user_${i}@example.com`, 18 + Math.floor(rng() * 60), 1700000000 + i);
      // ~2 orders per user, so joins have something to chew on.
      for (let k = 0; k < 2; k++) {
        const id = (i - 1) * 2 + k + 1;
        insertOrder.run(id, i, Math.round(rng() * 100000) / 100, statuses[Math.floor(rng() * 4)]);
      }
    }
  });
  fill();
}

export const workloads = [
  {
    name: "insert-single",
    description: "One INSERT per iteration, autocommit (worst-case write path)",
    opsPerIteration: 1,
    setup(db, { rows }) {
      db.exec(SCHEMA);
      const stmt = db.prepare(
        "INSERT INTO users (id, name, email, age, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      let id = 0;
      return () => {
        id++;
        stmt.run(id, `user_${id}`, `user_${id}@example.com`, 30, 1700000000);
      };
    },
  },
  {
    name: "insert-tx-batch",
    description: "1000 INSERTs inside a single transaction",
    opsPerIteration: 1000,
    setup(db) {
      db.exec(SCHEMA);
      const stmt = db.prepare(
        "INSERT INTO users (id, name, email, age, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      let id = 0;
      const batch = db.transaction(() => {
        for (let i = 0; i < 1000; i++) {
          id++;
          stmt.run(id, `user_${id}`, `user_${id}@example.com`, 30, 1700000000);
        }
      });
      return batch;
    },
  },
  {
    name: "select-point",
    description: "SELECT one row by primary key",
    opsPerIteration: 1,
    setup(db, { rows }) {
      db.exec(SCHEMA);
      seedData(db, rows);
      const stmt = db.prepare("SELECT id, name, email, age FROM users WHERE id = ?");
      let i = 0;
      return () => stmt.get((i++ % rows) + 1);
    },
  },
  {
    name: "select-range-indexed",
    description: "Indexed range scan returning ~50 rows",
    opsPerIteration: 1,
    setup(db, { rows }) {
      db.exec(SCHEMA);
      seedData(db, rows);
      const stmt = db.prepare("SELECT id, name, age FROM users WHERE age BETWEEN ? AND ? LIMIT 50");
      let i = 0;
      return () => {
        const lo = 18 + (i++ % 50);
        return stmt.all(lo, lo + 2);
      };
    },
  },
  {
    name: "select-fullscan-agg",
    description: "COUNT + AVG over the whole users table",
    opsPerIteration: 1,
    setup(db, { rows }) {
      db.exec(SCHEMA);
      seedData(db, rows);
      const stmt = db.prepare("SELECT COUNT(*) AS n, AVG(age) AS avg_age FROM users");
      return () => stmt.get();
    },
  },
  {
    name: "select-join",
    description: "Join users to their orders for one user",
    opsPerIteration: 1,
    setup(db, { rows }) {
      db.exec(SCHEMA);
      seedData(db, rows);
      const stmt = db.prepare(
        `SELECT u.name, o.amount, o.status
         FROM users u JOIN orders o ON o.user_id = u.id
         WHERE u.id = ?`,
      );
      let i = 0;
      return () => stmt.all((i++ % rows) + 1);
    },
  },
  {
    name: "update-point",
    description: "UPDATE one row by primary key, autocommit",
    opsPerIteration: 1,
    setup(db, { rows }) {
      db.exec(SCHEMA);
      seedData(db, rows);
      const stmt = db.prepare("UPDATE users SET age = ? WHERE id = ?");
      let i = 0;
      return () => {
        i++;
        stmt.run(20 + (i % 60), (i % rows) + 1);
      };
    },
  },
];
