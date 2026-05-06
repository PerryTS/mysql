// Server → client packet payload decoders.
//
// Each function takes a `payload: Buffer` (already extracted from the
// 4-byte packet header by `parsePacket`) and returns a structured decode
// result. Functions are pure — no state mutation, no socket I/O.
//
// Packet tag disambiguation (especially the 0xFE family) happens at the
// connection state-machine layer, not here. These decoders require the
// caller to pick the right one.

import { BufferCursor } from '../util/buffer-cursor';
import { readLenencInt, readLenencUtf8, readLenencString, readLenencStringOrNull } from './lenenc';
import {
    PACKET_OK,
    PACKET_ERR,
    PACKET_EOF,
    PACKET_AUTH_MORE_DATA,
    HANDSHAKE_PROTOCOL_V10,
} from './messages';
import {
    CLIENT_PLUGIN_AUTH,
    CLIENT_SECURE_CONNECTION,
    CLIENT_SESSION_TRACK,
    CLIENT_DEPRECATE_EOF,
} from './capabilities';
import { SERVER_SESSION_STATE_CHANGED } from './status';
import { decodeErrFields, MyErrorFields } from '../error';

// ─── HandshakeV10 — the first server → client packet on any connection ───────

export interface HandshakeV10 {
    protocolVersion: number; // always 10 for this code path
    serverVersion: string;   // e.g. "8.0.36" or "11.4.3-MariaDB-1:11.4.3+maria~ubu2404"
    connectionId: number;
    authPluginData: Buffer;  // concatenation of part 1 (8 bytes) + part 2 (variable)
    capabilities: number;    // 32-bit server-declared capability bitmap
    collation: number;       // 1-byte collation id
    statusFlags: number;     // 2-byte server status
    authPluginName: string;  // e.g. "mysql_native_password", "caching_sha2_password"
    isMariaDB: boolean;      // derived from serverVersion suffix
}

/**
 * Decode a HandshakeV10 packet payload. Throws if the protocol version
 * isn't 10 — v9 is legacy and we don't support it.
 */
export function decodeHandshakeV10(payload: Buffer): HandshakeV10 {
    const cur = new BufferCursor(payload);
    const protocolVersion = cur.readUInt8();
    if (protocolVersion !== HANDSHAKE_PROTOCOL_V10) {
        throw new Error('unsupported handshake protocol version: ' + protocolVersion);
    }
    const serverVersion = cur.readNullTerminatedString();
    const connectionId = cur.readUInt32LE();
    const authPluginDataPart1 = cur.readBytes(8);
    cur.skip(1); // filler: 0x00
    let capabilities = cur.readUInt16LE();
    let collation = 0;
    let statusFlags = 0;
    let authPluginDataPart2: Buffer = Buffer.alloc(0);
    let authPluginName = '';

    if (cur.remaining() > 0) {
        collation = cur.readUInt8();
        statusFlags = cur.readUInt16LE();
        const capsUpper = cur.readUInt16LE();
        capabilities = ((capsUpper << 16) | capabilities) >>> 0;

        let authPluginDataLen = 0;
        if ((capabilities & CLIENT_PLUGIN_AUTH) !== 0) {
            authPluginDataLen = cur.readUInt8();
        } else {
            cur.skip(1); // reserved filler (0x00)
        }
        cur.skip(10); // 10 reserved bytes (all 0)

        if ((capabilities & CLIENT_SECURE_CONNECTION) !== 0) {
            // Length of part 2: max(12, authPluginDataLen - 9) per MySQL docs,
            // but the null terminator is included in the count. We read
            // exactly that many bytes, then strip the trailing 0x00 if
            // present (some servers include it, some don't).
            const need = authPluginDataLen > 8 ? authPluginDataLen - 8 : 12;
            const minLen = need < 13 ? 13 : need;
            const raw = cur.readBytes(minLen);
            // Drop the null terminator at the end of part 2 if present.
            // Use `readUInt8` rather than bracket indexing — Perry AOT
            // codegen doesn't lower `buf[i]` on Buffer receivers.
            const trailingIsNul = raw.length > 0 && raw.readUInt8(raw.length - 1) === 0;
            authPluginDataPart2 = trailingIsNul
                ? Buffer.from(raw.subarray(0, raw.length - 1))
                : Buffer.from(raw);
        }

        if ((capabilities & CLIENT_PLUGIN_AUTH) !== 0) {
            authPluginName = cur.readNullTerminatedString();
        }
    }

    const authPluginData = Buffer.concat([authPluginDataPart1, authPluginDataPart2]);
    const isMariaDB = serverVersion.indexOf('MariaDB') !== -1;
    return {
        protocolVersion: protocolVersion,
        serverVersion: serverVersion,
        connectionId: connectionId,
        authPluginData: authPluginData,
        capabilities: capabilities,
        collation: collation,
        statusFlags: statusFlags,
        authPluginName: authPluginName,
        isMariaDB: isMariaDB,
    };
}

