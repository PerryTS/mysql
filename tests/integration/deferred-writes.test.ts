// Regression test for PerryTS/mysql#2 / PerryTS/perry#5021.
//
// Under a Perry-compiled Linux binary, socket writes issued from inside a
// 'data' callback are silently dropped. The driver works around it by
// queueing writes and flushing them from a zero-delay timer when running
// under Perry. This suite forces that deferred path under Bun and verifies
// the full lifecycle still works: password auth (the originally-failing
// write), text queries, prepared queries (COM_STMT_EXECUTE is written from
// the PrepareOK data handler), and close.

import { afterEach, beforeEach, test, expect } from 'bun:test';
import { connect, setForceDeferredWrites } from '../../src/connection';
import { startMockServer, MockServer } from './mock-server';
import type { CannedPrepared } from './mock-server';

let server: MockServer | null = null;
let conn: { close(): Promise<void> } | null = null;

beforeEach(() => {
    setForceDeferredWrites(true);
});

afterEach(async () => {
    setForceDeferredWrites(false);
    if (conn !== null) { try { await conn.close(); } catch (_) { /* ignore */ } conn = null; }
    if (server !== null) { await server.close(); server = null; }
});

test('deferred writes: mysql_native_password auth with a non-empty password', async () => {
    // The original failure: the HandshakeResponse41 (non-empty auth response)
    // is written from inside the 'data' handler that received the greeting.
    server = await startMockServer({
        authMode: 'native',
        password: 's3cret',
        expectedUser: 'alice',
        selectOne: {
            kind: 'resultset',
            columns: [{ name: 'one' }],
            rows: [{ cells: ['1'] }],
        },
    });
    const c = await connect({
        host: '127.0.0.1',
        port: server.port,
        user: 'alice',
        database: '',
        password: 's3cret',
        connectTimeoutMs: 2000,
    });
    conn = c;
    const r = await c.query('SELECT 1');
    expect(r.rows[0]).toEqual({ one: '1' });
    await c.close();
    conn = null;
});

test('deferred writes: queued frames keep their order across sequential queries', async () => {
    server = await startMockServer({
        authMode: 'trust',
        password: '',
        expectedUser: 'root',
        cannedByQuery: new Map([
            ['SELECT 1', { kind: 'resultset', columns: [{ name: 'a' }], rows: [{ cells: ['1'] }] }],
            ['SELECT 2', { kind: 'resultset', columns: [{ name: 'b' }], rows: [{ cells: ['2'] }] }],
        ]),
    });
    const c = await connect({
        host: '127.0.0.1',
        port: server.port,
        user: 'root',
        database: '',
        connectTimeoutMs: 2000,
    });
    conn = c;
    const r1 = await c.query('SELECT 1');
    const r2 = await c.query('SELECT 2');
    expect(r1.rows[0]).toEqual({ a: '1' });
    expect(r2.rows[0]).toEqual({ b: '2' });
    await c.close();
    conn = null;
});

test('deferred writes: prepared statement (EXECUTE is written from the data handler)', async () => {
    const prepared = new Map<string, CannedPrepared>();
    prepared.set('SELECT ? + ? AS s', {
        paramTypes: [0x03, 0x03],
        columns: [{ name: 's', typeCode: 0x03 }],
        execute: (params: unknown[]) => {
            const a = Number(params[0]);
            const b = Number(params[1]);
            return [{ cells: [String(a + b)] }];
        },
    });
    server = await startMockServer({
        authMode: 'trust',
        password: '',
        expectedUser: 'root',
        cannedPrepared: prepared,
    });
    const c = await connect({
        host: '127.0.0.1',
        port: server.port,
        user: 'root',
        database: '',
        connectTimeoutMs: 2000,
    });
    conn = c;
    const r = await c.query<{ s: number }>('SELECT ? + ? AS s', [40, 2]);
    expect(r.rows[0].s).toBe(42);
    await c.close();
    conn = null;
});

test('deferred writes: wrong password still rejects with the server ERR', async () => {
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
            connectTimeoutMs: 2000,
        }),
    ).rejects.toThrow(/1045/);
});
