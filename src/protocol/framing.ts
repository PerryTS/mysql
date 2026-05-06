// Packet framing for the MySQL client / server protocol.
//
// A packet on the wire is:
//
//   [length: u24 LE][seq_id: u8][payload: bytes...]
//
// where `length` is the payload length (NOT including the 4-byte header),
// up to 0xFFFFFF = 16 777 215 bytes (16 MB - 1).
//
// Payloads of exactly 16 MB or larger must be split across multiple packets.
// The rule: if `length` is exactly 0xFFFFFF, the next packet is a
// continuation that carries the next chunk of the same logical payload.
// A payload whose total length is an exact multiple of 0xFFFFFF MUST be
// terminated by a zero-length continuation packet so the reader knows the
// message ended rather than was truncated.
//
// Sequence ids reset to 0 at the start of each new command (client or
// server initiates), then increment per packet. They wrap at 255 → 0; a
// long cursor paging past 256 packets *will* hit that boundary and the
// implementation must `(seq + 1) & 0xFF` without complaint.

import { MAX_PACKET_PAYLOAD } from './messages';

/** A parsed packet, ready for the command/decoder layer. */
export interface PacketView {
    /** The 1-byte sequence id this packet (or the first chunk) carried. */
    seq: number;
    /** Concatenated payload across any >16MB continuation chain. */
    payload: Buffer;
    /** Total bytes consumed from the source buffer — advance by this much. */
    consumed: number;
}

/**
 * Try to parse a single logical packet from `buf` starting at `offset`,
 * coalescing any >16MB continuation chain.
 *
 * Returns null iff the buffer doesn't yet contain a complete logical
 * packet. In that case `offset` should stay put and the caller should
 * wait for more bytes.
 */
export function parsePacket(buf: Buffer, offset: number): PacketView | null {
    const firstLen = peekPacketLength(buf, offset);
    if (firstLen === null) {
        return null;
    }

    // Fast path: single-packet payload (length < 0xFFFFFF). The common
    // case — every OK packet, every HandshakeV10, every tiny query
    // response. No allocations, just a subarray view.
    if (firstLen < MAX_PACKET_PAYLOAD) {
        const total = 4 + firstLen;
        if (buf.length - offset < total) {
            return null;
        }
        const seq = buf.readUInt8(offset + 3);
        const payload = buf.subarray(offset + 4, offset + total);
        return { seq: seq, payload: payload, consumed: total };
    }

    // Slow path: walk the continuation chain. A chain ends when we see a
    // chunk with length strictly less than 0xFFFFFF (including the
    // zero-length terminator that follows an exact-16MB boundary).
    let cursor = offset;
    let firstSeq = -1;
    const chunks: Buffer[] = [];
    for (;;) {
        const chunkLen = peekPacketLength(buf, cursor);
        if (chunkLen === null) {
            return null;
        }
        const total = 4 + chunkLen;
        if (buf.length - cursor < total) {
            return null;
        }
        const seq = buf.readUInt8(cursor + 3);
        if (firstSeq < 0) {
            firstSeq = seq;
        }
        if (chunkLen > 0) {
            chunks.push(buf.subarray(cursor + 4, cursor + total));
        }
        cursor += total;
        if (chunkLen < MAX_PACKET_PAYLOAD) {
            break;
        }
    }
    const joined = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    return {
        seq: firstSeq,
        payload: joined,
        consumed: cursor - offset,
    };
}

/**
 * Read the 3-byte LE payload length at `offset`, or return null if fewer
 * than 4 header bytes are available. Doesn't advance anything.
 */
function peekPacketLength(buf: Buffer, offset: number): number | null {
    if (buf.length - offset < 4) {
        return null;
    }
    const b0 = buf.readUInt8(offset);
    const b1 = buf.readUInt8(offset + 1);
    const b2 = buf.readUInt8(offset + 2);
    return (b2 << 16) | (b1 << 8) | b0;
}

/**
 * Build a wire packet from `payload` with the given starting sequence id.
 * Splits into continuation chunks when payload is ≥ 16 MB, as required
 * by the protocol. Emits the trailing zero-length terminator when the
 * payload length is an exact multiple of 0xFFFFFF.
 *
 * Returns the full on-wire byte stream and the next sequence id the
 * caller should use for subsequent packets in the same command.
 *
 * The implementation does *not* accept a payload larger than what the
 * server will realistically accept without a matching `max_allowed_packet`.
 * That server-side cap is per-deployment and we don't try to guess it;
 * callers get a working >16 MB write and the server will reject it if
 * its cap is lower. Keeping the splitter protocol-pure is cheap and avoids
 * a knowledge gap between client and server.
 */
export function writePacket(seq: number, payload: Buffer): { bytes: Buffer; nextSeq: number } {
    const len = payload.length;

    if (len < MAX_PACKET_PAYLOAD) {
        const out = Buffer.alloc(4 + len);
        writeHeader(out, 0, len, seq & 0xFF);
        if (len > 0) {
            payload.copy(out, 4);
        }
        return { bytes: out, nextSeq: (seq + 1) & 0xFF };
    }

    // Split into 0xFFFFFF-byte chunks. Emit a 0-byte terminator if
    // `len % 0xFFFFFF === 0` so the peer knows the payload ended rather
    // than was truncated.
    const fullChunks = Math.floor(len / MAX_PACKET_PAYLOAD);
    const tail = len - fullChunks * MAX_PACKET_PAYLOAD;
    const chunkCount = tail === 0 ? fullChunks + 1 : fullChunks + 1;
    // When tail === 0 we still need one terminator chunk of length 0;
    // that's what `fullChunks + 1` gives us. When tail > 0 that last
    // chunk holds `tail` bytes.
    const totalBytes = 4 * chunkCount + len;
    const out = Buffer.alloc(totalBytes);

    let srcOff = 0;
    let dstOff = 0;
    let curSeq = seq & 0xFF;
    for (let i = 0; i < fullChunks; i++) {
        writeHeader(out, dstOff, MAX_PACKET_PAYLOAD, curSeq);
        payload.copy(out, dstOff + 4, srcOff, srcOff + MAX_PACKET_PAYLOAD);
        srcOff += MAX_PACKET_PAYLOAD;
        dstOff += 4 + MAX_PACKET_PAYLOAD;
        curSeq = (curSeq + 1) & 0xFF;
    }
    writeHeader(out, dstOff, tail, curSeq);
    if (tail > 0) {
        payload.copy(out, dstOff + 4, srcOff, srcOff + tail);
    }
    curSeq = (curSeq + 1) & 0xFF;
    return { bytes: out, nextSeq: curSeq };
}

/** Write a 4-byte packet header (u24 length LE + u8 seq). */
function writeHeader(out: Buffer, offset: number, length: number, seq: number): void {
    out.writeUInt8(length & 0xFF, offset);
    out.writeUInt8((length >>> 8) & 0xFF, offset + 1);
    out.writeUInt8((length >>> 16) & 0xFF, offset + 2);
    out.writeUInt8(seq, offset + 3);
}