// ─── OK / ERR / EOF packets ──────────────────────────────────────────────────

export interface OkPacket {
    affectedRows: number | bigint;
    lastInsertId: number | bigint;
    statusFlags: number;
    warningCount: number;
    info: string;
    /** Only populated when CLIENT_SESSION_TRACK is active AND the status bit is set. */
    sessionStateInfo: Buffer | null;
}

/**
 * Decode an OK packet. `caps` is the effective capability set (client AND
 * server) — needed because CLIENT_SESSION_TRACK changes the trailing layout.
 *
 * Caller is responsible for confirming the first byte is 0x00 (or 0xFE
 * when CLIENT_DEPRECATE_EOF is active and the payload is short — both
 * map to OkPacket semantics).
 */
export function decodeOkPacket(payload: Buffer, caps: number): OkPacket {
    const cur = new BufferCursor(payload);
    cur.skip(1); // header byte (already classified)
    const affectedRows = readLenencInt(cur);
    const lastInsertId = readLenencInt(cur);
    let statusFlags = 0;
    let warningCount = 0;
    if (cur.remaining() >= 4) {
        statusFlags = cur.readUInt16LE();
        warningCount = cur.readUInt16LE();
    }
    let info = '';
    let sessionStateInfo: Buffer | null = null;
    if ((caps & CLIENT_SESSION_TRACK) !== 0 && cur.remaining() > 0) {
        // `info` is lenenc-string here.
        const infoBuf = readLenencString(cur);
        info = infoBuf.toString('utf8');
        if ((statusFlags & SERVER_SESSION_STATE_CHANGED) !== 0 && cur.remaining() > 0) {
            // `session_state_info` is lenenc-string.
            sessionStateInfo = Buffer.from(readLenencString(cur));
        }
    } else if (cur.remaining() > 0) {
        // Legacy: `info` is rest-of-packet string, unprefixed.
        info = cur.readRestString();
    }
    return {
        affectedRows: affectedRows,
        lastInsertId: lastInsertId,
        statusFlags: statusFlags,
        warningCount: warningCount,
        info: info,
        sessionStateInfo: sessionStateInfo,
    };
}

export interface ErrPacket extends MyErrorFields {
    /** Same object re-exported for API symmetry. */
}

/** Decode an ERR packet payload into structured fields. */
export function decodeErrPacket(payload: Buffer): ErrPacket {
    return decodeErrFields(payload);
}

export interface EofPacket {
    warningCount: number;
    statusFlags: number;
}

/**
 * Decode a pre-CLIENT_DEPRECATE_EOF EOF packet (0xFE marker, ≤9-byte payload).
 * Layout: [0xFE][warnings: u16 LE][status: u16 LE].
 */
export function decodeEofPacket(payload: Buffer): EofPacket {
    if (payload.length < 5) {
        throw new Error('decodeEofPacket: short payload, ' + payload.length + ' bytes');
    }
    return {
        warningCount: payload.readUInt16LE(1),
        statusFlags: payload.readUInt16LE(3),
    };
}

