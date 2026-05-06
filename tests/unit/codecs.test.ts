import { test, expect } from 'bun:test';
import {
    decodeValue,
    encodeValue,
    getCodec,
    listRegisteredTypes,
} from '../../src/types/registry';
import {
    MYSQL_TYPE_TINY,
    MYSQL_TYPE_SHORT,
    MYSQL_TYPE_LONG,
    MYSQL_TYPE_LONGLONG,
    MYSQL_TYPE_FLOAT,
    MYSQL_TYPE_DOUBLE,
    MYSQL_TYPE_NEWDECIMAL,
    MYSQL_TYPE_DATE,
    MYSQL_TYPE_DATETIME,
    MYSQL_TYPE_TIME,
    MYSQL_TYPE_YEAR,
    MYSQL_TYPE_VAR_STRING,
    MYSQL_TYPE_BLOB,
    MYSQL_TYPE_JSON,
    MYSQL_TYPE_NULL,
    MYSQL_TYPE_BIT,
    FORMAT_TEXT,
    FORMAT_BINARY,
    UNSIGNED_FLAG,
    BINARY_FLAG,
} from '../../src/types/type-codes';
import type { ColumnDefinition41 } from '../../src/protocol/decoder';
import { Decimal } from '../../src/types/decimal';
import { registerDefaultPlugins } from '../../src/register-defaults';
import {
    decodeDateBinary, decodeDateText,
    decodeDateTimeBinary, decodeDateTimeText,
    decodeTimeBinary, decodeTimeText,
} from '../../src/types/datetime';

// Bootstrap the registry once.
registerDefaultPlugins();

function field(typeCode: number, flags: number = 0, collation: number = 255): ColumnDefinition41 {
    return {
        catalog: 'def', schema: '', table: '', orgTable: '',
        name: 'c', orgName: 'c',
        collation: collation, columnLength: 0,
        typeCode: typeCode, flags: flags, decimals: 0,
    };
}

// ─── Registry smoke ─────────────────────────────────────────────────────────

test('registry has all 20+ core codecs registered', () => {
    const codes = listRegisteredTypes();
    expect(codes.length).toBeGreaterThanOrEqual(20);
    expect(codes.indexOf(MYSQL_TYPE_TINY)).toBeGreaterThanOrEqual(0);
    expect(codes.indexOf(MYSQL_TYPE_NEWDECIMAL)).toBeGreaterThanOrEqual(0);
    expect(codes.indexOf(MYSQL_TYPE_JSON)).toBeGreaterThanOrEqual(0);
    expect(codes.indexOf(MYSQL_TYPE_DATETIME)).toBeGreaterThanOrEqual(0);
});

test('unknown type code falls back to raw string/buffer, never throws', () => {
    const got1 = decodeValue(field(0xAA), FORMAT_TEXT, Buffer.from('hi'));
    expect(got1).toBe('hi');
    const got2 = decodeValue(field(0xAA), FORMAT_BINARY, Buffer.from([1, 2, 3]));
    expect(Buffer.isBuffer(got2)).toBe(true);
});

// ─── Integer codecs (TINY/SHORT/LONG/LONGLONG/INT24/YEAR) ────────────────────

test('TINY: signed text round-trip', () => {
    expect(decodeValue(field(MYSQL_TYPE_TINY), FORMAT_TEXT, Buffer.from('-42'))).toBe(-42);
});

test('TINY: unsigned binary', () => {
    const buf = Buffer.from([0xFF]);
    expect(decodeValue(field(MYSQL_TYPE_TINY, UNSIGNED_FLAG), FORMAT_BINARY, buf)).toBe(255);
    expect(decodeValue(field(MYSQL_TYPE_TINY), FORMAT_BINARY, buf)).toBe(-1);
});

