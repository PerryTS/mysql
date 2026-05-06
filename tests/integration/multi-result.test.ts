import { afterEach, test, expect } from 'bun:test';
import { connect } from '../../src';
import { startMockServer, MockServer } from './mock-server';

let server: MockServer | null = null;
let conn: { close(): Promise<void> } | null = null;

afterEach(async () => {
    if (conn !== null) { try { await conn.close(); } catch (_) { /* ignore */ } conn = null; }
    if (server !== null) { await server.close(); server = null; }
});

test('multi-resultset: two SELECTs streamed in one response', async () => {
    server = await startMockServer({
        authMode: 'trust',
        password: '',
        expectedUser: 'root',
        cannedByQuery: new Map([
            ['SELECT 1; SELECT 2', {
                kind: 'resultset',
                columns: [{ name: 'a' }],
                rows: [{ cells: ['1'] }],
                moreResults: [
                    {
                        kind: 'resultset',
                        columns: [{ name: 'b' }],
                        rows: [{ cells: ['2'] }],
                    },
                ],
            }],
        ]),
    });
    const c = await connect({
        host: '127.0.0.1',
        port: server.port,
        user: 'root',
        database: '',
        multipleStatements: true,
    });
    conn = c;
    const r = await c.query('SELECT 1; SELECT 2');
    // Primary result (returned as the last set) has b=2.
    expect(r.rows[0]).toEqual({ b: '2' });
    expect(r.resultSets).toBeDefined();
    expect(r.resultSets!.length).toBe(2);
    expect(r.resultSets![0].rows[0]).toEqual({ a: '1' });
    expect(r.resultSets![1].rows[0]).toEqual({ b: '2' });
    await c.close();
    conn = null;
});

test('multi-resultset: OK + SELECT pipeline', async () => {
    server = await startMockServer({
        authMode: 'trust',
        password: '',
        expectedUser: 'root',
        cannedByQuery: new Map([
            ['INSERT INTO t VALUES (1); SELECT 42', {
                kind: 'ok',
                affectedRows: 1,
                lastInsertId: 100,
                moreResults: [
                    {
                        kind: 'resultset',
                        columns: [{ name: 'n' }],
                        rows: [{ cells: ['42'] }],
                    },
                ],
            }],
        ]),
    });
    const c = await connect({
        host: '127.0.0.1',
        port: server.port,
        user: 'root',
        database: '',
        multipleStatements: true,
    });
    conn = c;
    const r = await c.query('INSERT INTO t VALUES (1); SELECT 42');
    expect(r.resultSets!.length).toBe(2);
    expect(r.resultSets![0].rowCount).toBe(1);
    expect(r.resultSets![0].lastInsertId).toBe(100);
    expect(r.resultSets![1].rows[0]).toEqual({ n: '42' });
    await c.close();
    conn = null;
});
