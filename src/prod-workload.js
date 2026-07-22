/**
 * The production workload mix. Unlike the micro-benchmarks, a single connection
 * issues a weighted blend of reads and writes — which is what an app server
 * actually does, and what makes the write lock and the page cache interact.
 *
 * Weights are roughly a read-heavy OLTP service: ~85% reads, ~15% writes.
 */
import { makeRng, PLANS, STATUSES } from "./prod-schema.js";

export const MIX = [
  { name: "user_by_id", weight: 25, kind: "read" },
  { name: "user_by_email", weight: 15, kind: "read" },
  { name: "orders_by_user", weight: 20, kind: "read" },
  { name: "users_by_plan_page", weight: 15, kind: "read" },
  { name: "revenue_dashboard", weight: 10, kind: "read" },
  { name: "insert_order", weight: 10, kind: "write" },
  { name: "update_order_status", weight: 5, kind: "write" },
];

const TOTAL_WEIGHT = MIX.reduce((a, o) => a + o.weight, 0);

/** Builds the weighted op picker plus one prepared statement per op. */
export function buildWorkload(db, { users, orders, workerId }) {
  const rng = makeRng(9001 + workerId * 7919);

  const stmts = {
    user_by_id: db.prepare(
      "SELECT id, email, name, plan, country, created_at FROM users WHERE id = ?",
    ),
    user_by_email: db.prepare(
      "SELECT id, email, name, plan FROM users WHERE email = ?",
    ),
    // The bread-and-butter "show me this customer's recent orders" query.
    orders_by_user: db.prepare(
      `SELECT id, status, amount_cents, created_at
       FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
    ),
    // Keyset-style pagination over a composite index.
    users_by_plan_page: db.prepare(
      `SELECT id, email, created_at FROM users
       WHERE plan = ? AND created_at > ? ORDER BY created_at LIMIT 25`,
    ),
    // Analytics query an admin dashboard would run — aggregates over a range.
    revenue_dashboard: db.prepare(
      `SELECT status, COUNT(*) AS n, SUM(amount_cents) AS total
       FROM orders WHERE status = ? AND created_at BETWEEN ? AND ?
       GROUP BY status`,
    ),
    insert_order: db.prepare(
      `INSERT INTO orders (user_id, status, amount_cents, currency, created_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    update_order_status: db.prepare("UPDATE orders SET status = ? WHERE id = ?"),
  };

  const EPOCH = 1735689600;
  const meta = JSON.stringify({
    source: "web", campaign: "cmp_live", ip: "10.0.0.1",
    ua: "Mozilla/5.0 (compatible; benchmark/1.0)", ref: "live", retries: 0,
  });

  const ops = {
    user_by_id: () => stmts.user_by_id.get(1 + Math.floor(rng() * users)),
    user_by_email: () => stmts.user_by_email.get(`user${1 + Math.floor(rng() * users)}@example.com`),
    orders_by_user: () => stmts.orders_by_user.all(1 + Math.floor(rng() * users)),
    users_by_plan_page: () =>
      stmts.users_by_plan_page.all(
        PLANS[Math.floor(rng() * PLANS.length)],
        EPOCH + Math.floor(rng() * 31_536_000),
      ),
    revenue_dashboard: () => {
      const from = EPOCH + Math.floor(rng() * 28_000_000);
      return stmts.revenue_dashboard.all(
        STATUSES[Math.floor(rng() * STATUSES.length)], from, from + 604_800, // one week
      );
    },
    insert_order: () =>
      stmts.insert_order.run(
        1 + Math.floor(rng() * users),
        STATUSES[Math.floor(rng() * STATUSES.length)],
        Math.floor(rng() * 50_000) + 100,
        "USD",
        EPOCH + Math.floor(rng() * 31_536_000),
        meta,
      ),
    update_order_status: () =>
      stmts.update_order_status.run(
        STATUSES[Math.floor(rng() * STATUSES.length)],
        1 + Math.floor(rng() * orders),
      ),
  };

  // Precomputed cumulative weights for O(1)-ish selection.
  const cumulative = [];
  let acc = 0;
  for (const op of MIX) {
    acc += op.weight;
    cumulative.push({ name: op.name, upTo: acc / TOTAL_WEIGHT, run: ops[op.name] });
  }

  return {
    pick() {
      const r = rng();
      for (const c of cumulative) if (r <= c.upTo) return c;
      return cumulative[cumulative.length - 1];
    },
  };
}