test('SHORT binary: signed vs unsigned disambiguates on flag', () => {
    const buf = Buffer.from([0xFF, 0xFF]);
    expect(decodeValue(field(MYSQL_TYPE_SHORT), FORMAT_BINARY, buf)).toBe(-1);
    expect(decodeValue(field(MYSQL_TYPE_SHORT, UNSIGNED_FLAG), FORMAT_BINARY, buf)).toBe(65535);
});

test('LONG binary: negative value', () => {
    const buf = Buffer.alloc(4);
    buf.writeInt32LE(-2_000_000_000, 0);
    expect(decodeValue(field(MYSQL_TYPE_LONG), FORMAT_BINARY, buf)).toBe(-2_000_000_000);
});

test('LONGLONG text: returns bigint when exceeding safe integer', () => {
    const result = decodeValue(field(MYSQL_TYPE_LONGLONG), FORMAT_TEXT, Buffer.from('9999999999999999999'));
    expect(typeof result).toBe('bigint');
    expect(result).toBe(9999999999999999999n);
});

test('LONGLONG text: stays as number when it fits', () => {
    expect(decodeValue(field(MYSQL_TYPE_LONGLONG), FORMAT_TEXT, Buffer.from('42'))).toBe(42);
});

test('LONGLONG binary: MIN/MAX signed int64 → bigint', () => {
    const minBuf = Buffer.alloc(8);
    minBuf.writeBigInt64LE(-9223372036854775808n, 0);
    const maxBuf = Buffer.alloc(8);
    maxBuf.writeBigInt64LE(9223372036854775807n, 0);
    expect(decodeValue(field(MYSQL_TYPE_LONGLONG), FORMAT_BINARY, minBuf)).toBe(-9223372036854775808n);
    expect(decodeValue(field(MYSQL_TYPE_LONGLONG), FORMAT_BINARY, maxBuf)).toBe(9223372036854775807n);
});

test('YEAR binary: 2 bytes LE → number', () => {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(2025, 0);
    expect(decodeValue(field(MYSQL_TYPE_YEAR), FORMAT_BINARY, buf)).toBe(2025);
});

// ─── Float codecs ───────────────────────────────────────────────────────────

test('FLOAT binary: IEEE754 round-trip', () => {
    const buf = Buffer.alloc(4);
    buf.writeFloatLE(3.14, 0);
    const got = decodeValue(field(MYSQL_TYPE_FLOAT), FORMAT_BINARY, buf) as number;
    expect(Math.abs(got - 3.14)).toBeLessThan(1e-6);
});

test('DOUBLE text: decodes scientific notation', () => {
    expect(decodeValue(field(MYSQL_TYPE_DOUBLE), FORMAT_TEXT, Buffer.from('1.5e3'))).toBe(1500);
    expect(decodeValue(field(MYSQL_TYPE_DOUBLE), FORMAT_TEXT, Buffer.from('-0.25'))).toBe(-0.25);
});

// ─── DECIMAL ────────────────────────────────────────────────────────────────

test('NEWDECIMAL decodes as Decimal wrapper preserving precision', () => {
    const got = decodeValue(field(MYSQL_TYPE_NEWDECIMAL), FORMAT_TEXT, Buffer.from('99999999999999.99'));
    expect(got instanceof Decimal).toBe(true);
    expect((got as Decimal).toString()).toBe('99999999999999.99');
});

test('NEWDECIMAL binary: decoded the same as text (lenenc-string payload)', () => {
    const got = decodeValue(field(MYSQL_TYPE_NEWDECIMAL), FORMAT_BINARY, Buffer.from('-0.000001'));
    expect((got as Decimal).toString()).toBe('-0.000001');
});

// ─── Temporal codecs ────────────────────────────────────────────────────────

test('DATE text round-trip', () => {
    const d = decodeDateText(Buffer.from('2026-04-17'));
    expect(d.year).toBe(2026);
    expect(d.month).toBe(4);
    expect(d.day).toBe(17);
    expect(d.toString()).toBe('2026-04-17');
});

