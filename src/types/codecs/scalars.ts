// Scalar codecs: integer + float + boolean + bit + decimal.
//
// MySQL maps booleans onto TINYINT(1). We decode TINY columns as `number`
// by default; a caller that wants `boolean` semantics can branch on the
// column's width at the application layer. Pg does the same.

import type { MyCodec, EncodedParam } from '../registry';
import {
    MYSQL_TYPE_TINY,
    MYSQL_TYPE_SHORT,
    MYSQL_TYPE_LONG,
    MYSQL_TYPE_LONGLONG,
    MYSQL_TYPE_INT24,
    MYSQL_TYPE_FLOAT,
    MYSQL_TYPE_DOUBLE,
    MYSQL_TYPE_NULL,
    MYSQL_TYPE_NEWDECIMAL,
    MYSQL_TYPE_DECIMAL,
    MYSQL_TYPE_BIT,
    MYSQL_TYPE_YEAR,
    UNSIGNED_FLAG,
} from '../type-codes';
import { Decimal, decodeDecimalString, encodeDecimalString } from '../decimal';

function isUnsigned(flags: number): boolean {
    return (flags & UNSIGNED_FLAG) !== 0;
}

// ─── TINY (1 byte) ───────────────────────────────────────────────────────────

export const TINY_CODEC: MyCodec<number> = {
    typeCode: MYSQL_TYPE_TINY,
    name: 'tinyint',
    text: {
        decode: (buf) => Number(buf.toString('utf8')),
        encode: (v) => Buffer.from(String(v), 'utf8'),
    },
    binary: {
        decode: (buf, field) => isUnsigned(field.flags) ? buf.readUInt8(0) : buf.readInt8(0),
        encode: (v): EncodedParam => {
            const out = Buffer.alloc(1);
            if (v >= 0) { out.writeUInt8(v, 0); }
            else { out.writeInt8(v, 0); }
            return { typeCode: MYSQL_TYPE_TINY, unsigned: v >= 0, bytes: out };
        },
    },
};

// ─── SHORT (2 bytes) ─────────────────────────────────────────────────────────

export const SHORT_CODEC: MyCodec<number> = {
    typeCode: MYSQL_TYPE_SHORT,
    name: 'smallint',
    text: {
        decode: (buf) => Number(buf.toString('utf8')),
        encode: (v) => Buffer.from(String(v), 'utf8'),
    },
    binary: {
        decode: (buf, field) => isUnsigned(field.flags) ? buf.readUInt16LE(0) : buf.readInt16LE(0),
        encode: (v): EncodedParam => {
            const out = Buffer.alloc(2);
            if (v >= 0) { out.writeUInt16LE(v, 0); }
            else { out.writeInt16LE(v, 0); }
            return { typeCode: MYSQL_TYPE_SHORT, unsigned: v >= 0, bytes: out };
        },
    },
};

// ─── LONG / INT24 (4 bytes on the wire) ─────────────────────────────────────

export const LONG_CODEC: MyCodec<number> = {
    typeCode: MYSQL_TYPE_LONG,
    name: 'int',
    text: {
        decode: (buf) => Number(buf.toString('utf8')),
        encode: (v) => Buffer.from(String(v), 'utf8'),
    },
    binary: {
        decode: (buf, field) => isUnsigned(field.flags) ? buf.readUInt32LE(0) : buf.readInt32LE(0),
        encode: (v): EncodedParam => {
            const out = Buffer.alloc(4);
            if (v >= 0) { out.writeUInt32LE(v, 0); }
            else { out.writeInt32LE(v, 0); }
            return { typeCode: MYSQL_TYPE_LONG, unsigned: v >= 0, bytes: out };
        },
    },
};

export const INT24_CODEC: MyCodec<number> = {
    typeCode: MYSQL_TYPE_INT24,
    name: 'mediumint',
    text: LONG_CODEC.text,
    binary: {
        decode: LONG_CODEC.binary!.decode,
        encode: (v): EncodedParam => {
            const inner = LONG_CODEC.binary!.encode(v);
            return { typeCode: MYSQL_TYPE_INT24, unsigned: inner.unsigned, bytes: inner.bytes };
        },
    },
};

// ─── LONGLONG (8 bytes → bigint) ─────────────────────────────────────────────

