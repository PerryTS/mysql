// MYSQL_TYPE_* → codec registry.
//
// Parallel arrays of (type code, codec) are used rather than a Map so the
// registry is trivially serialisable across Perry module boundaries and
// linear lookup stays in the JIT-friendly fast path. With ~20 entries the
// O(n) lookup is faster than Map's hashing.
//
// MySQL's codec selection is subtler than Postgres's: the same type code
// can decode into different JS shapes depending on column flags (signed
// vs unsigned int, binary vs text string). We surface both the
// primary-key code *and* a disambiguator via the `ColumnDefinition41` to
// the decoder thunks.

import type { ColumnDefinition41 } from '../protocol/decoder';
import { FORMAT_TEXT, FORMAT_BINARY } from './type-codes';
import type { WireFormat } from './type-codes';

export interface EncodedParam {
    typeCode: number;
    unsigned: boolean;
    bytes: Buffer;
}

export interface TextCodec<T> {
    decode(buf: Buffer, field: ColumnDefinition41): T;
    encode(v: T): Buffer;
}

export interface BinaryCodec<T> {
    decode(buf: Buffer, field: ColumnDefinition41): T;
    encode(v: T): EncodedParam;
}

export interface MyCodec<T = unknown> {
    typeCode: number;
    name: string;
    text: TextCodec<T>;
    binary?: BinaryCodec<T>;
}

// ─── Registry storage ────────────────────────────────────────────────────────

const REGISTRY_CODES: number[] = [];
const REGISTRY_CODECS: MyCodec<unknown>[] = [];

export function registerType<T>(codec: MyCodec<T>): void {
    const idx = REGISTRY_CODES.indexOf(codec.typeCode);
    if (idx >= 0) {
        REGISTRY_CODECS[idx] = codec as MyCodec<unknown>;
        return;
    }
    REGISTRY_CODES.push(codec.typeCode);
    REGISTRY_CODECS.push(codec as MyCodec<unknown>);
}

export function getCodec(typeCode: number): MyCodec<unknown> | undefined {
    const idx = REGISTRY_CODES.indexOf(typeCode);
    if (idx < 0) {
        return undefined;
    }
    return REGISTRY_CODECS[idx];
}

export function hasBinaryCodec(typeCode: number): boolean {
    const c = getCodec(typeCode);
    return c !== undefined && c.binary !== undefined;
}

/**
 * Decode a single cell buffer using the codec registered for `typeCode`.
 * Falls back to UTF-8 string (text) or raw bytes (binary) when no codec
 * is registered — unknown types never panic, per the GUI contract.
 */
export function decodeValue(
    field: ColumnDefinition41,
    format: WireFormat,
    buf: Buffer,
): unknown {
    const codec = getCodec(field.typeCode);
    if (codec === undefined) {
        return format === FORMAT_TEXT ? buf.toString('utf8') : Buffer.from(buf);
    }
    if (format === FORMAT_BINARY && codec.binary !== undefined) {
        return codec.binary.decode(buf, field);
    }
    return codec.text.decode(buf, field);
}

/**
 * Encode a JS value as a parameter for COM_STMT_EXECUTE.
 * Must return `{ typeCode, unsigned, bytes }`; the bytes must already
 * include any lenenc length prefix required by the target typeCode.
 */
export function encodeValue(typeCode: number, value: unknown): EncodedParam {
    const codec = getCodec(typeCode);
    if (codec === undefined || codec.binary === undefined) {
        throw new Error('encodeValue: no binary codec for type 0x' + typeCode.toString(16));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return codec.binary.encode(value as any);
}

/**
 * Resolve a per-column decoder thunk once per resultset. The returned
 * function is called once per cell; using it avoids the registry lookup
 * and branch per-cell on hot paths.
 */
export function pickDecoder(
    field: ColumnDefinition41,
    format: WireFormat,
): (buf: Buffer) => unknown {
    const codec = getCodec(field.typeCode);
    if (codec === undefined) {
        if (format === FORMAT_TEXT) {
            return (buf) => buf.toString('utf8');
        }
        return (buf) => Buffer.from(buf);
    }
    if (format === FORMAT_BINARY && codec.binary !== undefined) {
        const bin = codec.binary;
        return (buf) => bin.decode(buf, field);
    }
    const text = codec.text;
    return (buf) => text.decode(buf, field);
}

/** For tests / debugging. */
export function listRegisteredTypes(): number[] {
    return REGISTRY_CODES.slice();
}
