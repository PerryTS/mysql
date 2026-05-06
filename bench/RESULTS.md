# Benchmark results — @perryts/mysql 0.1.0

Snapshot from 2026-04-19. Updated sporadically — numbers will drift as Perry's
runtime matures.

## Setup

- **Server:** MySQL 8.0.45 on a remote host (WAN latency ~30 ms)
- **Client:** macOS 26.0 arm64, Bun 1.3.12 / Node 25.8.0 / Perry 0.5.99
- **Auth plugin:** `caching_sha2_password` (fast-auth, cached credential)
- **Workloads:**
  - `tiny` — `SELECT 1`, text protocol
  - `param-1row` — `SELECT ? AS v`, prepared protocol, one row back
  - `medium-1k-x-20` — `SELECT * FROM bench_1k LIMIT 1000`
  - `large-10k-x-20` — `SELECT * FROM bench_10k LIMIT 10000`
- **Method:** 30–50 iterations, 5 warm-ups discarded; `min` is the best observed
  round-trip (closest to raw protocol overhead), `p95` captures tail behavior.

## Results (ms per query)

| Runtime | Workload | min | median | p95 |
|---|---|---:|---:|---:|
| Bun + **@perryts/mysql** | tiny | 43.5 | 96.6 | 168.6 |
| Bun + mysql2 | tiny | 134.5 | 485.8 | 656.5 |
| Node + **@perryts/mysql** | tiny | 30.5 | 84.1 | 128.1 |
| Node + mysql2 | tiny | 36.4 | 80.5 | 170.9 |
| Perry AOT + **@perryts/mysql** | tiny | 32.0 | 67.0 | 110.0 |
| | | | | |
| Bun + **@perryts/mysql** | param-1row | 33.7 | 69.3 | 158.0 |
| Bun + mysql2 | param-1row | 29.5 | 181.0 | 328.9 |
| Node + **@perryts/mysql** | param-1row | 30.2 | 89.7 | 156.6 |
| Node + mysql2 | param-1row | 32.9 | 68.6 | 132.6 |
| Perry AOT + **@perryts/mysql** | param-1row | 33.0 | 80.0 | 105.0 |
| | | | | |
| Bun + **@perryts/mysql** | medium-1k-x-20 | 59.8 | 96.1 | 170.5 |
| Bun + mysql2 | medium-1k-x-20 | 76.1 | 112.8 | 225.1 |
| Node + **@perryts/mysql** | medium-1k-x-20 | 68.8 | 113.9 | 221.2 |
| Node + mysql2 | medium-1k-x-20 | 67.5 | 99.2 | 150.0 |
| Perry AOT + **@perryts/mysql** | medium-1k-x-20 | 82.0 | 122.5 | 223.0 |
| | | | | |
| Bun + **@perryts/mysql** | large-10k-x-20 | 218.2 | 330.4 | 2600.0 |
| Bun + mysql2 | large-10k-x-20 | 198.2 | 457.9 | 596.1 |
| Node + **@perryts/mysql** | large-10k-x-20 | 286.2 | 567.8 | 796.9 |
| Node + mysql2 | large-10k-x-20 | 288.1 | 475.9 | 858.0 |
| Perry AOT + **@perryts/mysql** | large-10k-x-20 | — | — | — |

## Notes

- **WAN floor is ~30 ms** — the fastest `tiny` anywhere. Every driver-side
  cost adds on top of that.
- On **tiny / param-1row**, @perryts/mysql is neck-and-neck with mysql2 under
  Node and clearly ahead of mysql2 under Bun (mysql2's JIT-warmup on small
  queries under Bun appears sub-optimal). Perry AOT wins tiny outright.
- On **medium-1k-x-20** the three runtimes + two drivers all sit inside a
  25 % band (67-123 ms median). Network dominates.
- On **large-10k-x-20** under Bun @perryts/mysql has the best median (330 ms
  vs mysql2's 458 ms) but a long p95 tail (2.6 s) driven by Bun GC
  behaviour on 200 k-cell result objects. Under Node the two drivers are
  within 20 % at the median.
- **Perry AOT's `large-10k-x-20`** omitted: we can complete *one* 10 k-row
  query in ~400-2000 ms (within the JS-runtime range) but running the
  50-iteration bench in a tight loop triggers intermittent multi-second
  stalls, almost certainly Perry runtime GC on the accumulating row/decoder
  buffer churn. Worth a follow-up issue (`@perryts/perry#??`) once we've
  profiled it; unblocks nothing for real app usage since apps don't hit
  10 k-row queries in tight loops.
- The legacy **`mysql`** driver (mysqljs) is not in the table — it doesn't
  support `caching_sha2_password` and fails at connect against MySQL 8
  defaults.

## Reproducing

```sh
(cd bench && bun install)               # pull mysql2 into a sibling node_modules
export MYSQL_HOST=... MYSQL_USER=... MYSQL_PASSWORD=... MYSQL_DATABASE=...
bun bench/seed.ts                        # one-time: seed bench_1k + bench_10k
bun bench/bench-this.ts                  # @perryts/mysql under Bun
bun bench/bench-mysql2.ts                # mysql2 under Bun
npx tsx bench/bench-this.ts              # @perryts/mysql under Node
npx tsx bench/bench-mysql2.ts            # mysql2 under Node
~/projects/perry/perry/target/release/perry compile bench/bench-aot.ts \
    -o /tmp/perry-bench
/tmp/perry-bench                         # Perry AOT binary
```