/** BigInt | number: bigint unless the value fits in Number without loss. */
type LongLongValue = bigint | number;

export const LONGLONG_CODEC: MyCodec<LongLongValue> = {
    typeCode: MYSQL_TYPE_LONGLONG,
    name: 'bigint',
    text: {
        decode: (buf, field): LongLongValue => {
            const s = buf.toString('utf8');
            if (isUnsigned(field.flags)) {
                const n = Number(s);
                if (Number.isFinite(n) && n <= Number.MAX_SAFE_INTEGER) { return n; }
                return BigInt(s);
            }
            const n = Number(s);
            if (Number.isFinite(n) && n <= Number.MAX_SAFE_INTEGER && n >= Number.MIN_SAFE_INTEGER) { return n; }
            return BigInt(s);
        },
        encode: (v) => Buffer.from(typeof v === 'bigint' ? v.toString() : String(v), 'utf8'),
    },
    binary: {
        // Decode the in-range value with pure number-word arithmetic and
        // number-literal comparisons — never via `Number(bigint)`. Perry's
        // AOT miscompiles the bigint→number coercion (PerryTS/perry#1), so a
        // value as small as `1` would surface as a `bigint` and break
        // JSON.stringify. The two-word combine is exact for any |value| ≤
        // 2^53, so the safe-integer branch matches Node byte-for-byte.
        decode: (buf, field): LongLongValue => {
            const lo = buf.readUInt32LE(0);
            if (isUnsigned(field.flags)) {
                const hi = buf.readUInt32LE(4);
                const asNum = hi * 4294967296 + lo;
                if (asNum <= 9007199254740991) { return asNum; }
                return buf.readBigUInt64LE(0);
            }
            const hi = buf.readInt32LE(4);
            const asNum = hi * 4294967296 + lo;
            if (asNum <= 9007199254740991 && asNum >= -9007199254740991) { return asNum; }
            return buf.readBigInt64LE(0);
        },
        encode: (v): EncodedParam => {
            const out = Buffer.alloc(8);
            if (typeof v === 'bigint') {
                if (v >= 0n) { out.writeBigUInt64LE(v, 0); }
                else { out.writeBigInt64LE(v, 0); }
                return { typeCode: MYSQL_TYPE_LONGLONG, unsigned: v >= 0n, bytes: out };
            }
            if (v >= 0) { out.writeBigUInt64LE(BigInt(v), 0); }
            else { out.writeBigInt64LE(BigInt(v), 0); }
            return { typeCode: MYSQL_TYPE_LONGLONG, unsigned: v >= 0, bytes: out };
        },
    },
};

// ─── FLOAT / DOUBLE ─────────────────────────────────────────────────────────

export const FLOAT_CODEC: MyCodec<number> = {
    typeCode: MYSQL_TYPE_FLOAT,
    name: 'float',
    text: {
        decode: (buf) => Number(buf.toString('utf8')),
        encode: (v) => Buffer.from(String(v), 'utf8'),
    },
    binary: {
        decode: (buf) => buf.readFloatLE(0),
        encode: (v): EncodedParam => {
            const out = Buffer.alloc(4);
            out.writeFloatLE(v, 0);
            return { typeCode: MYSQL_TYPE_FLOAT, unsigned: false, bytes: out };
        },
    },
};

export const DOUBLE_CODEC: MyCodec<number> = {
    typeCode: MYSQL_TYPE_DOUBLE,
    name: 'double',
    text: {
        decode: (buf) => Number(buf.toString('utf8')),
        encode: (v) => Buffer.from(String(v), 'utf8'),
    },
    binary: {
        decode: (buf) => buf.readDoubleLE(0),
        encode: (v): EncodedParam => {
            const out = Buffer.alloc(8);
            out.writeDoubleLE(v, 0);
            return { typeCode: MYSQL_TYPE_DOUBLE, unsigned: false, bytes: out };
        },
    },
};

// ─── NULL ────────────────────────────────────────────────────────────────────

export const NULL_CODEC: MyCodec<null> = {
    typeCode: MYSQL_TYPE_NULL,
    name: 'null',
    text: {
        decode: () => null,
        encode: () => Buffer.alloc(0),
    },
    binary: {
        decode: () => null,
        encode: () => ({ typeCode: MYSQL_TYPE_NULL, unsigned: false, bytes: Buffer.alloc(0) }),
    },
};

