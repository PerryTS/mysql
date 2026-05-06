import { afterEach, test, expect } from 'bun:test';
import { connect, MyError } from '../../src';
import { startMockServer, MockServer } from './mock-server';

let server: MockServer | null = null;
let conn: { close(): Promise<void> } | null = null;

afterEach(async () => {
    if (conn !== null) { try { await conn.close(); } catch (_) { /* ignore */ } conn = null; }
    if (server !== null) { await server.close(); server = null; }
});

test('LOCAL_INFILE request refused by default with a MyError', async () => {
    server = await startMockServer({
        authMode: 'trust',
        password: '',
        expectedUser: 'root',
        cannedByQuery: new Map([
            ["LOAD DATA LOCAL INFILE '/tmp/x.csv' INTO TABLE t", {
                kind: 'local-infile',
                localInfileFilename: '/tmp/x.csv',
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
    try {
        await c.query("LOAD DATA LOCAL INFILE '/tmp/x.csv' INTO TABLE t");
        throw new Error('expected refusal');
    } catch (e) {
        expect(e instanceof MyError).toBe(true);
        expect((e as MyError).message).toMatch(/LOCAL INFILE disabled/);
        expect((e as MyError).message).toMatch(/\/tmp\/x\.csv/);
    }
});
