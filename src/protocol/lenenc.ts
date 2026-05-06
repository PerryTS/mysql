// Length-encoded integers and strings — MySQL's variable-width int encoding.
//
// A lenenc int can be 1, 3, 4, or 9 bytes on the wire:
//
//   first byte         meaning
//   ──────────────     ─────────────────────────────────────────────────────
//   0x00 … 0xFA        the integer itself (0..250)
//   0xFB               SPECIAL — within a text-resultset row this signals
//                      a NULL column value. Callers that might encounter
//                      it in row data must branch before invoking this
//                      module. In other contexts, MySQL never emits 0xFB
//                      as a lenenc-int prefix, so we treat it as an error.
//   0xFC               2-byte u16 LE follows
//   0xFD               3-byte u24 LE follows
//   0xFE               8-byte u64 LE follows
//                      NOTE: overlaps with the EOF-packet / AuthSwitchRequest
//                      / LOCAL_INFILE marker, but in contexts where a lenenc
//                      int is expected, 0xFE is unambiguous because the
//                      packet tag disambiguation happens at a different
//                      layer (see decoder.ts for packet-tag classification).
//   0xFF               SPECIAL — marks an ERR packet header, but also a
//                      legal lenenc-int in *some* protocol fields (mostly
//                      MariaDB bulk-op responses). The spec treats it as
//                      reserved-for-future-use within lenenc contexts; we
//                      refuse it loudly here so the caller can decide how
//                      to interpret the byte.
//
// A lenenc string is a lenenc int `n` followed by `n` bytes of payload.
//
// We return numbers for ≤ 6-byte values (0..2^48) and bigints for the
// full u64 range. That matches the v8 fast-int boundary and keeps the
// common-case numeric type `number`.

import { BufferCursor } from '../util/buffer-cursor';

/** Tag bytes that have special meaning in a lenenc-int context. */
export const LENENC_NULL      = 0xFB;
export const LENENC_U16_TAG   = 0xFC;
export const LENENC_U24_TAG   = 0xFD;
export const LENENC_U64_TAG   = 0xFE;
export const LENENC_RESERVED  = 0xFF;

/**
 * Decode the next lenenc int from `cur`.
 *
 * Returns a `number` when the encoded value fits safely in a JS double
 * (< 2^53), otherwise a `bigint`. Callers that want a single type can
 * coerce at the top (`BigInt(n)` is cheap).
 *
 * Throws on 0xFB (NULL sentinel — caller should have checked the byte
 * before calling) and 0xFF (reserved / ERR).
 */
export function readLenencInt(cur: BufferCursor): number | bigint {
    const first = cur.readUInt8();
    if (first < LENENC_NULL) {
        return first;
    }
    if (first === LENENC_NULL) {
        throw new Error('readLenencInt: unexpected 0xFB NULL sentinel');
    }
    if (first === LENENC_U16_TAG) {
        return cur.readUInt16LE();
    }
    if (first === LENENC_U24_TAG) {
        return cur.readUInt24LE();
    }
    if (first === LENENC_U64_TAG) {
        const bi = cur.readBigUInt64LE();
        if (bi <= 9007199254740991n) {
            // 2^53 - 1: representable exactly as a JS `number`.
            return Number(bi);
        }
        return bi;
    }
    // first === 0xFF
    throw new Error('readLenencInt: reserved 0xFF prefix');
}

/**
 * Like `readLenencInt`, but allows the 0xFB NULL sentinel. Returns null
 * in that case. Used by the text-resultset row decoder.
 */
export function readLenencIntOrNull(cur: BufferCursor): number | bigint | null {
    const first = cur.peekUInt8();
    if (first === LENENC_NULL) {
        cur.skip(1);
        return null;
    }
    return readLenencInt(cur);
}

/**
 * Encoded byte length of a lenenc int.
 * Mirrors `writeLenencInt` — if you change one, change both.
 */
export function lenencIntSize(n: number | bigint): number {
    if (typeof n === 'bigint') {
        if (n < 0n) {
            throw new Error('lenencIntSize: negative value');
        }
        if (n < 251n) {
            return 1;
        }
        if (n < 65536n) {
            return 3;
        }
        if (n < 16777216n) {
            return 4;
        }
        return 9;
    }
    if (n < 0) {
        throw new Error('lenencIntSize: negative value');
    }
    if (n < 251) {
        return 1;
    }
    if (n < 65536) {
        return 3;
    }
    if (n < 16777216) {
        return 4;
    }
    return 9;
}

