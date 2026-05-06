// Seed bench_1k and bench_10k tables with the 20-column / 1k + 10k row
// fixtures that workloads.ts references. Idempotent — safe to re-run.
//
// Usage:
//   MYSQL_HOST=... MYSQL_USER=... MYSQL_PASSWORD=... MYSQL_DATABASE=... \
//   bun bench/seed.ts

import { connect } from '../src';

async function main(): Promise<void> {
    const conn = await connect({
        host: env('MYSQL_HOST', '127.0.0.1'),
        port: Number(env('MYSQL_TCP_PORT', '3306')),
        user: env('MYSQL_USER', 'root'),
        password: env('MYSQL_PASSWORD', ''),
        database: env('MYSQL_DATABASE', ''),
        allowPublicKeyRetrieval: true,
    });

    for (const [name, rows] of [['bench_1k', 1000], ['bench_10k', 10000]] as const) {
        const check = await conn.query<{ c: number }>(
            "SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
            [name],
        );
        const exists = Number(check.rows[0].c) > 0;
        if (exists) {
            const size = await conn.query<{ c: number }>('SELECT COUNT(*) AS c FROM ' + name);
            if (Number(size.rows[0].c) === rows) {
                console.log(name + ' already seeded with ' + rows + ' rows');
                continue;
            }
            await conn.query('DROP TABLE ' + name);
        }
        console.log('Creating ' + name + ' (' + rows + ' rows, 20 columns)...');
        await conn.query(
            'CREATE TABLE ' + name + ' (' +
            'id INT PRIMARY KEY, ' +
            'c1 VARCHAR(64), c2 VARCHAR(64), c3 VARCHAR(64), c4 VARCHAR(64), ' +
            'c5 INT, c6 INT, c7 INT, c8 INT, ' +
            'c9 BIGINT, c10 BIGINT, ' +
            'c11 DOUBLE, c12 DOUBLE, ' +
            'c13 DATE, c14 DATETIME, ' +
            'c15 DECIMAL(10,2), c16 DECIMAL(10,2), ' +
            'c17 TEXT, c18 TEXT, c19 TINYINT)'
        );
        // Batch-insert in chunks of 200 rows per statement.
        const batchSize = 200;
        const cols = 'id,c1,c2,c3,c4,c5,c6,c7,c8,c9,c10,c11,c12,c13,c14,c15,c16,c17,c18,c19';
        for (let start = 0; start < rows; start += batchSize) {
            const end = Math.min(start + batchSize, rows);
            const values: string[] = [];
            for (let i = start; i < end; i++) {
                values.push(
                    `(${i},'s${i}','s${i}b','s${i}c','s${i}d',` +
                    `${i * 10},${i * 100},${i * 1000},${i * 10000},` +
                    `${i * 100000},${i * 1000000},` +
                    `${(i * 0.5).toFixed(4)},${(i * 0.25).toFixed(4)},` +
                    `'2024-06-01','2024-06-01 12:34:56',` +
                    `${(i * 1.23).toFixed(2)},${(i * 4.56).toFixed(2)},` +
                    `'text-${i}','text-${i}-other',${i % 100})`
                );
            }
            await conn.query('INSERT INTO ' + name + '(' + cols + ') VALUES ' + values.join(','));
            process.stdout.write('.');
        }
        console.log(' done');
    }
    await conn.close();
}

function env(name: string, fallback: string): string {
    const v = (globalThis as { process?: { env?: Record<string, string | undefined> } })
        .process?.env?.[name];
    return v !== undefined && v.length > 0 ? v : fallback;
}

main().catch((e) => { console.error(e); process.exit(1); });