test('DATE binary: length 0 means zero-date', () => {
    const d = decodeDateBinary(Buffer.from([0]));
    expect(d.isZero()).toBe(true);
    expect(d.toString()).toBe('0000-00-00');
});

test('DATE binary: 4-byte packed struct', () => {
    const buf = Buffer.alloc(5);
    buf.writeUInt8(4, 0);
    buf.writeUInt16LE(2025, 1);
    buf.writeUInt8(12, 3);
    buf.writeUInt8(25, 4);
    const d = decodeDateBinary(buf);
    expect(d.year).toBe(2025);
    expect(d.month).toBe(12);
    expect(d.day).toBe(25);
});

test('DATETIME binary: 11-byte with microseconds', () => {
    const buf = Buffer.alloc(12);
    buf.writeUInt8(11, 0);
    buf.writeUInt16LE(2025, 1);
    buf.writeUInt8(3, 3);
    buf.writeUInt8(14, 4);
    buf.writeUInt8(10, 5);
    buf.writeUInt8(30, 6);
    buf.writeUInt8(45, 7);
    buf.writeUInt32LE(123456, 8);
    const dt = decodeDateTimeBinary(buf);
    expect(dt.year).toBe(2025);
    expect(dt.hour).toBe(10);
    expect(dt.microsecond).toBe(123456);
    expect(dt.toString()).toBe('2025-03-14 10:30:45.123456');
});

test('DATETIME text fractional seconds truncate-pad to 6', () => {
    const dt = decodeDateTimeText(Buffer.from('2025-01-02 03:04:05.1'));
    expect(dt.microsecond).toBe(100000);
});

test('DATETIME: zero-date round-trip both directions', () => {
    const dt1 = decodeDateTimeBinary(Buffer.from([0]));
    expect(dt1.isZero()).toBe(true);
    const dt2 = decodeDateTimeText(Buffer.from('0000-00-00 00:00:00'));
    expect(dt2.isZero()).toBe(true);
});

test('TIME binary: negative, with days', () => {
    const buf = Buffer.alloc(13);
    buf.writeUInt8(12, 0);
    buf.writeUInt8(1, 1);           // negative
    buf.writeUInt32LE(2, 2);        // 2 days
    buf.writeUInt8(3, 6);           // 3 hours
    buf.writeUInt8(4, 7);           // 4 minutes
    buf.writeUInt8(5, 8);           // 5 seconds
    buf.writeUInt32LE(678000, 9);   // 0.678000 fractional
    const t = decodeTimeBinary(buf);
    expect(t.isNegative).toBe(true);
    expect(t.days).toBe(2);
    expect(t.hours).toBe(3);
    expect(t.microseconds).toBe(678000);
    // "-(2*24+3)=-51 hours"
    expect(t.toString()).toBe('-51:04:05.678000');
});

test('TIME text: negative 838-hour edge', () => {
    const t = decodeTimeText(Buffer.from('-838:59:59'));
    expect(t.isNegative).toBe(true);
    expect(t.days).toBe(34); // 34*24 = 816; 838-816=22 hours
    expect(t.hours).toBe(22);
});

// ─── String codecs ──────────────────────────────────────────────────────────

test('VAR_STRING with text collation decodes to string', () => {
    const got = decodeValue(field(MYSQL_TYPE_VAR_STRING, 0, 255), FORMAT_BINARY, Buffer.from('héllo', 'utf8'));
    expect(got).toBe('héllo');
});

test('VAR_STRING with BINARY_FLAG → Buffer', () => {
    const got = decodeValue(field(MYSQL_TYPE_VAR_STRING, BINARY_FLAG, 63), FORMAT_BINARY, Buffer.from([1, 2, 3]));
    expect(Buffer.isBuffer(got)).toBe(true);
    expect((got as Buffer).length).toBe(3);
});

