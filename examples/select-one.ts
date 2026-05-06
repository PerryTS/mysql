// Tiny example — `SELECT 1`. Useful for cold-start latency.

import { connect } from '../src';

const env = (name: string, fallback: string): string => {
    const v = (globalThis as { process?: { env?: Record<string, string | undefined> } })
        .process?.env?.[name];
    return v !== undefined && v.length > 0 ? v : fallback;
};

const conn = await connect({
    host: env('MYSQL_HOST', '127.0.0.1'),
    port: Number(env('MYSQL_TCP_PORT', '3306')),
    user: env('MYSQL_USER', 'root'),
    password: env('MYSQL_PASSWORD', ''),
    database: env('MYSQL_DATABASE', ''),
});
const r = await conn.query('SELECT 1');
// eslint-disable-next-line no-console
console.log(r.rows[0]);
await conn.close();