/**
 * Classify a packet whose first byte is 0xFE. Three meanings, disambiguated
 * by the connection state and payload length.
 *
 *   - During the auth phase → AuthSwitchRequest (any length, lenenc-ish structure).
 *   - During resultset phase with payload length ≤ 254 (old style) or 0xFE+OK-fields
 *     (new style with CLIENT_DEPRECATE_EOF) → EOF / OK.
 *   - During resultset phase with payload starting 0xFB (or the packet being
 *     an announcement of LOCAL INFILE) → LOCAL_INFILE request.
 *
 * We expose a helper here rather than inline the logic because it's the
 * single most-bugged corner of the MySQL protocol.
 */
export type FePacketKind =
    | 'eof'
    | 'ok-via-deprecate-eof'
    | 'auth-switch-request'
    | 'local-infile'
    | 'unknown';

export function classifyFePacket(
    state: 'auth' | 'resultset-rows' | 'resultset-columns' | 'ready',
    payload: Buffer,
    caps: number,
): FePacketKind {
    if (payload.length === 0) {
        return 'unknown';
    }
    const first = payload.readUInt8(0);
    if (first !== PACKET_EOF) {
        return 'unknown';
    }
    if (state === 'auth') {
        return 'auth-switch-request';
    }
    if ((caps & CLIENT_DEPRECATE_EOF) !== 0) {
        // In deprecate-EOF mode, 0xFE with a short payload is an OK; longer
        // payloads (>= 8 bytes and with meaningful lenenc fields) are also OK
        // in resultset-end positions. Simplest safe rule: treat every 0xFE
        // in resultset phase as OK-shaped.
        return 'ok-via-deprecate-eof';
    }
    if (payload.length <= 8) {
        return 'eof';
    }
    return 'eof';
}

// ─── AuthSwitchRequest (0xFE <plugin_name>\0 <challenge>) ────────────────────

export interface AuthSwitchRequest {
    pluginName: string;
    authPluginData: Buffer;
}

export function decodeAuthSwitchRequest(payload: Buffer): AuthSwitchRequest {
    if (payload.length === 0 || payload.readUInt8(0) !== PACKET_EOF) {
        throw new Error('decodeAuthSwitchRequest: not a 0xFE-prefixed payload');
    }
    const cur = new BufferCursor(payload);
    cur.skip(1);
    const pluginName = cur.readNullTerminatedString();
    // Remaining bytes are the challenge. Some servers include a trailing
    // 0x00; strip it if present.
    let data = cur.readRestBytes();
    if (data.length > 0 && data.readUInt8(data.length - 1) === 0) {
        data = data.subarray(0, data.length - 1);
    }
    return { pluginName: pluginName, authPluginData: Buffer.from(data) };
}

// ─── AuthMoreData (0x01 <data>) ──────────────────────────────────────────────

export interface AuthMoreData {
    data: Buffer;
}

export function decodeAuthMoreData(payload: Buffer): AuthMoreData {
    if (payload.length === 0 || payload.readUInt8(0) !== PACKET_AUTH_MORE_DATA) {
        throw new Error('decodeAuthMoreData: not a 0x01-prefixed payload');
    }
    return { data: Buffer.from(payload.subarray(1)) };
}

// ─── ColumnCount (lenenc int, one per packet) ────────────────────────────────

/** The first resultset packet: a single lenenc int giving the column count. */
export function decodeColumnCount(payload: Buffer): number {
    const cur = new BufferCursor(payload);
    const n = readLenencInt(cur);
    return typeof n === 'bigint' ? Number(n) : n;
}

// ─── ColumnDefinition41 — one per column, right after ColumnCount ────────────

export interface ColumnDefinition41 {
    catalog: string;       // always "def"
    schema: string;        // database name
    table: string;         // visible (aliased) table name
    orgTable: string;      // underlying table name
    name: string;          // visible (aliased) column name
    orgName: string;       // underlying column name
    collation: number;     // u16
    columnLength: number;  // u32 (max display length)
    typeCode: number;      // u8 — MYSQL_TYPE_*
    flags: number;         // u16 (UNSIGNED_FLAG, BINARY_FLAG, …)
    decimals: number;      // u8 (scale for numeric types; 0x1F means unspecified)
}

