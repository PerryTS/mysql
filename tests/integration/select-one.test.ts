import { afterEach, test, expect } from 'bun:test';
import { connect } from '../../src';
import { startMockServer, MockServer } from './mock-server';

let server: MockServer | null = null;
let conn: { close(): Promise<void> } | null = null;

afterEach(async () => {
    if (conn !== null) { try { await conn.close(); } catch (_) { /* ignore */ } conn = null; }
    if (server !== null) { await server.close(); server = null; }
});

test('trust-mode: handshake + SELECT 1', async () => {
    server = await startMockServer({
        authMode: 'trust',
        password: '',
        expectedUser: 'root',
        selectOne: {
            kind: 'resultset',
            columns: [{ name: 'one' }],
            rows: [{ cells: ['1'] }],
        },
    });
    const c = await connect({
        host: '127.0.0.1',
        port: server.port,
        user: 'root',
        database: '',
    });
    conn = c;
    expect(c.connection_id).toBeGreaterThan(0);
    expect(c.serverVersion).toBe('8.0.36');
    const r = await c.query('SELECT 1');
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]).toEqual({ one: '1' });
    expect(r.rowsArray[0]).toEqual(['1']);
    expect(r.fields[0].name).toBe('one');
    expect(r.command).toBe('SELECT');
    await c.close();
    conn = null;
});

test('mysql_native_password: correct password is accepted', async () => {
    server = await startMockServer({
        authMode: 'native',
        password: 's3cret',
        expectedUser: 'alice',
        selectOne: {
            kind: 'resultset',
            columns: [{ name: 'hello' }],
            rows: [{ cells: ['world'] }],
        },
    });
    const c = await connect({
        host: '127.0.0.1',
        port: server.port,
        user: 'alice',
        database: '',
        password: 's3cret',
    });
    conn = c;
    const r = await c.query('SELECT 1');
    expect(r.rows[0]).toEqual({ hello: 'world' });
    await c.close();
    conn = null;
});

test('mysql_native_password: wrong password rejected with MyError', async () => {
    server = await startMockServer({
        authMode: 'native',
        password: 's3cret',
        expectedUser: 'alice',
    });
    await expect(
        connect({
            host: '127.0.0.1',
            port: server.port,
            user: 'alice',
            database: '',
            password: 'WRONG',
        }),
    ).rejects.toThrow(/1045/);
});

test('wrong user is rejected', async () => {
    server = await startMockServer({
        authMode: 'native',
        password: 'pw',
        expectedUser: 'alice',
    });
    await expect(
        connect({
            host: '127.0.0.1',
            port: server.port,
            user: 'bob',
            database: '',
            password: 'pw',
        }),
    ).rejects.toThrow(/1045/);
});

test('OK-only query (INSERT) returns affected rows + lastInsertId', async () => {
    server = await startMockServer({
        authMode: 'trust',
        password: '',
        expectedUser: 'root',
        cannedByQuery: new Map([
            ['INSERT INTO t VALUES (1)', { kind: 'ok', affectedRows: 3, lastInsertId: 17 }],
        ]),
    });
    const c = await connect({
        host: '127.0.0.1',
        port: server.port,
        user: 'root',
        database: '',
    });
    conn = c;
    const r = await c.query('INSERT INTO t VALUES (1)');
    expect(r.rowCount).toBe(3);
    expect(r.lastInsertId).toBe(17);
    expect(r.rows.length).toBe(0);
    await c.close();
    conn = null;
});

test('server ERR surfaces as MyError with sqlstate + errno', async () => {
    server = await startMockServer({
        authMode: 'trust',
        password: '',
        expectedUser: 'root',
        cannedByQuery: new Map([
            ['BROKEN', { kind: 'err', errno: 1064, sqlState: '42000', message: 'syntax error' }],
        ]),
    });
    const c = await connect({
        host: '127.0.0.1',
        port: server.port,
        user: 'root',
        database: '',
    });
    conn = c;
    try {
        await c.query('BROKEN');
        throw new Error('expected reject');
    } catch (e) {
        const err = e as { errno?: number; sqlState?: string };
        expect(err.errno).toBe(1064);
        expect(err.sqlState).toBe('42000');
    }
    await c.close();
    conn = null;
});
