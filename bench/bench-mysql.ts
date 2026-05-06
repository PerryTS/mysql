// Benchmark harness — legacy mysql (mysqljs) reference driver.
//
// Usage:
//   cd bench && bun install
//   cd ..
//   MYSQL_HOST=... bun bench/bench-mysql.ts

import { WORKLOADS, type Workload } from './workloads';
import { computeStats, printRow } from './stats';

const ITERATIONS = 50;
const WARMUP = 5;

// eslint-disable-next-line @typescript-eslint/no-require-imports
async function main(): Promise<void> {
    const mysql = await import('mysql' as string);
    const conn = mysql.createConnection({
        host: env('MYSQL_HOST', '127.0.0.1'),
        port: Number(env('MYSQL_TCP_PORT', '3306')),
        user: env('MYSQL_USER', 'root'),
        password: env('MYSQL_PASSWORD', ''),
        database: env('MYSQL_DATABASE', ''),
    });
    await new Promise<void>((resolve, reject) => conn.connect((err: Error | null) => err !== null ? reject(err) : resolve()));
    for (let i = 0; i < WORKLOADS.length; i++) {
        await runWorkload(conn, WORKLOADS[i]);
    }
    await new Promise<void>((resolve) => conn.end(() => resolve()));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runWorkload(conn: any, wl: Workload): Promise<void> {
    const query = (sql: string, params: unknown[]): Promise<unknown> => new Promise((resolve, reject) => {
        conn.query(sql, params, (err: Error | null, rows: unknown) => err !== null ? reject(err) : resolve(rows));
    });
    for (let i = 0; i < WARMUP; i++) {
        await query(wl.sql, wl.params);
    }
    const samples: number[] = new Array(ITERATIONS);
    for (let i = 0; i < ITERATIONS; i++) {
        const t0 = performance.now();
        await query(wl.sql, wl.params);
        const t1 = performance.now();
        samples[i] = t1 - t0;
    }
    printRow('mysql (legacy): ' + wl.name, computeStats(samples));
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
