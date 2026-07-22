# Reproduces a constrained production server (e.g. 4 GB RAM / 2 vCPU VPS).
#
# The point is the MEMORY LIMIT: on a dev machine with plenty of RAM the OS page
# cache holds the entire database, so every read is a RAM hit and the benchmark
# reports numbers a small VPS will never reach. Running inside a memory-capped
# container makes the page cache genuinely scarce, which is the whole question
# once the dataset is larger than RAM.
FROM node:24-slim

# better-sqlite3 ships prebuilds for most platforms but may need to compile.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src

# Databases live on a mounted volume so the seeded template survives between
# runs and doesn't count against the container's writable layer.
ENV BENCH_DATA_DIR=/data
VOLUME /data

ENTRYPOINT ["node", "--no-warnings", "src/prod.js"]
CMD ["--scale", "xlarge", "--threads", "2", "--duration", "20"]
