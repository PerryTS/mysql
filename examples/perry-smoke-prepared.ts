// Exercise the prepared (binary) protocol with a variety of parameter types.
//
// Usage:
//   MYSQL_HOST=... MYSQL_USER=... MYSQL_PASSWORD=... bun examples/perry-smoke-prepared.ts

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

    const cases: Array<{ sql: string; params: unknown[] }> = [
        { sql: 'SELECT ? + ? AS sum', params: [10, 32] },
        { sql: 'SELECT UPPER(?) AS upper', params: ['hello'] },
        { sql: 'SELECT ? AS big', params: [12345678901234567890n] },
        { sql: 'SELECT ? IS NULL AS is_null', params: [null] },
        { sql: 'SELECT LENGTH(?) AS len', params: [Buffer.from([1, 2, 3, 4])] },
    ];

    for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        const r = await conn.query(c.sql, c.params);
        // eslint-disable-next-line no-console
        console.log(c.sql + '  →  ' + JSON.stringify(r.rows));
    }

    await conn.close();
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