// ─── DECIMAL / NEWDECIMAL ───────────────────────────────────────────────────

export const NEWDECIMAL_CODEC: MyCodec<Decimal> = {
    typeCode: MYSQL_TYPE_NEWDECIMAL,
    name: 'decimal',
    text: {
        decode: (buf) => decodeDecimalString(buf),
        encode: (v) => encodeDecimalString(v),
    },
    binary: {
        // MySQL emits DECIMAL as a lenenc string in the binary protocol too —
        // the driver has already consumed the lenenc prefix via the generic
        // binary-row walker, so `buf` here is the raw ASCII digit payload.
        decode: (buf) => decodeDecimalString(buf),
        encode: (v): EncodedParam => {
            const s = encodeDecimalString(v);
            const out = Buffer.alloc(lenencIntSize(s.length) + s.length);
            const n = writeLenencInt(s.length, out, 0);
            s.copy(out, n);
            return { typeCode: MYSQL_TYPE_NEWDECIMAL, unsigned: false, bytes: out };
        },
    },
};

/** Legacy DECIMAL (0x00) — same string semantics as NEWDECIMAL. */
export const DECIMAL_LEGACY_CODEC: MyCodec<Decimal> = {
    typeCode: MYSQL_TYPE_DECIMAL,
    name: 'decimal-legacy',
    text: NEWDECIMAL_CODEC.text,
    binary: NEWDECIMAL_CODEC.binary,
};

// ─── YEAR (2 bytes) ─────────────────────────────────────────────────────────

export const YEAR_CODEC: MyCodec<number> = {
    typeCode: MYSQL_TYPE_YEAR,
    name: 'year',
    text: {
        decode: (buf) => Number(buf.toString('utf8')),
        encode: (v) => Buffer.from(String(v), 'utf8'),
    },
    binary: {
        decode: (buf) => buf.readUInt16LE(0),
        encode: (v): EncodedParam => {
            const out = Buffer.alloc(2);
            out.writeUInt16LE(v, 0);
            return { typeCode: MYSQL_TYPE_YEAR, unsigned: true, bytes: out };
        },
    },
};

// ─── BIT (1..64 bits) ───────────────────────────────────────────────────────

/**
 * BIT(n) arrives as a lenenc-prefixed byte string, big-endian. We return
 * a Buffer verbatim so callers can access the raw bits. For BIT(≤32)
 * callers often want a number — they can do `buf.readUIntBE(0, buf.length)`.
 */
export const BIT_CODEC: MyCodec<Buffer> = {
    typeCode: MYSQL_TYPE_BIT,
    name: 'bit',
    text: {
        decode: (buf) => Buffer.from(buf),
        encode: (v) => Buffer.from(v),
    },
    binary: {
        decode: (buf) => Buffer.from(buf),
        encode: (v): EncodedParam => ({
            typeCode: MYSQL_TYPE_BIT,
            unsigned: false,
            bytes: v,
        }),
    },
};

// Local copies to avoid a circular import with lenenc.ts during module-load.
// These are identical to the primitives in `../../protocol/lenenc`; we
// duplicate the 10 lines here rather than introduce a cycle at init.
function lenencIntSize(n: number): number {
    if (n < 251) return 1;
    if (n < 65536) return 3;
    if (n < 16777216) return 4;
    return 9;
}
function writeLenencInt(n: number, out: Buffer, offset: number): number {
    if (n < 251) { out.writeUInt8(n, offset); return offset + 1; }
    if (n < 65536) { out.writeUInt8(0xFC, offset); out.writeUInt16LE(n, offset + 1); return offset + 3; }
    if (n < 16777216) {
        out.writeUInt8(0xFD, offset);
        out.writeUInt8(n & 0xFF, offset + 1);
        out.writeUInt8((n >>> 8) & 0xFF, offset + 2);
        out.writeUInt8((n >>> 16) & 0xFF, offset + 3);
        return offset + 4;
    }
    out.writeUInt8(0xFE, offset);
    out.writeBigUInt64LE(BigInt(n), offset + 1);
    return offset + 9;
}
