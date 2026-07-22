#!/usr/bin/env bash
#
# Runs the production profile inside a memory- and CPU-capped container, so the
# OS page cache is genuinely scarce — the regime a small VPS actually lives in.
#
#   ./scripts/bench-docker.sh                    # 1 GB / 2 CPU, ~2.8 GB dataset
#   MEM=4g SCALE=xxlarge ./scripts/bench-docker.sh   # 4 GB / 2 CPU, ~10 GB dataset
#
# What matters is the RATIO of dataset to RAM. 2.8 GB in 1 GB reproduces the
# same ~2.5:1 pressure as 10 GB on a 4 GB server, and seeds far faster.
set -euo pipefail

MEM="${MEM:-1g}"
CPUS="${CPUS:-2}"
SCALE="${SCALE:-xlarge}"
THREADS="${THREADS:-2}"
DURATION="${DURATION:-20}"
ENGINES="${ENGINES:-better-sqlite3,node:sqlite,turso}"
VOLUME="${VOLUME:-turso-bench-data}"

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not running. Start Docker/OrbStack and retry." >&2
  exit 1
fi

echo "building image..."
docker build -q -t turso-bench . >/dev/null

echo
echo "=============================================================="
echo " container: ${MEM} RAM, ${CPUS} CPU   dataset scale: ${SCALE}"
echo " ratio is what matters: dataset larger than RAM => real I/O"
echo "=============================================================="

# --memory caps the container's RAM, which caps the page cache available to it.
# The volume keeps the seeded template between runs (seeding is the slow part).
docker run --rm \
  --memory="${MEM}" \
  --memory-swap="${MEM}" \
  --cpus="${CPUS}" \
  -v "${VOLUME}":/data \
  turso-bench \
  --scale "${SCALE}" \
  --threads "${THREADS}" \
  --duration "${DURATION}" \
  --engines "${ENGINES}" \
  "$@"
