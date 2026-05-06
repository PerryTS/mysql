import { test, expect } from 'bun:test';
import {
    readLenencInt,
    readLenencIntOrNull,
    writeLenencInt,
    lenencIntSize,
    readLenencString,
    readLenencStringOrNull,
    writeLenencString,
    LENENC_NULL,
    LENENC_U16_TAG,
    LENENC_U24_TAG,
    LENENC_U64_TAG,
    LENENC_RESERVED,
} from '../../src/protocol/lenenc';
import { BufferCursor } from '../../src/util/buffer-cursor';

function roundTripInt(n: number | bigint): number | bigint {
    const size = lenencIntSize(n);
    const buf = Buffer.alloc(size);
    const after = writeLenencInt(n, buf, 0);
    expect(after).toBe(size);
    return readLenencInt(new BufferCursor(buf));
}

test('lenenc int: 1-byte values (0..250)', () => {
    expect(lenencIntSize(0)).toBe(1);
    expect(lenencIntSize(250)).toBe(1);
    expect(roundTripInt(0)).toBe(0);
    expect(roundTripInt(1)).toBe(1);
    expect(roundTripInt(250)).toBe(250);
});

test('lenenc int: 3-byte values (251..65535)', () => {
    expect(lenencIntSize(251)).toBe(3);
    expect(lenencIntSize(65535)).toBe(3);
    expect(roundTripInt(251)).toBe(251);
    expect(roundTripInt(1000)).toBe(1000);
    expect(roundTripInt(65535)).toBe(65535);
});

test('lenenc int: 4-byte values (65536..16777215)', () => {
    expect(lenencIntSize(65536)).toBe(4);
    expect(lenencIntSize(16777215)).toBe(4);
    expect(roundTripInt(65536)).toBe(65536);
    expect(roundTripInt(16777215)).toBe(16777215);
});

test('lenenc int: 9-byte values (u64)', () => {
    expect(lenencIntSize(16777216)).toBe(9);
    expect(lenencIntSize(BigInt('18446744073709551615'))).toBe(9); // u64 max
    // Within safe-integer range: returns number.
    expect(roundTripInt(16777216)).toBe(16777216);
    // At boundary (2^53 - 1): still returns number.
    expect(roundTripInt(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    // Above safe range: returns bigint.
    const big = BigInt('18000000000000000000');
    const round = roundTripInt(big);
    expect(typeof round).toBe('bigint');
    expect(round).toBe(big);
});

test('lenenc int: 0xFB NULL sentinel throws when read as int', () => {
    const buf = Buffer.from([LENENC_NULL]);
    expect(() => readLenencInt(new BufferCursor(buf))).toThrow();
});

test('lenenc int: 0xFB read as nullable yields null', () => {
    const buf = Buffer.from([LENENC_NULL]);
    const cur = new BufferCursor(buf);
    expect(readLenencIntOrNull(cur)).toBeNull();
    expect(cur.pos).toBe(1);
});

test('lenenc int: 0xFF reserved byte throws', () => {
    const buf = Buffer.from([LENENC_RESERVED]);
    expect(() => readLenencInt(new BufferCursor(buf))).toThrow();
});

test('lenenc int: exact tag bytes used for each width', () => {
    const t3 = Buffer.alloc(3);
    writeLenencInt(300, t3, 0);
    expect(t3.readUInt8(0)).toBe(LENENC_U16_TAG);
    expect(t3.readUInt16LE(1)).toBe(300);

    const t4 = Buffer.alloc(4);
    writeLenencInt(70_000, t4, 0);
    expect(t4.readUInt8(0)).toBe(LENENC_U24_TAG);

    const t9 = Buffer.alloc(9);
    writeLenencInt(BigInt('10000000000'), t9, 0);
    expect(t9.readUInt8(0)).toBe(LENENC_U64_TAG);
});

test('lenenc string: round-trip short UTF-8 value', () => {
    const buf = Buffer.alloc(32);
    const after = writeLenencString('hello', buf, 0);
    expect(after).toBe(6);
    const cur = new BufferCursor(buf);
    const got = readLenencString(cur);
    expect(got.toString('utf8')).toBe('hello');
    expect(cur.pos).toBe(6);
});

test('lenenc string: NULL sentinel read as nullable', () => {
    const buf = Buffer.from([LENENC_NULL]);
    expect(readLenencStringOrNull(new BufferCursor(buf))).toBeNull();
});

test('lenenc string: empty string (0-length)', () => {
    const buf = Buffer.alloc(1);
    writeLenencString('', buf, 0);
    expect(buf.readUInt8(0)).toBe(0);
    expect(readLenencString(new BufferCursor(buf)).length).toBe(0);
});

test('lenenc string: Buffer payload is written verbatim', () => {
    const src = Buffer.from([0x00, 0xFF, 0x10, 0x20]);
    const out = Buffer.alloc(1 + 4);
    writeLenencString(src, out, 0);
    expect(out.readUInt8(0)).toBe(4);
    const cur = new BufferCursor(out);
    const got = readLenencString(cur);
    expect(got.equals(src)).toBe(true);
});
