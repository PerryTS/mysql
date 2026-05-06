// Integration tests against a real MySQL 8 / MariaDB 11 server.
//
// Skipped unless the `MYSQL_REAL=1` environment flag is set (prevents
// breaking the default `bun test` run when no server is running). Use
// the docker-compose.yml sibling file to bring one up.
//
// Usage:
//   docker compose -f tests/integration/docker-compose.yml up -d
//   MYSQL_REAL=1 \
//   MYSQL_HOST=127.0.0.1 MYSQL_TCP_PORT=33306 \
//   MYSQL_USER=root MYSQL_PASSWORD=rootpw MYSQL_DATABASE=perry_test \
//   bun test tests/integration/real-server.test.ts
//
// For MariaDB 11 point MYSQL_TCP_PORT at 33307 instead.

import { describe, test, expect, afterAll } from 'bun:test';
import { connect, type Connection } from '../../src';

const realServer = typeof process !== 'undefined' && process.env.MYSQL_REAL === '1';
const suite = realServer ? describe : describe.skip;

suite('real MySQL/MariaDB server', () => {
    let conn: Connection | null = null;

    afterAll(async () => {
        if (conn !== null) {
            try { await conn.close(); } catch (_) { /* ignore */ }
        }
    });

    const baseOpts = () => ({
        host: process.env.MYSQL_HOST || '127.0.0.1',
        port: Number(process.env.MYSQL_TCP_PORT || '3306'),
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD || '',
        database: process.env.MYSQL_DATABASE || '',
        allowPublicKeyRetrieval: true,
    });

    test('connect + SELECT 1', async () => {
        conn = await connect(baseOpts());
        const r = await conn.query<{ one: number }>('SELECT 1 AS one');
        expect(r.rows[0].one).toBe(1);
        expect(conn.connection_id).toBeGreaterThan(0);
        expect(conn.serverVersion.length).toBeGreaterThan(0);
    });

    test('prepared SELECT ? + ? returns correct sum', async () => {
        if (conn === null) { throw new Error('no conn'); }
        const r = await conn.query<{ sum: number }>('SELECT ? + ? AS sum', [40, 2]);
        expect(r.rows[0].sum).toBe(42);
    });

    test('text SELECT of all common types decodes via codec registry', async () => {
        if (conn === null) { throw new Error('no conn'); }
        const r = await conn.query(
            "SELECT CAST(1 AS SIGNED) AS i, CAST(9999999999999999999 AS UNSIGNED) AS big, " +
            "CAST(3.14 AS DOUBLE) AS d, CAST('hi' AS CHAR) AS s, " +
            "CAST('2024-06-01' AS DATE) AS dt, CAST('1.23' AS DECIMAL(5,2)) AS decval"
        );
        expect(r.rows.length).toBe(1);
        const row = r.rows[0] as Record<string, unknown>;
        expect(Number(row.i)).toBe(1);
        expect(typeof row.d).toBe('number');
        expect(row.s).toBe('hi');
        expect(String(row.decval)).toBe('1.23');
    });

    test('transaction with rollback leaves state unchanged', async () => {
        if (conn === null) { throw new Error('no conn'); }
        try {
            await conn.query('DROP TABLE IF EXISTS perry_tx_test');
            await conn.query('CREATE TABLE perry_tx_test (id INT PRIMARY KEY)');
            await conn.query('INSERT INTO perry_tx_test VALUES (1)');
            await conn.transaction(async (tx) => {
                await tx.query('INSERT INTO perry_tx_test VALUES (2)');
                throw new Error('abort');
            }).catch(() => { /* expected */ });
            const r = await conn.query<{ c: number }>('SELECT COUNT(*) AS c FROM perry_tx_test');
            expect(Number(r.rows[0].c)).toBe(1);
        } finally {
            await conn.query('DROP TABLE IF EXISTS perry_tx_test');
        }
    });

    test('error surface: bad query', async () => {
        if (conn === null) { throw new Error('no conn'); }
        try {
            await conn.query('SELECT * FROM table_that_does_not_exist_ever');
            throw new Error('expected reject');
        } catch (e) {
            expect((e as { errno: number }).errno).toBeGreaterThan(0);
        }
    });

    test('1000-row bulk projection round-trip', async () => {
        if (conn === null) { throw new Error('no conn'); }
        // Use a recursive CTE to generate 1000 rows server-side.
        const r = await conn.query<{ n: number }>(
            'WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n < 1000) SELECT n FROM s'
        );
        expect(r.rows.length).toBe(1000);
        expect(Number(r.rows[0].n)).toBe(1);
        expect(Number(r.rows[999].n)).toBe(1000);
    });

    test('LONGLONG unsigned > MAX_SAFE_INTEGER returns bigint', async () => {
        if (conn === null) { throw new Error('no conn'); }
        const r = await conn.query<{ v: bigint | number }>(
            'SELECT CAST(18446744073709551615 AS UNSIGNED) AS v'
        );
        expect(typeof r.rows[0].v).toBe('bigint');
        expect(r.rows[0].v).toBe(18446744073709551615n);
    });

    test('temporal types round-trip via text protocol', async () => {
        if (conn === null) { throw new Error('no conn'); }
        const r = await conn.query(
            "SELECT CAST('2024-06-01' AS DATE) AS d, " +
            "CAST('12:34:56.123456' AS TIME(6)) AS t, " +
            "CAST('2024-06-01 12:34:56.123456' AS DATETIME(6)) AS dt"
        );
        const row = r.rows[0] as Record<string, { toString(): string }>;
        expect(String(row.d)).toBe('2024-06-01');
        expect(String(row.t)).toContain('12:34:56.123456');
        expect(String(row.dt)).toBe('2024-06-01 12:34:56.123456');
    });

    test('prepared INSERT / SELECT / DELETE lifecycle', async () => {
        if (conn === null) { throw new Error('no conn'); }
        try {
            await conn.query('DROP TABLE IF EXISTS perry_crud');
            await conn.query(
                'CREATE TABLE perry_crud (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(64) NOT NULL, n BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)'
            );
            const ins1 = await conn.query('INSERT INTO perry_crud (name, n) VALUES (?, ?)', ['alice', 100n]);
            expect(ins1.rowCount).toBe(1);
            expect(Number(ins1.lastInsertId)).toBeGreaterThan(0);
            const ins2 = await conn.query('INSERT INTO perry_crud (name, n) VALUES (?, ?), (?, ?)', ['bob', 200n, 'carol', 300n]);
            expect(ins2.rowCount).toBe(2);

            const rows = await conn.query<{ id: number; name: string; n: number }>(
                'SELECT id, name, n FROM perry_crud WHERE n >= ? ORDER BY id', [150n]
            );
            expect(rows.rows.length).toBe(2);
            expect(rows.rows[0].name).toBe('bob');
            expect(rows.rows[1].name).toBe('carol');

            const del = await conn.query('DELETE FROM perry_crud WHERE name = ?', ['bob']);
            expect(del.rowCount).toBe(1);
        } finally {
            await conn.query('DROP TABLE IF EXISTS perry_crud').catch(() => {});
        }
    });

    test('pool: 10 concurrent queries share connections', async () => {
        const { createPool } = await import('../../src');
        const pool = createPool({ ...baseOpts(), max: 4 });
        try {
            const out = await Promise.all(Array.from({ length: 10 }).map((_, i) =>
                pool.query<{ n: number }>('SELECT ? AS n', [i]).then((r) => Number(r.rows[0].n))
            ));
            expect(out).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
            expect(pool.size().total).toBeLessThanOrEqual(4);
        } finally {
            await pool.end();
        }
    });

    test('TLS: sslmode=require upgrades cleanly against real server', async () => {
        const c = await connect({ ...baseOpts(), ssl: { mode: 'require' } });
        try {
            const r = await c.query<{ c: string }>("SHOW STATUS LIKE 'Ssl_cipher'");
            // The cipher field should be non-empty when TLS is active.
            const cipher = (r.rows[0] as { Value: string }).Value;
            expect(cipher.length).toBeGreaterThan(0);
        } finally {
            await c.close();
        }
    });

    test('multi-statement: two SELECTs in one COM_QUERY', async () => {
        const c = await connect({ ...baseOpts(), multipleStatements: true });
        try {
            const r = await c.query('SELECT 1 AS a; SELECT 2 AS b');
            expect(r.resultSets).toBeDefined();
            expect(r.resultSets!.length).toBe(2);
            expect(Number((r.resultSets![0].rows[0] as { a: number }).a)).toBe(1);
            expect(Number((r.resultSets![1].rows[0] as { b: number }).b)).toBe(2);
        } finally {
            await c.close();
        }
    });

    test('KILL QUERY via conn.cancel() interrupts a long SLEEP', async () => {
        const c = await connect(baseOpts());
        try {
            const t0 = Date.now();
            const pending = c.query<{ slept: number }>('SELECT SLEEP(30) AS slept');
            await new Promise((r) => setTimeout(r, 300));
            await c.cancel();
            const result = await pending;
            const elapsed = Date.now() - t0;
            // `SLEEP()` returns 1 when interrupted by KILL QUERY, 0 when it
            // runs to completion. Also assert the wall-clock time is far
            // below the 30 s sleep — if cancel silently no-op'd we'd see
            // ~30 s elapsed.
            expect(Number(result.rows[0].slept)).toBe(1);
            expect(elapsed).toBeLessThan(5000);
        } finally {
            await c.close();
        }
    });
});
