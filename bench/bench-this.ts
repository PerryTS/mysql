// Benchmark harness for @perryts/mysql itself.
//
// Usage:
//   MYSQL_HOST=127.0.0.1 MYSQL_TCP_PORT=33306 \
//   MYSQL_USER=root MYSQL_PASSWORD=rootpw MYSQL_DATABASE=perry_test \
//   bun bench/bench-this.ts
//
// Setup (once):
//   CREATE TABLE bench_1k  (...20 columns...);  INSERT 1000 rows;
//   CREATE TABLE bench_10k (...20 columns...);  INSERT 10000 rows;

import { connect } from '../src';
import { WORKLOADS, type Workload } from './workloads';
import { computeStats, printRow } from './stats';

const ITERATIONS = 50;
const WARMUP = 5;

async function main(): Promise<void> {
    const conn = await connect({
        host: env('MYSQL_HOST', '127.0.0.1'),
        port: Number(env('MYSQL_TCP_PORT', '3306')),
        user: env('MYSQL_USER', 'root'),
        password: env('MYSQL_PASSWORD', ''),
        database: env('MYSQL_DATABASE', ''),
        allowPublicKeyRetrieval: true,
    });

    for (let i = 0; i < WORKLOADS.length; i++) {
        await runWorkload(conn, WORKLOADS[i]);
    }
    await conn.close();
}

async function runWorkload(
    conn: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    wl: Workload,
): Promise<void> {
    // Warm up (skip timing).
    for (let i = 0; i < WARMUP; i++) {
        await conn.query(wl.sql, wl.params);
    }
    const samples: number[] = new Array(ITERATIONS);
    for (let i = 0; i < ITERATIONS; i++) {
        const t0 = performance.now();
        const r = await conn.query(wl.sql, wl.params);
        const t1 = performance.now();
        samples[i] = t1 - t0;
        if (wl.expectedRows > 0 && r.rows.length !== wl.expectedRows) {
            // eslint-disable-next-line no-console
            console.warn('[bench] ' + wl.name + ': expected ' + wl.expectedRows + ' rows, got ' + r.rows.length);
        }
    }
    printRow('@perryts/mysql: ' + wl.name, computeStats(samples));
}

function env(name: string, fallback: string): string {
    const v = (globalThis as { process?: { env?: Record<string, string | undefined> } })
        .process?.env?.[name];
    return v !== undefined && v.length > 0 ? v : fallback;
}

main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    (globalThis as { process?: { exit?: (n: number) => void } }).process?.exit?.(1);
});
