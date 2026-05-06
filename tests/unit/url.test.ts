import { test, expect } from 'bun:test';
import { parseConnectionString } from '../../src/url';

test('host-only URL with defaults', () => {
    const p = parseConnectionString('mysql://localhost');
    expect(p.host).toBe('localhost');
    expect(p.port).toBe(3306);
    expect(p.user).toBe('root');
    expect(p.database).toBe('');
});

test('full URL with userinfo + database', () => {
    const p = parseConnectionString('mysql://alice:secret@db.example.com:4407/appdb');
    expect(p.host).toBe('db.example.com');
    expect(p.port).toBe(4407);
    expect(p.user).toBe('alice');
    expect(p.password).toBe('secret');
    expect(p.database).toBe('appdb');
});

test('percent-encoded credentials', () => {
    const p = parseConnectionString('mysql://user%40host:p%40ss@localhost/db');
    expect(p.user).toBe('user@host');
    expect(p.password).toBe('p@ss');
});

test('IPv6 bracketed host', () => {
    const p = parseConnectionString('mysql://root@[::1]:3306/db');
    expect(p.host).toBe('::1');
    expect(p.port).toBe(3306);
});

test('mariadb:// scheme accepted', () => {
    const p = parseConnectionString('mariadb://root@localhost/app');
    expect(p.host).toBe('localhost');
    expect(p.database).toBe('app');
});

test('ssl-mode + charset + allowPublicKeyRetrieval query params', () => {
    const p = parseConnectionString(
        'mysql://root:pw@localhost/db?ssl-mode=VERIFY_IDENTITY&charset=45&allowPublicKeyRetrieval=true'
    );
    expect(p.sslMode).toBe('verify-full');
    expect(p.charset).toBe(45);
    expect(p.allowPublicKeyRetrieval).toBe(true);
});

test('ssl-mode synonyms', () => {
    expect(parseConnectionString('mysql://h?ssl-mode=REQUIRED').sslMode).toBe('require');
    expect(parseConnectionString('mysql://h?ssl-mode=DISABLED').sslMode).toBe('disable');
    expect(parseConnectionString('mysql://h?ssl-mode=VERIFY_CA').sslMode).toBe('verify-ca');
});

test('missing scheme throws', () => {
    expect(() => parseConnectionString('root@localhost/db')).toThrow();
});

test('unknown ssl-mode throws', () => {
    expect(() => parseConnectionString('mysql://h?ssl-mode=PARANOID')).toThrow();
});