export function decodeColumnDefinition41(payload: Buffer): ColumnDefinition41 {
    const cur = new BufferCursor(payload);
    const catalog = readLenencUtf8(cur);
    const schema = readLenencUtf8(cur);
    const table = readLenencUtf8(cur);
    const orgTable = readLenencUtf8(cur);
    const name = readLenencUtf8(cur);
    const orgName = readLenencUtf8(cur);
    // `length_of_fixed_length_fields` — always 0x0C. Skip lenenc-int.
    readLenencInt(cur);
    const collation = cur.readUInt16LE();
    const columnLength = cur.readUInt32LE();
    const typeCode = cur.readUInt8();
    const flags = cur.readUInt16LE();
    const decimals = cur.readUInt8();
    // Trailing 2 filler bytes; we stop here so this function is
    // forward-compatible with any trailing MariaDB extensions.
    return {
        catalog: catalog,
        schema: schema,
        table: table,
        orgTable: orgTable,
        name: name,
        orgName: orgName,
        collation: collation,
        columnLength: columnLength,
        typeCode: typeCode,
        flags: flags,
        decimals: decimals,
    };
}

// ─── Text-resultset row — sequence of lenenc strings, NULL = 0xFB ───────────

/**
 * One row of a text-resultset. Each cell is either a raw-bytes view into
 * the packet payload, or `null` (represented by the 0xFB sentinel).
 * Text-format values are UTF-8 encoded server-side when the column
 * collation is a text collation; for binary collations (BLOB, etc.) the
 * bytes are returned verbatim and the caller chooses whether to decode.
 */
export type RawRow = (Buffer | null)[];

export function decodeTextResultsetRow(payload: Buffer, numColumns: number): RawRow {
    const cur = new BufferCursor(payload);
    const out: RawRow = new Array<Buffer | null>(numColumns);
    for (let i = 0; i < numColumns; i++) {
        const v = readLenencStringOrNull(cur);
        out[i] = v === null ? null : Buffer.from(v);
    }
    return out;
}

// ─── Compact re-exports for the connection layer ─────────────────────────────

export function isOk(payload: Buffer): boolean {
    return payload.length > 0 && payload.readUInt8(0) === PACKET_OK;
}

export function isErr(payload: Buffer): boolean {
    return payload.length > 0 && payload.readUInt8(0) === PACKET_ERR;
}

export function isEof(payload: Buffer): boolean {
    // "Classic" EOF: 0xFE + <9 bytes. Callers that need to distinguish
    // EOF from AuthSwitchRequest / LOCAL_INFILE should use classifyFePacket.
    return payload.length <= 9 && payload.length > 0 && payload.readUInt8(0) === PACKET_EOF;
}

export function isAuthMoreData(payload: Buffer): boolean {
    return payload.length > 0 && payload.readUInt8(0) === PACKET_AUTH_MORE_DATA;
}

// ─── PrepareOK — response to COM_STMT_PREPARE ────────────────────────────────

export interface PrepareOK {
    stmtId: number;
    numColumns: number;
    numParams: number;
    warningCount: number;
}

/**
 * Decode a COM_STMT_PREPARE OK packet (first byte 0x00).
 * Layout:
 *   [0x00][stmt_id: u32 LE][num_columns: u16 LE][num_params: u16 LE]
 *   [filler: u8 = 0x00][warning_count: u16 LE]
 */
export function decodePrepareOK(payload: Buffer): PrepareOK {
    if (payload.length < 12) {
        throw new Error('decodePrepareOK: short payload, ' + payload.length + ' bytes');
    }
    return {
        stmtId: payload.readUInt32LE(1),
        numColumns: payload.readUInt16LE(5),
        numParams: payload.readUInt16LE(7),
        warningCount: payload.readUInt16LE(10),
    };
}

