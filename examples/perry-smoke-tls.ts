// TLS smoke test — connect with sslmode=require against a server that has TLS.
// Useful for AWS RDS, managed DBs, or a local MySQL with ssl_ca/ssl_cert
// configured.
//
// Usage:
//   MYSQL_HOST=... MYSQL_USER=... MYSQL_PASSWORD=... \
//   MYSQL_SSL_MODE=REQUIRED bun examples/perry-smoke-tls.ts

import { connect } from '../src';

async function main(): Promise<void> {
    const conn = await connect({
        host: env('MYSQL_HOST', '127.0.0.1'),
        port: Number(env('MYSQL_TCP_PORT', '3306')),
        user: env('MYSQL_USER', 'root'),
        password: env('MYSQL_PASSWORD', ''),
        database: env('MYSQL_DATABASE', ''),
        ssl: { mode: 'require' },
    });
    const r = await conn.query("SHOW STATUS LIKE 'Ssl_cipher'");
    // eslint-disable-next-line no-console
    console.log('negotiated TLS: ' + JSON.stringify(r.rows[0]));
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
