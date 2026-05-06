// End-to-end smoke test for @perryts/mysql.
//
// Covers: connect, auth (any plugin server offers), simple query,
// parameterised prepared query, errors, close.
//
// Usage:
//   MYSQL_HOST=127.0.0.1 MYSQL_TCP_PORT=33306 \
//   MYSQL_USER=native_user MYSQL_PASSWORD=nativepw \
//   MYSQL_DATABASE=perry_test \
//   bun examples/perry-smoke.ts

import { connect, MyError } from '../src';

async function main(): Promise<void> {
    const host = getEnv('MYSQL_HOST', '127.0.0.1');
    const port = Number(getEnv('MYSQL_TCP_PORT', '3306'));
    const user = getEnv('MYSQL_USER', 'root');
    const password = getEnv('MYSQL_PASSWORD', '');
    const database = getEnv('MYSQL_DATABASE', '');

    // eslint-disable-next-line no-console
    console.log('perry-smoke: connecting to ' + host + ':' + port + ' as ' + user);
    const conn = await connect({
        host: host,
        port: port,
        user: user,
        password: password,
        database: database,
        allowPublicKeyRetrieval: true,
    });
    // eslint-disable-next-line no-console
    console.log('  connection_id=' + conn.connection_id + ' server=' + conn.serverVersion);

    // 1. Simple query.
    const r1 = await conn.query('SELECT 1 AS one, \'hello\' AS greeting');
    // eslint-disable-next-line no-console
    console.log('  SELECT 1 → ' + JSON.stringify(r1.rows));

    // 2. Parameterised prepared query.
    const r2 = await conn.query<{ sum: number; label: string }>(
        'SELECT ? + ? AS sum, ? AS label',
        [40, 2, 'answer'],
    );
    // eslint-disable-next-line no-console
    console.log('  SELECT ? + ? → ' + JSON.stringify(r2.rows));

    // 3. Error surface.
    try {
        await conn.query('SELECT * FROM table_that_does_not_exist');
    } catch (e) {
        if (e instanceof MyError) {
            // eslint-disable-next-line no-console
            console.log('  expected error: ' + e.errno + ' / ' + e.sqlState);
        } else {
            throw e;
        }
    }

    await conn.close();
    // eslint-disable-next-line no-console
    console.log('perry-smoke: done');
}

function getEnv(name: string, fallback: string): string {
    const g = globalThis as { process?: { env?: Record<string, string> } };
    const env = g.process !== undefined && g.process.env !== undefined ? g.process.env : undefined;
    if (env !== undefined && typeof env[name] === 'string' && env[name].length > 0) {
        return env[name];
    }
    return fallback;
}

main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    const g = globalThis as { process?: { exit?: (n: number) => void } };
    if (g.process !== undefined && g.process.exit !== undefined) {
        g.process.exit(1);
    }
});
