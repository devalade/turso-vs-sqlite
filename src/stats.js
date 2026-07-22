export function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    mean,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

export function formatDuration(ms) {
  if (ms >= 1) return `${ms.toFixed(3)} ms`;
  return `${(ms * 1000).toFixed(1)} µs`;
}

export function formatOps(opsPerSec) {
  if (opsPerSec >= 1_000_000) return `${(opsPerSec / 1_000_000).toFixed(2)}M`;
  if (opsPerSec >= 1_000) return `${(opsPerSec / 1_000).toFixed(1)}k`;
  return opsPerSec.toFixed(0);
}
