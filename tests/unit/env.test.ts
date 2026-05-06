import { test, expect, beforeEach, afterEach } from 'bun:test';
import { resolveConnectOptions } from '../../src/env';

const saved: Record<string, string | undefined> = {};
const keys = ['MYSQL_HOST', 'MYSQL_TCP_PORT', 'MYSQL_USER', 'MYSQL_PWD', 'MYSQL_DATABASE', 'MYSQL_SSL_MODE'];

beforeEach(() => {
    for (let i = 0; i < keys.length; i++) {
        saved[keys[i]] = process.env[keys[i]];
        delete process.env[keys[i]];
    }
});

afterEach(() => {
    for (let i = 0; i < keys.length; i++) {
        if (saved[keys[i]] === undefined) {
            delete process.env[keys[i]];
        } else {
            process.env[keys[i]] = saved[keys[i]];
        }
    }
});

test('defaults when nothing is provided', () => {
    const o = resolveConnectOptions({});
    expect(o.host).toBe('localhost');
    expect(o.port).toBe(3306);
    expect(o.user).toBe('root');
    expect(o.database).toBe('');
});

test('MYSQL_* env vars populate missing fields', () => {
    process.env.MYSQL_HOST = 'dbhost';
    process.env.MYSQL_TCP_PORT = '3307';
    process.env.MYSQL_USER = 'alice';
    process.env.MYSQL_PWD = 'secret';
    process.env.MYSQL_DATABASE = 'appdb';
    process.env.MYSQL_SSL_MODE = 'VERIFY_IDENTITY';
    const o = resolveConnectOptions({});
    expect(o.host).toBe('dbhost');
    expect(o.port).toBe(3307);
    expect(o.user).toBe('alice');
    expect(o.password).toBe('secret');
    expect(o.database).toBe('appdb');
    expect(o.ssl).toEqual({ mode: 'verify-full' });
});

test('explicit fields win over env', () => {
    process.env.MYSQL_HOST = 'envhost';
    const o = resolveConnectOptions({ host: 'explicit' });
    expect(o.host).toBe('explicit');
});

test('URL seeds base options, explicit overrides', () => {
    const o = resolveConnectOptions({
        url: 'mysql://alice:pw@dsnhost:3307/dsndb?ssl-mode=REQUIRED',
        password: 'override',
    });
    expect(o.host).toBe('dsnhost');
    expect(o.user).toBe('alice');
    expect(o.password).toBe('override');
    expect(o.database).toBe('dsndb');
    expect(o.ssl).toEqual({ mode: 'require' });
});

test('string input is treated as url', () => {
    const o = resolveConnectOptions('mysql://root@localhost/db');
    expect(o.host).toBe('localhost');
    expect(o.database).toBe('db');
});
