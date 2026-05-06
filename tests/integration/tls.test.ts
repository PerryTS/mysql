import { afterEach, test, expect } from 'bun:test';
import { connect } from '../../src';
import { writeSSLRequest } from '../../src';
import { startMockServer, MockServer } from './mock-server';

// Note: positive-path TLS integration (SSLRequest → upgrade → handshake over TLS)
// is covered in `tests-node/tls-node-tests.ts` under `node --import tsx --test`.
// Bun 1.3.x's `tls.connect({socket})` silently stalls — we keep only the
// negative path and unit-level assertions here so `bun test` stays green.

let server: MockServer | null = null;

afterEach(async () => {
    if (server !== null) { await server.close(); server = null; }
});

test('sslmode=require against a non-SSL mock fails with a clear error', async () => {
    // Mock server's default advertised caps do NOT include CLIENT_SSL.
    server = await startMockServer({
        authMode: 'trust',
        password: '',
        expectedUser: 'root',
    });
    await expect(
        connect({
            host: '127.0.0.1',
            port: server.port,
            user: 'root',
            database: '',
            ssl: { mode: 'require' },
        }),
    ).rejects.toThrow(/CLIENT_SSL/);
});

test('sslmode=disable + non-SSL mock → plain handshake works', async () => {
    server = await startMockServer({
        authMode: 'trust',
        password: '',
        expectedUser: 'root',
        selectOne: { kind: 'resultset', columns: [{ name: 'v' }], rows: [{ cells: ['plain'] }] },
    });
    const c = await connect({
        host: '127.0.0.1',
        port: server.port,
        user: 'root',
        database: '',
        ssl: { mode: 'disable' },
    });
    const r = await c.query('SELECT 1');
    expect(r.rows[0]).toEqual({ v: 'plain' });
    await c.close();
});

test('SSLRequest wire shape: 32 bytes, CLIENT_SSL bit set, charset byte', () => {
    const bytes = writeSSLRequest(0x00080000 /* some caps */, 64 * 1024 * 1024, 255);
    expect(bytes.length).toBe(32);
    // CLIENT_SSL = 0x00000800. After OR with the input caps, the LE u32 low bytes should have bit 11 set.
    const caps = bytes.readUInt32LE(0);
    expect(caps & 0x00000800).toBe(0x00000800);
    expect(bytes.readUInt32LE(4)).toBe(64 * 1024 * 1024);
    expect(bytes.readUInt8(8)).toBe(255);
    // Reserved bytes 9..31 all zero.
    for (let i = 9; i < 32; i++) {
        expect(bytes.readUInt8(i)).toBe(0);
    }
});
