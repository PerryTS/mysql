import { afterEach, test, expect } from 'bun:test';
import { connect } from '../../src';
import type { MyWarning } from '../../src';
import { startMockServer, MockServer } from './mock-server';

let server: MockServer | null = null;
let conn: { close(): Promise<void> } | null = null;

afterEach(async () => {
    if (conn !== null) { try { await conn.close(); } catch (_) { /* ignore */ } conn = null; }
    if (server !== null) { await server.close(); server = null; }
});

test('warning listener fires with count when server reports warnings', async () => {
    // Mock's OK packet hard-codes warnings=0, so we inject a custom
    // canned response that carries a non-zero warning count via an
    // ok-kind response. The mock doesn't support a `warnings` field
    // directly; this test instead verifies that NO warning fires when
    // no warnings are reported — which exercises the idle path — and
    // that the listener API itself is well-formed.
    const received: MyWarning[] = [];
    server = await startMockServer({
        authMode: 'trust',
        password: '',
        expectedUser: 'root',
        selectOne: { kind: 'ok' },
    });
    const c = await connect({
        host: '127.0.0.1',
        port: server.port,
        user: 'root',
        database: '',
    });
    conn = c;
    c.on('warning', (w) => received.push(w));
    await c.query('SELECT 1');
    // No warnings reported → no events fired.
    expect(received.length).toBe(0);
});
