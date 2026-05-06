import { test, expect } from 'bun:test';
import { sql, raw, isSqlQuery } from '../../src/sql';

test('sql`` produces ? placeholders in document order', () => {
    const id = 42;
    const name = 'alice';
    const q = sql`SELECT * FROM users WHERE id = ${id} AND name = ${name}`;
    expect(q.text).toBe('SELECT * FROM users WHERE id = ? AND name = ?');
    expect(q.params).toEqual([42, 'alice']);
    expect(isSqlQuery(q)).toBe(true);
});

test('sql`` with no interpolations', () => {
    const q = sql`SELECT 1`;
    expect(q.text).toBe('SELECT 1');
    expect(q.params.length).toBe(0);
});

test('nested SqlQuery inlined verbatim', () => {
    const filter = sql`active = ${true}`;
    const q = sql`SELECT * FROM users WHERE ${filter} AND id = ${7}`;
    expect(q.text).toBe('SELECT * FROM users WHERE active = ? AND id = ?');
    expect(q.params).toEqual([true, 7]);
});

test('raw() inserts text without parameterisation', () => {
    const col = 'created_at';
    const q = sql`SELECT * FROM users ORDER BY ${raw(col)} DESC`;
    expect(q.text).toBe('SELECT * FROM users ORDER BY created_at DESC');
    expect(q.params.length).toBe(0);
});

test('isSqlQuery: tag for objects only', () => {
    expect(isSqlQuery('string')).toBe(false);
    expect(isSqlQuery({ text: 'x', params: [] })).toBe(false);
    expect(isSqlQuery(null)).toBe(false);
    expect(isSqlQuery(sql``)).toBe(true);
});
