// Benchmark harness — mysql2 reference driver.
//
// Usage:
//   cd bench && bun install  # pulls mysql2 into a local node_modules
//   cd ..
//   MYSQL_HOST=127.0.0.1 MYSQL_TCP_PORT=33306 \
//   MYSQL_USER=root MYSQL_PASSWORD=rootpw MYSQL_DATABASE=perry_test \
//   bun bench/bench-mysql2.ts

import { WORKLOADS, type Workload } from './workloads';
import { computeStats, printRow } from './stats';

const ITERATIONS = 50;
const WARMUP = 5;

async function main(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mysql = await import('mysql2/promise' as string);
    const conn = await mysql.createConnection({
        host: env('MYSQL_HOST', '127.0.0.1'),
        port: Number(env('MYSQL_TCP_PORT', '3306')),
        user: env('MYSQL_USER', 'root'),
        password: env('MYSQL_PASSWORD', ''),
        database: env('MYSQL_DATABASE', ''),
    });

    for (let i = 0; i < WORKLOADS.length; i++) {
        await runWorkload(conn, WORKLOADS[i]);
    }
    await conn.end();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runWorkload(conn: any, wl: Workload): Promise<void> {
    for (let i = 0; i < WARMUP; i++) {
        await conn.execute(wl.sql, wl.params);
    }
    const samples: number[] = new Array(ITERATIONS);
    for (let i = 0; i < ITERATIONS; i++) {
        const t0 = performance.now();
        await conn.execute(wl.sql, wl.params);
        const t1 = performance.now();
        samples[i] = t1 - t0;
    }
    printRow('mysql2: ' + wl.name, computeStats(samples));
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
