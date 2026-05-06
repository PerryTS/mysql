# Benchmarks

Compares `@perryts/mysql` against `mysql2` and the legacy `mysql` driver.

## Setup

```sh
docker compose -f ../tests/integration/docker-compose.yml up -d
# Create the benchmark tables (see workloads.ts for schema expectations):
mysql -h 127.0.0.1 -P 33306 -uroot -prootpw perry_test < seed.sql
```

## Run

```sh
MYSQL_HOST=127.0.0.1 MYSQL_TCP_PORT=33306 \
MYSQL_USER=root MYSQL_PASSWORD=rootpw MYSQL_DATABASE=perry_test \
bun bench/bench-this.ts
```

Per-workload stats are printed as `min / median / mean / p95 / max` in ms.

## Workloads

- **tiny** — `SELECT 1`, text protocol. Measures fixed overhead.
- **param-1row** — `SELECT ?`, prepared protocol, one row. Measures
  Parse / Execute / Sync fixed cost.
- **medium-1k-x-20** — 1 000 rows × 20 columns. Measures per-row decode.
- **large-10k-x-20** — 10 000 rows × 20 columns. Measures bulk throughput.
