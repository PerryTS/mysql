import { afterEach, test, expect } from 'bun:test';
import { connect } from '../../src';
import { startMockServer, MockServer } from './mock-server';

let server: MockServer | null = null;
let conn: { close(): Promise<void> } | null = null;

afterEach(async () => {
    if (conn !== null) { try { await conn.close(); } catch (_) { /* ignore */ } conn = null; }
    if (server !== null) { await server.close(); server = null; }
});

test('caching_sha2_password fast-auth path succeeds with correct password', async () => {
    server = await startMockServer({
        authMode: 'caching-sha2-fast',
        password: 'pw1',
        expectedUser: 'bob',
        selectOne: {
            kind: 'resultset',
            columns: [{ name: 'n' }],
            rows: [{ cells: ['ok'] }],
        },
    });
    const c = await connect({
        host: '127.0.0.1',
        port: server.port,
        user: 'bob',
        database: '',
        password: 'pw1',
    });
    conn = c;
    const r = await c.query('SELECT 1');
    expect(r.rows[0]).toEqual({ n: 'ok' });
    await c.close();
    conn = null;
});

test('caching_sha2_password fast-auth rejects wrong password', async () => {
    server = await startMockServer({
        authMode: 'caching-sha2-fast',
        password: 'correct',
        expectedUser: 'bob',
    });
    await expect(
        connect({
            host: '127.0.0.1',
            port: server.port,
            user: 'bob',
            database: '',
            password: 'wrong',
        }),
    ).rejects.toThrow(/1045/);
});

test('caching_sha2_password full-auth over plain TCP requires allowPublicKeyRetrieval=true', async () => {
    server = await startMockServer({
        authMode: 'caching-sha2-full',
        password: 'pw',
        expectedUser: 'bob',
    });
    await expect(
        connect({
            host: '127.0.0.1',
            port: server.port,
            user: 'bob',
            database: '',
            password: 'pw',
            allowPublicKeyRetrieval: false,
        }),
    ).rejects.toThrow(/full-auth requires TLS/);
});

test('auth-switch-request: server asks client to switch to native, driver complies', async () => {
    server = await startMockServer({
        authMode: 'switch-to-native',
        password: 'pw',
        expectedUser: 'carol',
        selectOne: {
            kind: 'resultset',
            columns: [{ name: 'v' }],
            rows: [{ cells: ['switched'] }],
        },
    });
    const c = await connect({
        host: '127.0.0.1',
        port: server.port,
        user: 'carol',
        database: '',
        password: 'pw',
    });
    conn = c;
    const r = await c.query('SELECT 1');
    expect(r.rows[0]).toEqual({ v: 'switched' });
    await c.close();
    conn = null;
});
