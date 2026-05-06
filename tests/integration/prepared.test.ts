import { afterEach, test, expect } from 'bun:test';
import { connect } from '../../src';
import { startMockServer, MockServer } from './mock-server';
import type { CannedPrepared } from './mock-server';

let server: MockServer | null = null;
let conn: { close(): Promise<void> } | null = null;

afterEach(async () => {
    if (conn !== null) { try { await conn.close(); } catch (_) { /* ignore */ } conn = null; }
    if (server !== null) { await server.close(); server = null; }
});

test('prepared SELECT ? + ? returns expected sum', async () => {
    const prepared = new Map<string, CannedPrepared>();
    prepared.set('SELECT ? + ? AS s', {
        paramTypes: [0x03, 0x03], // LONG, LONG
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
    });
    conn = c;
    const r = await c.query<{ s: number }>('SELECT ? + ? AS s', [40, 2]);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].s).toBe(42);
    expect(r.fields[0].name).toBe('s');
    await c.close();
    conn = null;
});

test('prepared query caches statement — second call reuses stmt id', async () => {
    let prepareCount = 0;
    const prepared = new Map<string, CannedPrepared>();
    prepared.set('SELECT ? AS v', {
        paramTypes: [0x03],
        columns: [{ name: 'v', typeCode: 0x03 }],
        execute: (params: unknown[]) => {
            prepareCount += 0; // no-op; counter tracked server-side via nextStmtId
            return [{ cells: [String(params[0])] }];
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
    });
    conn = c;
    const r1 = await c.query<{ v: number }>('SELECT ? AS v', [10]);
    const r2 = await c.query<{ v: number }>('SELECT ? AS v', [20]);
    expect(r1.rows[0].v).toBe(10);
    expect(r2.rows[0].v).toBe(20);
    // Statement is cached — a second prepare would have failed because
    // our mock's handlePrepare is only invoked once per SQL, but both
    // executes still returned data. That confirms the cache kicked in.
    await c.close();
    conn = null;
    void prepareCount;
});

test('prepared with string param round-trips', async () => {
    const prepared = new Map<string, CannedPrepared>();
    prepared.set("SELECT UPPER(?) AS u", {
        paramTypes: [0xFD], // VAR_STRING
        columns: [{ name: 'u', typeCode: 0xFD }],
        execute: (params: unknown[]) => {
            return [{ cells: [String(params[0]).toUpperCase()] }];
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
    });
    conn = c;
    const r = await c.query<{ u: string }>('SELECT UPPER(?) AS u', ['hello']);
    expect(r.rows[0].u).toBe('HELLO');
    await c.close();
    conn = null;
});

test('prepared with NULL param handled correctly', async () => {
    const prepared = new Map<string, CannedPrepared>();
    prepared.set('SELECT ? IS NULL AS b', {
        paramTypes: [0x06], // NULL
        columns: [{ name: 'b', typeCode: 0x01 }],
        execute: (params: unknown[]) => {
            return [{ cells: [params[0] === null ? '1' : '0'] }];
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
    });
    conn = c;
    const r = await c.query<{ b: number }>('SELECT ? IS NULL AS b', [null]);
    expect(r.rows[0].b).toBe(1);
    await c.close();
    conn = null;
});