test('BLOB with binary collation → Buffer', () => {
    const got = decodeValue(field(MYSQL_TYPE_BLOB, 0, 63), FORMAT_BINARY, Buffer.from([0xFF, 0x00, 0x7F]));
    expect(Buffer.isBuffer(got)).toBe(true);
});

// ─── JSON ───────────────────────────────────────────────────────────────────

test('JSON decodes parsed value', () => {
    const got = decodeValue(field(MYSQL_TYPE_JSON), FORMAT_BINARY, Buffer.from('{"k":1,"s":"hi"}'));
    expect(got).toEqual({ k: 1, s: 'hi' });
});

test('JSON decodes arrays + nested objects', () => {
    const got = decodeValue(field(MYSQL_TYPE_JSON), FORMAT_TEXT, Buffer.from('[1,[2,{"a":null}]]'));
    expect(got).toEqual([1, [2, { a: null }]]);
});

// ─── NULL / BIT ─────────────────────────────────────────────────────────────

test('NULL codec returns null both formats', () => {
    expect(decodeValue(field(MYSQL_TYPE_NULL), FORMAT_TEXT, Buffer.alloc(0))).toBeNull();
    expect(decodeValue(field(MYSQL_TYPE_NULL), FORMAT_BINARY, Buffer.alloc(0))).toBeNull();
});

test('BIT codec returns Buffer verbatim', () => {
    const got = decodeValue(field(MYSQL_TYPE_BIT), FORMAT_BINARY, Buffer.from([0x80]));
    expect(Buffer.isBuffer(got)).toBe(true);
    expect((got as Buffer).readUInt8(0)).toBe(0x80);
});

// ─── encodeValue sanity ─────────────────────────────────────────────────────

test('encodeValue for LONG returns 4-byte little-endian', () => {
    const enc = encodeValue(MYSQL_TYPE_LONG, 42);
    expect(enc.typeCode).toBe(MYSQL_TYPE_LONG);
    expect(enc.unsigned).toBe(true);
    expect(enc.bytes.length).toBe(4);
    expect(enc.bytes.readUInt32LE(0)).toBe(42);
});

test('encodeValue for LONGLONG with bigint > MAX_SAFE_INTEGER', () => {
    const v = 9_000_000_000_000_000_000n;
    const enc = encodeValue(MYSQL_TYPE_LONGLONG, v);
    expect(enc.bytes.readBigUInt64LE(0)).toBe(v);
});

test('encodeValue for DATETIME picks 11-byte form when micros present', () => {
    const enc = encodeValue(MYSQL_TYPE_DATETIME, {
        year: 2024, month: 6, day: 1,
        hour: 1, minute: 2, second: 3, microsecond: 456,
        raw: '', isZero: () => false,
        toString: () => '',
        toDate: () => new Date(0),
    });
    expect(enc.bytes.length).toBe(12);
    expect(enc.bytes.readUInt8(0)).toBe(11);
});

test('encodeValue unknown codec throws', () => {
    expect(() => encodeValue(0xAA, 1)).toThrow();
});

// ─── Codec existence smoke ──────────────────────────────────────────────────

test('all 16 primary codecs register', () => {
    const codes = [
        MYSQL_TYPE_TINY, MYSQL_TYPE_SHORT, MYSQL_TYPE_LONG, MYSQL_TYPE_LONGLONG,
        MYSQL_TYPE_FLOAT, MYSQL_TYPE_DOUBLE,
        MYSQL_TYPE_NEWDECIMAL, MYSQL_TYPE_NULL, MYSQL_TYPE_YEAR, MYSQL_TYPE_BIT,
        MYSQL_TYPE_VAR_STRING, MYSQL_TYPE_BLOB, MYSQL_TYPE_JSON,
        MYSQL_TYPE_DATE, MYSQL_TYPE_DATETIME, MYSQL_TYPE_TIME,
    ];
    for (let i = 0; i < codes.length; i++) {
        expect(getCodec(codes[i])).toBeDefined();
    }
});
