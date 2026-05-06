// Perry AOT bench harness — fewer iterations, progress printed per
// workload so we can stream the output. Edit the connect() options below
// to point at your benchmark database before compiling.

import { connect } from '../src';
import { computeStats, printRow } from './stats';

interface Workload {
    name: string;
    sql: string;
    params: unknown[];
    iters: number;
    warmup: number;
}

const WORKLOADS: Workload[] = [
    { name: 'tiny',           sql: 'SELECT 1', params: [], iters: 30, warmup: 3 },
    { name: 'param-1row',     sql: 'SELECT ? AS v', params: [42], iters: 30, warmup: 3 },
    { name: 'medium-1k-x-20', sql: 'SELECT * FROM bench_1k LIMIT 1000', params: [], iters: 30, warmup: 3 },
    { name: 'large-10k-x-20', sql: 'SELECT * FROM bench_10k LIMIT 10000', params: [], iters: 10, warmup: 2 },
];

async function main(): Promise<void> {
    console.log('connecting...');
    const conn = await connect({
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
        password: '',
        database: '',
        allowPublicKeyRetrieval: true,
    });
    console.log('connected.');

    for (let w = 0; w < WORKLOADS.length; w++) {
        const wl = WORKLOADS[w];
        console.log('warming ' + wl.name + ' (' + wl.warmup + ' iters)...');
        for (let i = 0; i < wl.warmup; i++) {
            await conn.query(wl.sql, wl.params);
        }
        console.log('measuring ' + wl.name + ' (' + wl.iters + ' iters)...');
        const samples: number[] = new Array(wl.iters);
        for (let i = 0; i < wl.iters; i++) {
            const t0 = performance.now();
            await conn.query(wl.sql, wl.params);
            const t1 = performance.now();
            samples[i] = t1 - t0;
        }
        printRow('@perryts/mysql AOT: ' + wl.name, computeStats(samples));
    }
    await conn.close();
    console.log('done.');
}

main().catch((e) => {
    console.error('bench failed:', (e as Error).message);
});
