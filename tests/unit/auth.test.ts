import { test, expect } from 'bun:test';
import { nativeScramble } from '../../src/auth/native-password';
import { sha256Scramble, CACHING_SHA2_PASSWORD } from '../../src/auth/caching-sha2';
import { NATIVE_PASSWORD } from '../../src/auth/native-password';
import { MYSQL_CLEAR_PASSWORD } from '../../src/auth/clear-password';
import type { AuthCtx } from '../../src/auth/dispatcher';
import { xorScramblePassword } from '../../src/auth/rsa';

function freshCtx(overrides: Partial<AuthCtx>): AuthCtx {
    return {
        username: 'root',
        password: 'secret',
        challenge: Buffer.alloc(20, 0x01),
        tlsActive: false,
        allowPublicKeyRetrieval: false,
        scratch: new Map<string, unknown>(),
        ...overrides,
    };
}

test('nativeScramble: empty password returns empty buffer from plugin', () => {
    const ctx = freshCtx({ password: '' });
    const out = NATIVE_PASSWORD.initialResponse(ctx);
    expect(out.length).toBe(0);
});

test('nativeScramble: non-empty password produces a 20-byte token', () => {
    const out = nativeScramble('secret', Buffer.alloc(20, 0xAB));
    expect(out.length).toBe(20);
});

test('nativeScramble: deterministic for the same (password, challenge)', () => {
    const ch = Buffer.from([
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
        0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10,
        0x11, 0x12, 0x13, 0x14,
    ]);
    const a = nativeScramble('hunter2', ch);
    const b = nativeScramble('hunter2', ch);
    expect(a.equals(b)).toBe(true);
    // Different password → different output.
    const c = nativeScramble('hunter3', ch);
    expect(a.equals(c)).toBe(false);
});

test('sha256Scramble: 32-byte token, deterministic', () => {
    const ch = Buffer.alloc(20, 0x42);
    const a = sha256Scramble('secret', ch);
    expect(a.length).toBe(32);
    const b = sha256Scramble('secret', ch);
    expect(a.equals(b)).toBe(true);
});

test('caching_sha2 plugin: initial empty-password response is 0 bytes', () => {
    const ctx = freshCtx({ password: '' });
    const out = CACHING_SHA2_PASSWORD.initialResponse(ctx);
    expect(out.length).toBe(0);
});

test('caching_sha2 plugin: fast-auth-success marker drives to ok', () => {
    const ctx = freshCtx({ password: 'pw' });
    CACHING_SHA2_PASSWORD.initialResponse(ctx);
    const step = CACHING_SHA2_PASSWORD.onAuthMoreData!(ctx, Buffer.from([0x03]));
    expect(step.kind).toBe('ok');
});

test('caching_sha2 plugin: full-auth without TLS requires allowPublicKeyRetrieval', () => {
    const ctx = freshCtx({ password: 'pw', tlsActive: false, allowPublicKeyRetrieval: false });
    CACHING_SHA2_PASSWORD.initialResponse(ctx);
    const step = CACHING_SHA2_PASSWORD.onAuthMoreData!(ctx, Buffer.from([0x04]));
    expect(step.kind).toBe('fail');
});

test('caching_sha2 plugin: full-auth under TLS sends cleartext+NUL', () => {
    const ctx = freshCtx({ password: 'hunter2', tlsActive: true });
    CACHING_SHA2_PASSWORD.initialResponse(ctx);
    const step = CACHING_SHA2_PASSWORD.onAuthMoreData!(ctx, Buffer.from([0x04]));
    expect(step.kind).toBe('write');
    if (step.kind === 'write') {
        expect(step.bytes.toString('utf8', 0, 7)).toBe('hunter2');
        expect(step.bytes.readUInt8(7)).toBe(0);
    }
});

test('caching_sha2 plugin: full-auth with allowPublicKeyRetrieval sends 0x02', () => {
    const ctx = freshCtx({ password: 'pw', tlsActive: false, allowPublicKeyRetrieval: true });
    CACHING_SHA2_PASSWORD.initialResponse(ctx);
    const step = CACHING_SHA2_PASSWORD.onAuthMoreData!(ctx, Buffer.from([0x04]));
    expect(step.kind).toBe('write');
    if (step.kind === 'write') {
        expect(step.bytes.length).toBe(1);
        expect(step.bytes.readUInt8(0)).toBe(0x02);
    }
});

test('mysql_clear_password: refuses without TLS', () => {
    const ctx = freshCtx({ password: 'pw', tlsActive: false });
    expect(() => MYSQL_CLEAR_PASSWORD.initialResponse(ctx)).toThrow();
});

test('mysql_clear_password: sends password + NUL under TLS', () => {
    const ctx = freshCtx({ password: 'pw', tlsActive: true });
    const out = MYSQL_CLEAR_PASSWORD.initialResponse(ctx);
    expect(out.length).toBe(3);
    expect(out.toString('utf8', 0, 2)).toBe('pw');
    expect(out.readUInt8(2)).toBe(0);
});

test('xorScramblePassword: repeats challenge when password longer', () => {
    const out = xorScramblePassword('abcdef', Buffer.from([0x00, 0xFF, 0x00]));
    expect(out.length).toBe(7); // pw (6) + NUL
    // byte 0: 'a' (0x61) XOR 0x00 = 0x61
    expect(out.readUInt8(0)).toBe(0x61);
    // byte 1: 'b' (0x62) XOR 0xFF
    expect(out.readUInt8(1)).toBe(0x62 ^ 0xFF);
    // byte 3: 'd' (0x64) XOR 0x00 (wraps)
    expect(out.readUInt8(3)).toBe(0x64);
});
