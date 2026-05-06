import { test, expect } from 'bun:test';
import { parsePacket, writePacket } from '../../src/protocol/framing';
import { MessageReader } from '../../src/protocol/reader';
import { MAX_PACKET_PAYLOAD } from '../../src/protocol/messages';

test('round-trips a small payload', () => {
    const payload = Buffer.from([0x03, 0x53, 0x45, 0x4C, 0x45, 0x43, 0x54]); // "\x03SELECT"
    const { bytes, nextSeq } = writePacket(0, payload);
    expect(bytes.length).toBe(4 + payload.length);
    expect(nextSeq).toBe(1);
    const parsed = parsePacket(bytes, 0);
    expect(parsed).not.toBeNull();
    expect(parsed!.seq).toBe(0);
    expect(parsed!.consumed).toBe(bytes.length);
    expect(parsed!.payload.equals(payload)).toBe(true);
});

test('empty payload is legal (COM_QUIT-style)', () => {
    const { bytes, nextSeq } = writePacket(0, Buffer.alloc(0));
    expect(bytes.length).toBe(4);
    expect(nextSeq).toBe(1);
    const parsed = parsePacket(bytes, 0);
    expect(parsed!.payload.length).toBe(0);
});

test('sequence id wraps 255 -> 0', () => {
    const { nextSeq } = writePacket(255, Buffer.from([0x42]));
    expect(nextSeq).toBe(0);
});

test('parsePacket returns null when bytes are incomplete', () => {
    const payload = Buffer.from([1, 2, 3, 4, 5]);
    const { bytes } = writePacket(0, payload);
    // Feed only the header + one byte of payload.
    expect(parsePacket(bytes.subarray(0, 4), 0)).toBeNull();
    expect(parsePacket(bytes.subarray(0, 5), 0)).toBeNull();
    expect(parsePacket(bytes, 0)).not.toBeNull();
});

test('MessageReader framing across chunk boundaries, byte by byte', () => {
    const payloadA = Buffer.from('hello', 'utf8');
    const payloadB = Buffer.from('world!', 'utf8');
    const a = writePacket(0, payloadA).bytes;
    const b = writePacket(1, payloadB).bytes;
    const combined = Buffer.concat([a, b]);
    const reader = new MessageReader();

    // Feed one byte at a time; reader should only yield complete packets.
    const collected: Buffer[] = [];
    for (let i = 0; i < combined.length; i++) {
        const out = reader.feed(combined.subarray(i, i + 1));
        for (let j = 0; j < out.length; j++) {
            collected.push(Buffer.from(out[j].payload));
        }
    }
    expect(collected.length).toBe(2);
    expect(collected[0].equals(payloadA)).toBe(true);
    expect(collected[1].equals(payloadB)).toBe(true);
    expect(reader.hasPending()).toBe(false);
});

test('exact-16MB payload produces a 0xFFFFFF chunk + 0-byte terminator', () => {
    const payload = Buffer.alloc(MAX_PACKET_PAYLOAD, 0x5A);
    const { bytes, nextSeq } = writePacket(0, payload);
    // Expect 4 + 0xFFFFFF (first chunk) + 4 (terminator) bytes total.
    expect(bytes.length).toBe(4 + MAX_PACKET_PAYLOAD + 4);
    // First header reports 0xFFFFFF.
    expect(bytes.readUInt8(0) | (bytes.readUInt8(1) << 8) | (bytes.readUInt8(2) << 16)).toBe(MAX_PACKET_PAYLOAD);
    // Second header reports 0.
    expect(bytes.readUInt8(4 + MAX_PACKET_PAYLOAD) | (bytes.readUInt8(4 + MAX_PACKET_PAYLOAD + 1) << 8) | (bytes.readUInt8(4 + MAX_PACKET_PAYLOAD + 2) << 16)).toBe(0);
    // Two packets consumed → seq advanced twice.
    expect(nextSeq).toBe(2);
    const parsed = parsePacket(bytes, 0);
    expect(parsed).not.toBeNull();
    expect(parsed!.consumed).toBe(bytes.length);
    expect(parsed!.payload.length).toBe(MAX_PACKET_PAYLOAD);
    expect(parsed!.payload[0]).toBe(0x5A);
    expect(parsed!.payload[MAX_PACKET_PAYLOAD - 1]).toBe(0x5A);
});

test('16 MB + 1 byte payload splits into full chunk + 1-byte tail chunk', () => {
    const size = MAX_PACKET_PAYLOAD + 1;
    const payload = Buffer.alloc(size);
    payload.writeUInt8(0x11, 0);
    payload.writeUInt8(0x22, size - 1);
    const { bytes, nextSeq } = writePacket(0, payload);
    expect(bytes.length).toBe(4 + MAX_PACKET_PAYLOAD + 4 + 1);
    expect(nextSeq).toBe(2);
    const parsed = parsePacket(bytes, 0);
    expect(parsed).not.toBeNull();
    expect(parsed!.payload.length).toBe(size);
    expect(parsed!.payload.readUInt8(0)).toBe(0x11);
    expect(parsed!.payload.readUInt8(size - 1)).toBe(0x22);
});

test('invalid length of 0xFFFFFF without continuation never completes', () => {
    // Hand-build a single chunk with length = 0xFFFFFF but no follow-up bytes.
    const partial = Buffer.alloc(4);
    partial.writeUInt8(0xFF, 0);
    partial.writeUInt8(0xFF, 1);
    partial.writeUInt8(0xFF, 2);
    partial.writeUInt8(0, 3);
    // We only supply the header. parsePacket should return null (incomplete).
    expect(parsePacket(partial, 0)).toBeNull();
});