/**
 * Write `n` as a lenenc int into `out` at `offset`. Returns the offset
 * just past the written bytes.
 */
export function writeLenencInt(n: number | bigint, out: Buffer, offset: number): number {
    if (typeof n === 'bigint') {
        if (n < 0n) {
            throw new Error('writeLenencInt: negative value');
        }
        if (n < 251n) {
            out.writeUInt8(Number(n), offset);
            return offset + 1;
        }
        if (n < 65536n) {
            out.writeUInt8(LENENC_U16_TAG, offset);
            out.writeUInt16LE(Number(n), offset + 1);
            return offset + 3;
        }
        if (n < 16777216n) {
            out.writeUInt8(LENENC_U24_TAG, offset);
            const small = Number(n);
            out.writeUInt8(small & 0xFF, offset + 1);
            out.writeUInt8((small >>> 8) & 0xFF, offset + 2);
            out.writeUInt8((small >>> 16) & 0xFF, offset + 3);
            return offset + 4;
        }
        out.writeUInt8(LENENC_U64_TAG, offset);
        out.writeBigUInt64LE(n, offset + 1);
        return offset + 9;
    }
    if (n < 0) {
        throw new Error('writeLenencInt: negative value');
    }
    if (n < 251) {
        out.writeUInt8(n, offset);
        return offset + 1;
    }
    if (n < 65536) {
        out.writeUInt8(LENENC_U16_TAG, offset);
        out.writeUInt16LE(n, offset + 1);
        return offset + 3;
    }
    if (n < 16777216) {
        out.writeUInt8(LENENC_U24_TAG, offset);
        out.writeUInt8(n & 0xFF, offset + 1);
        out.writeUInt8((n >>> 8) & 0xFF, offset + 2);
        out.writeUInt8((n >>> 16) & 0xFF, offset + 3);
        return offset + 4;
    }
    // Need 8-byte encoding but the value is a plain JS number.
    // `writeBigUInt64LE` accepts a bigint only; we go via BigInt.
    out.writeUInt8(LENENC_U64_TAG, offset);
    out.writeBigUInt64LE(BigInt(n), offset + 1);
    return offset + 9;
}

/**
 * Decode a lenenc string. Returns a subarray view into `cur.buf`.
 * See `BufferCursor.readBytes` for lifetime notes.
 */
export function readLenencString(cur: BufferCursor): Buffer {
    const n = readLenencInt(cur);
    const len = typeof n === 'bigint' ? Number(n) : n;
    return cur.readBytes(len);
}

/**
 * As `readLenencString` but decoded as UTF-8. Convenience for fields like
 * column names where the server always sends UTF-8.
 */
export function readLenencUtf8(cur: BufferCursor): string {
    const buf = readLenencString(cur);
    return buf.toString('utf8');
}

/**
 * Like `readLenencString`, but returns null for the 0xFB sentinel. Used by
 * the text-resultset row decoder where NULL is a legal value.
 */
export function readLenencStringOrNull(cur: BufferCursor): Buffer | null {
    const n = readLenencIntOrNull(cur);
    if (n === null) {
        return null;
    }
    const len = typeof n === 'bigint' ? Number(n) : n;
    return cur.readBytes(len);
}

/**
 * Encoded byte length of a lenenc string (lenenc-int prefix + payload).
 */
export function lenencStringSize(payloadLen: number): number {
    return lenencIntSize(payloadLen) + payloadLen;
}

/**
 * Write a lenenc string (lenenc-int length + raw bytes).
 * Accepts `string` (encoded as UTF-8) or `Buffer` (written as-is).
 */
export function writeLenencString(value: string | Buffer, out: Buffer, offset: number): number {
    if (typeof value === 'string') {
        const bytes = Buffer.from(value, 'utf8');
        const next = writeLenencInt(bytes.length, out, offset);
        bytes.copy(out, next);
        return next + bytes.length;
    }
    const next = writeLenencInt(value.length, out, offset);
    value.copy(out, next);
    return next + value.length;
}
