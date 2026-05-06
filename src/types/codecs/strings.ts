// String / blob / JSON codecs.
//
// The unifying invariant: every string-shaped type in MySQL arrives as a
// lenenc-prefixed byte payload in both text and binary protocols. The
// driver's row walker has already consumed the lenenc prefix before it
// hands us the Buffer, so all we do here is:
//
//   - For text-collation columns → `buf.toString('utf8')`.
//   - For binary-collation columns (collation=63, BINARY_FLAG, BLOB_FLAG) → Buffer verbatim.
//   - For JSON → parse (and stringify on encode).

import type { MyCodec, EncodedParam } from '../registry';
import { ColumnDefinition41 } from '../../protocol/decoder';
import {
    MYSQL_TYPE_VAR_STRING,
    MYSQL_TYPE_STRING,
    MYSQL_TYPE_VARCHAR,
    MYSQL_TYPE_BLOB,
    MYSQL_TYPE_TINY_BLOB,
    MYSQL_TYPE_MEDIUM_BLOB,
    MYSQL_TYPE_LONG_BLOB,
    MYSQL_TYPE_ENUM,
    MYSQL_TYPE_SET,
    MYSQL_TYPE_JSON,
    MYSQL_TYPE_GEOMETRY,
    isBinaryCollation,
} from '../type-codes';

/** A cell's wire bytes decoded to `string` (text) or `Buffer` (binary). */
function decodeStringOrBuffer(buf: Buffer, field: ColumnDefinition41): string | Buffer {
    if (isBinaryCollation(field.flags, field.collation)) {
        return Buffer.from(buf);
    }
    return buf.toString('utf8');
}

function encodeStringParam(typeCode: number, v: string | Buffer): EncodedParam {
    const payload = typeof v === 'string' ? Buffer.from(v, 'utf8') : v;
    const out = Buffer.alloc(lenencIntSize(payload.length) + payload.length);
    const off = writeLenencInt(payload.length, out, 0);
    payload.copy(out, off);
    return { typeCode: typeCode, unsigned: false, bytes: out };
}

function mkStringCodec(typeCode: number, name: string): MyCodec<string | Buffer> {
    return {
        typeCode: typeCode,
        name: name,
        text: {
            decode: decodeStringOrBuffer,
            encode: (v) => typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v),
        },
        binary: {
            decode: decodeStringOrBuffer,
            encode: (v) => encodeStringParam(typeCode, v),
        },
    };
}

export const VAR_STRING_CODEC = mkStringCodec(MYSQL_TYPE_VAR_STRING, 'varchar');
export const STRING_CODEC     = mkStringCodec(MYSQL_TYPE_STRING, 'char');
export const VARCHAR_CODEC    = mkStringCodec(MYSQL_TYPE_VARCHAR, 'varchar-pre-5.0');
export const BLOB_CODEC       = mkStringCodec(MYSQL_TYPE_BLOB, 'blob');
export const TINY_BLOB_CODEC  = mkStringCodec(MYSQL_TYPE_TINY_BLOB, 'tinyblob');
export const MEDIUM_BLOB_CODEC = mkStringCodec(MYSQL_TYPE_MEDIUM_BLOB, 'mediumblob');
export const LONG_BLOB_CODEC  = mkStringCodec(MYSQL_TYPE_LONG_BLOB, 'longblob');
export const ENUM_CODEC       = mkStringCodec(MYSQL_TYPE_ENUM, 'enum');
export const SET_CODEC        = mkStringCodec(MYSQL_TYPE_SET, 'set');
export const GEOMETRY_CODEC   = mkStringCodec(MYSQL_TYPE_GEOMETRY, 'geometry');

// ─── JSON ────────────────────────────────────────────────────────────────────

/**
 * JSON columns arrive as UTF-8 JSON text in both text and binary protocols.
 * We parse eagerly. On encode, we stringify unless the caller passed raw
 * UTF-8 already.
 */
export const JSON_CODEC: MyCodec<unknown> = {
    typeCode: MYSQL_TYPE_JSON,
    name: 'json',
    text: {
        decode: (buf) => JSON.parse(buf.toString('utf8')),
        encode: (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v), 'utf8'),
    },
    binary: {
        decode: (buf) => JSON.parse(buf.toString('utf8')),
        encode: (v): EncodedParam => {
            const s = typeof v === 'string' ? v : JSON.stringify(v);
            const payload = Buffer.from(s, 'utf8');
            const out = Buffer.alloc(lenencIntSize(payload.length) + payload.length);
            const off = writeLenencInt(payload.length, out, 0);
            payload.copy(out, off);
            return { typeCode: MYSQL_TYPE_JSON, unsigned: false, bytes: out };
        },
    },
};

// Local lenenc helpers (see scalars.ts for rationale — avoid module-load cycle).
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
