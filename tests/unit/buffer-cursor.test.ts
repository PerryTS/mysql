import { test, expect } from 'bun:test';
import { BufferCursor } from '../../src/util/buffer-cursor';

test('little-endian integer reads', () => {
    const buf = Buffer.alloc(15);
    buf.writeUInt8(0x12, 0);
    buf.writeUInt16LE(0x3456, 1);
    buf.writeUInt8(0x78, 3);
    buf.writeUInt8(0x9A, 4);
    buf.writeUInt8(0xBC, 5);
    buf.writeUInt32LE(0xDEADBEEF, 6);
    buf.writeUInt8(0xFF, 10);
    buf.writeUInt8(0xEE, 11);
    buf.writeUInt8(0xDD, 12);
    buf.writeUInt8(0xCC, 13);
    buf.writeUInt8(0xBB, 14);
    const cur = new BufferCursor(buf);
    expect(cur.readUInt8()).toBe(0x12);
    expect(cur.readUInt16LE()).toBe(0x3456);
    expect(cur.readUInt24LE()).toBe(0xBC9A78);
    expect(cur.readUInt32LE()).toBe(0xDEADBEEF);
});

test('null-terminated and fixed strings', () => {
    const buf = Buffer.from([
        // "abc\0"
        0x61, 0x62, 0x63, 0x00,
        // "de"
        0x64, 0x65,
    ]);
    const cur = new BufferCursor(buf);
    expect(cur.readNullTerminatedString()).toBe('abc');
    expect(cur.pos).toBe(4);
    expect(cur.readFixedString(2)).toBe('de');
});

test('readNullTerminatedString throws without terminator', () => {
    const buf = Buffer.from([0x61, 0x62]);
    expect(() => new BufferCursor(buf).readNullTerminatedString()).toThrow();
});

test('readBytes returns a subarray view', () => {
    const buf = Buffer.from([1, 2, 3, 4, 5]);
    const cur = new BufferCursor(buf);
    const slice = cur.readBytes(3);
    expect(slice.length).toBe(3);
    expect(slice[0]).toBe(1);
    // Mutating the underlying source should reflect in the slice — confirms subarray, not copy.
    buf.writeUInt8(99, 0);
    expect(slice[0]).toBe(99);
});

test('bigint 64-bit LE reads', () => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt('18446744073709551615'), 0);
    const cur = new BufferCursor(buf);
    expect(cur.readBigUInt64LE()).toBe(BigInt('18446744073709551615'));
});

test('skip and remaining', () => {
    const buf = Buffer.from([1, 2, 3, 4, 5, 6]);
    const cur = new BufferCursor(buf);
    cur.skip(2);
    expect(cur.pos).toBe(2);
    expect(cur.remaining()).toBe(4);
    expect(cur.readUInt8()).toBe(3);
    expect(cur.peekUInt8()).toBe(4);
    expect(cur.pos).toBe(3);
    expect(cur.done()).toBe(false);
});
