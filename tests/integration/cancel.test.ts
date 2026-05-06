import { afterEach, test, expect } from 'bun:test';
import { connect, MyError } from '../../src';
import { startMockServer, MockServer } from './mock-server';

let server: MockServer | null = null;
let conn: { close(): Promise<void> } | null = null;

afterEach(async () => {
    if (conn !== null) { try { await conn.close(); } catch (_) { /* ignore */ } conn = null; }
    if (server !== null) { await server.close(); server = null; }
});

test('conn.cancel() terminates a long-running query with errno 1317', async () => {
    server = await startMockServer({
        authMode: 'trust',
        password: '',
        expectedUser: 'root',
        killSupported: true,
        simulatedSleepMs: 5_000,
        cannedByQuery: new Map([
            ['SELECT SLEEP(30)', {
                kind: 'resultset',
                columns: [{ name: 'sleep' }],
                rows: [{ cells: ['0'] }],
            }],
        ]),
    });
    const c = await connect({
        host: '127.0.0.1',
        port: server.port,
        user: 'root',
        database: '',
    });
    conn = c;

    const queryPromise = c.query('SELECT SLEEP(30)').catch((e) => e);

    // Wait a beat so the server has registered the in-flight query as cancellable.
    await new Promise((r) => setTimeout(r, 100));
    await c.cancel();

    const result = await queryPromise;
    expect(result instanceof MyError).toBe(true);
    expect((result as MyError).errno).toBe(1317);
    expect((result as MyError).sqlState).toBe('70100');

    await c.close();
    conn = null;
});

test('conn.cancel() on idle connection is a no-op that does not throw', async () => {
    server = await startMockServer({
        authMode: 'trust',
        password: '',
        expectedUser: 'root',
        killSupported: true,
    });
    const c = await connect({
        host: '127.0.0.1',
        port: server.port,
        user: 'root',
        database: '',
    });
    conn = c;
    // No query in flight — cancel() should still resolve cleanly.
    await c.cancel();
});
