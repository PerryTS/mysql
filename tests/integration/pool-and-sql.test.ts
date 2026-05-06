import { afterEach, test, expect } from 'bun:test';
import { createPool, sql } from '../../src';
import type { Pool } from '../../src';
import { startMockServer, MockServer } from './mock-server';

let server: MockServer | null = null;
let pool: Pool | null = null;

afterEach(async () => {
    if (pool !== null) { try { await pool.end(); } catch (_) { /* ignore */ } pool = null; }
    if (server !== null) { await server.close(); server = null; }
});

test('pool.query: acquires + runs + releases in a one-shot', async () => {
    server = await startMockServer({
        authMode: 'trust',
        password: '',
        expectedUser: 'root',
        selectOne: {
            kind: 'resultset',
            columns: [{ name: 'v' }],
            rows: [{ cells: ['pool-ok'] }],
        },
    });
    pool = createPool({
        host: '127.0.0.1',
        port: server.port,
        user: 'root',
        database: '',
        max: 2,
    });
    const r = await pool.query('SELECT 1');
    expect(r.rows[0]).toEqual({ v: 'pool-ok' });
});

test('pool.transaction: runs BEGIN/COMMIT around the callback', async () => {
    server = await startMockServer({
        authMode: 'trust',
        password: '',
        expectedUser: 'root',
        cannedByQuery: new Map([
            ['BEGIN', { kind: 'ok' }],
            ['COMMIT', { kind: 'ok' }],
            ['SELECT 42', { kind: 'resultset', columns: [{ name: 'n' }], rows: [{ cells: ['42'] }] }],
        ]),
    });
    pool = createPool({
        host: '127.0.0.1',
        port: server.port,
        user: 'root',
        database: '',
    });
    const out = await pool.transaction(async (conn) => {
        const r = await conn.query('SELECT 42');
        return r.rows[0];
    });
    expect(out).toEqual({ n: '42' });
});

test('pool.size reports stats', async () => {
    server = await startMockServer({
        authMode: 'trust', password: '', expectedUser: 'root',
        selectOne: { kind: 'ok' },
    });
    pool = createPool({
        host: '127.0.0.1',
        port: server.port,
        user: 'root',
        database: '',
        max: 3,
    });
    expect(pool.size()).toEqual({ total: 0, idle: 0, waiting: 0 });
    await pool.query('SELECT 1');
    expect(pool.size().idle).toBe(1);
});

test('sql`` template: embedded params → prepared protocol', async () => {
    const prepared = new Map();
    prepared.set('SELECT ? AS v', {
        paramTypes: [0x03],
        columns: [{ name: 'v', typeCode: 0x03 }],
        execute: (params: unknown[]) => [{ cells: [String(params[0])] }],
    });
    server = await startMockServer({
        authMode: 'trust',
        password: '',
        expectedUser: 'root',
        cannedPrepared: prepared,
    });
    pool = createPool({
        host: '127.0.0.1',
        port: server.port,
        user: 'root',
        database: '',
    });
    const id = 99;
    const r = await pool.query<{ v: number }>(sql`SELECT ${id} AS v`);
    expect(r.rows[0].v).toBe(99);
});

test('connection_id + serverVersion populated from handshake', async () => {
    server = await startMockServer({
        authMode: 'trust', password: '', expectedUser: 'root',
        serverVersion: '8.4.1',
        selectOne: { kind: 'ok' },
    });
    pool = createPool({
        host: '127.0.0.1',
        port: server.port,
        user: 'root',
        database: '',
    });
    await pool.withConnection(async (conn) => {
        expect(conn.connection_id).toBeGreaterThanOrEqual(100);
        expect(conn.serverVersion).toBe('8.4.1');
    });
});
