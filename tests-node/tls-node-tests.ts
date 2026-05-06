// Positive-path TLS integration tests — run under `node --import tsx --test`.
//
// Why node:test and not bun:test? Bun 1.3.x's `tls.connect({socket})`
// silently stalls (no 'secure' or 'error' fires), which breaks any
// mid-stream TLS upgrade. Node handles it cleanly. `@perryts/postgres`
// ships the same caveat — mirror the shape here.
//
// Usage:
//   npm run test:tls:node
//   # or:
//   node --import tsx --test tests-node/tls-node-tests.ts

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect } from '../src';
import { startMockServer, type MockServer } from '../tests/integration/mock-server';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CERT_PEM = readFileSync(join(__dirname, '..', 'tests', 'integration', 'tls-test-cert.pem'));
const KEY_PEM = readFileSync(join(__dirname, '..', 'tests', 'integration', 'tls-test-key.pem'));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: MockServer | null = null;

before(async () => {
    // No shared setup — each test owns its server scope so a failed
    // assertion doesn't wedge later tests (cleanup in a try/finally).
});

after(async () => {
    if (server !== null) {
        await server.close();
        server = null;
    }
});

test('sslmode=require: mid-stream TLS upgrade, auth + query over TLS', async () => {
    server = await startMockServer({
        authMode: 'trust',
        password: '',
        expectedUser: 'root',
        tls: { cert: CERT_PEM, key: KEY_PEM },
        selectOne: {
            kind: 'resultset',
            columns: [{ name: 'v' }],
            rows: [{ cells: ['over-tls'] }],
        },
    });
    try {
        const c = await connect({
            host: '127.0.0.1',
            port: server.port,
            user: 'root',
            database: '',
            ssl: { mode: 'require' },
        });
        try {
            const r = await c.query('SELECT 1');
            assert.deepEqual(r.rows[0], { v: 'over-tls' });
        } finally {
            await c.close();
        }
    } finally {
        await server.close();
        server = null;
    }
});

test('sslmode=verify-full rejects a self-signed cert', async () => {
    server = await startMockServer({
        authMode: 'trust',
        password: '',
        expectedUser: 'root',
        tls: { cert: CERT_PEM, key: KEY_PEM },
    });
    try {
        await assert.rejects(
            connect({
                host: '127.0.0.1',
                port: server.port,
                user: 'root',
                database: '',
                ssl: { mode: 'verify-full' },
            }),
        );
    } finally {
        await server.close();
        server = null;
    }
});

test('sslmode=require with caching_sha2 fast-auth over TLS', async () => {
    server = await startMockServer({
        authMode: 'caching-sha2-fast',
        password: 'secret',
        expectedUser: 'alice',
        tls: { cert: CERT_PEM, key: KEY_PEM },
        selectOne: {
            kind: 'resultset',
            columns: [{ name: 'n' }],
            rows: [{ cells: ['1'] }],
        },
    });
    try {
        const c = await connect({
            host: '127.0.0.1',
            port: server.port,
            user: 'alice',
            password: 'secret',
            database: '',
            ssl: { mode: 'require' },
        });
        try {
            const r = await c.query('SELECT 1');
            assert.deepEqual(r.rows[0], { n: '1' });
        } finally {
            await c.close();
        }
    } finally {
        await server.close();
        server = null;
    }
});