// ─── Binary-resultset row — fixed-width for scalars, lenenc for strings ─────

/**
 * Decode one row of a binary resultset.
 *
 *   [0x00][null_bitmap: ceil((n+7+2)/8) bytes][values: type-specific]
 *
 * Each cell is either `null` (bit set) or a Buffer subview whose length
 * equals the decoded width for that column's MYSQL_TYPE_*. For lenenc-
 * prefixed types (strings, blobs, NEWDECIMAL, TIME/DATE/DATETIME), the
 * lenenc prefix is consumed before slicing, so the returned Buffer
 * contains exactly the payload bytes. For fixed-width scalars (ints,
 * float, double, year) the Buffer holds the raw little-endian bytes.
 *
 * Callers then pass the cell Buffer + typeCode to a codec for typed
 * decoding. When no codec is registered, the raw Buffer is available on
 * `rowsRaw`.
 */
export function decodeBinaryResultsetRow(
    payload: Buffer,
    columns: ColumnDefinition41[],
): (Buffer | null)[] {
    const n = columns.length;
    if (payload.length === 0 || payload.readUInt8(0) !== 0x00) {
        throw new Error('decodeBinaryResultsetRow: missing 0x00 prefix');
    }
    const bitmapSize = (n + 7 + 2) >> 3;
    const bitmapStart = 1;
    const cur = new BufferCursor(payload, bitmapStart + bitmapSize);
    const out: (Buffer | null)[] = new Array<Buffer | null>(n);
    for (let i = 0; i < n; i++) {
        const bitIdx = i + 2;
        const byte = payload.readUInt8(bitmapStart + (bitIdx >> 3));
        const isNull = (byte & (1 << (bitIdx & 7))) !== 0;
        if (isNull) {
            out[i] = null;
            continue;
        }
        out[i] = readBinaryCell(cur, columns[i].typeCode);
    }
    return out;
}

/**
 * Consume one binary-format cell from `cur` for the given MYSQL_TYPE_*.
 * Returns a Buffer view whose layout is the on-wire value as received
 * (callers decode further via a codec).
 *
 * Types that aren't in the recognised-fixed-width set are treated as
 * lenenc strings — the correct fallback for BLOB / VARCHAR / JSON / BIT /
 * NEWDECIMAL / ENUM / SET / GEOMETRY / YEAR... (we special-case YEAR
 * below because it's actually 2 bytes despite the spec listing it as
 * SHORT-like).
 */
function readBinaryCell(cur: BufferCursor, typeCode: number): Buffer {
    // Keyed on the MYSQL_TYPE_* constants (see ../types/type-codes.ts).
    // We inline the numeric comparisons here to avoid a circular import.
    //
    // Fixed-width types:
    //   TINY (1)   → 1 byte
    //   SHORT (2)  → 2 bytes
    //   LONG (3)   → 4 bytes
    //   LONGLONG (8) → 8 bytes
    //   FLOAT (4)  → 4 bytes
    //   DOUBLE (5) → 8 bytes
    //   INT24 (9)  → 4 bytes
    //   YEAR (13)  → 2 bytes
    //   NULL (6)   → 0 bytes (but NULL columns go through the bitmap)
    if (typeCode === 0x01) return cur.readBytes(1);    // TINY
    if (typeCode === 0x02) return cur.readBytes(2);    // SHORT
    if (typeCode === 0x03) return cur.readBytes(4);    // LONG
    if (typeCode === 0x08) return cur.readBytes(8);    // LONGLONG
    if (typeCode === 0x04) return cur.readBytes(4);    // FLOAT
    if (typeCode === 0x05) return cur.readBytes(8);    // DOUBLE
    if (typeCode === 0x09) return cur.readBytes(4);    // INT24 (sent as 4 bytes)
    if (typeCode === 0x0D) return cur.readBytes(2);    // YEAR
    if (typeCode === 0x06) return Buffer.alloc(0);     // NULL — shouldn't reach here
    // Everything else is lenenc-prefixed (string, blob, date/time, decimal).
    return readLenencString(cur);
}
