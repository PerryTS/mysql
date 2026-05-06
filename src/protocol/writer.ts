// Client → server packet payload builders. Each function returns a
// Buffer ready to be wrapped by `writePacket(seq, payload)` from framing.
//
// Naming and style mirror `@perryts/postgres`'s writer: pure functions,
// Buffer-returning, no hidden state.

import { writeLenencInt, writeLenencString, lenencIntSize, lenencStringSize } from './lenenc';
import {
    COM_QUERY,
    COM_QUIT,
    COM_PING,
    COM_INIT_DB,
    COM_STMT_PREPARE,
    COM_STMT_EXECUTE,
    COM_STMT_CLOSE,
    COM_STMT_RESET,
    COM_STMT_SEND_LONG_DATA,
    COM_RESET_CONNECTION,
    CURSOR_TYPE_NO_CURSOR,
    CACHING_SHA2_REQUEST_PUBLIC_KEY,
} from './messages';
import { CLIENT_CONNECT_WITH_DB, CLIENT_PLUGIN_AUTH, CLIENT_SSL, CLIENT_CONNECT_ATTRS } from './capabilities';

// ─── SSLRequest — 32-byte mini-handshake sent before the TLS upgrade ────────

/**
 * Layout:
 *   client_capabilities: u32 LE
 *   max_packet_size:     u32 LE
 *   charset:             u8
 *   reserved:            23 bytes of 0x00
 *
 * The server sees CLIENT_SSL in the capabilities and switches the connection
 * to TLS. The rest of HandshakeResponse41 is sent over TLS.
 */
export function writeSSLRequest(
    clientCaps: number,
    maxPacketSize: number,
    charset: number,
): Buffer {
    const out = Buffer.alloc(32);
    out.writeUInt32LE((clientCaps | CLIENT_SSL) >>> 0, 0);
    out.writeUInt32LE(maxPacketSize, 4);
    out.writeUInt8(charset, 8);
    // Bytes 9..31 are already zeroed by Buffer.alloc.
    return out;
}

// ─── HandshakeResponse41 — the client's reply to HandshakeV10 ───────────────

export interface HandshakeResponse41Options {
    capabilities: number;
    maxPacketSize: number;
    charset: number;
    username: string;
    /**
     * Auth response bytes. Shape depends on the plugin:
     *   - mysql_native_password: 20-byte SHA1-derived response (or empty if no password)
     *   - caching_sha2_password: 32-byte SHA256-derived response
     *   - mysql_clear_password:  password bytes + trailing 0x00
     *   - client_ed25519:        64-byte signature
     *   - sha256_password:       plaintext or RSA-encrypted, depending on state
     */
    authResponse: Buffer;
    /** Initial database — sent only when CLIENT_CONNECT_WITH_DB is set. */
    database: string | null;
    /** Plugin name (null-terminated on the wire) — only when CLIENT_PLUGIN_AUTH is set. */
    authPluginName: string;
    /** Optional key/value connection attributes (program_name=…, os_user=…). */
    attrs?: Record<string, string>;
}

export function writeHandshakeResponse41(opts: HandshakeResponse41Options): Buffer {
    const caps = opts.capabilities;
    const userBytes = Buffer.from(opts.username, 'utf8');
    const authLen = opts.authResponse.length;
    const authLenencSize = lenencIntSize(authLen);

    let dbBytes: Buffer | null = null;
    let dbSize = 0;
    if (opts.database !== null && (caps & CLIENT_CONNECT_WITH_DB) !== 0) {
        dbBytes = Buffer.from(opts.database, 'utf8');
        dbSize = dbBytes.length + 1; // +1 for the trailing NUL
    }

    let pluginSize = 0;
    let pluginBytes: Buffer | null = null;
    if ((caps & CLIENT_PLUGIN_AUTH) !== 0) {
        pluginBytes = Buffer.from(opts.authPluginName, 'utf8');
        pluginSize = pluginBytes.length + 1;
    }

    let attrsBlob: Buffer | null = null;
    let attrsSize = 0;
    if ((caps & CLIENT_CONNECT_ATTRS) !== 0 && opts.attrs !== undefined) {
        attrsBlob = encodeAttrs(opts.attrs);
        attrsSize = lenencIntSize(attrsBlob.length) + attrsBlob.length;
    }

    const total =
        4 /* capabilities */ +
        4 /* max_packet_size */ +
        1 /* charset */ +
        23 /* reserved */ +
        userBytes.length + 1 /* NUL */ +
        authLenencSize + authLen +
        dbSize +
        pluginSize +
        attrsSize;

    const out = Buffer.alloc(total);
    let p = 0;
    out.writeUInt32LE(caps >>> 0, p); p += 4;
    out.writeUInt32LE(opts.maxPacketSize, p); p += 4;
    out.writeUInt8(opts.charset, p); p += 1;
    // 23 reserved bytes of 0x00 (Buffer.alloc already zeroed them).
    p += 23;
    userBytes.copy(out, p); p += userBytes.length;
    out.writeUInt8(0, p); p += 1;
    p = writeLenencInt(authLen, out, p);
    opts.authResponse.copy(out, p); p += authLen;
    if (dbBytes !== null) {
        dbBytes.copy(out, p); p += dbBytes.length;
        out.writeUInt8(0, p); p += 1;
    }
    if (pluginBytes !== null) {
        pluginBytes.copy(out, p); p += pluginBytes.length;
        out.writeUInt8(0, p); p += 1;
    }
    if (attrsBlob !== null) {
        p = writeLenencInt(attrsBlob.length, out, p);
        attrsBlob.copy(out, p); p += attrsBlob.length;
    }
    return out;
}

/** Serialize the connect-attrs map as a flat lenenc_str key0 val0 key1 val1 ... blob. */
function encodeAttrs(attrs: Record<string, string>): Buffer {
    const keys = Object.keys(attrs);
    let size = 0;
    const pairs: Array<{ k: Buffer; v: Buffer }> = [];
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const val = attrs[k];
        const kb = Buffer.from(k, 'utf8');
        const vb = Buffer.from(val, 'utf8');
        size += lenencStringSize(kb.length) + lenencStringSize(vb.length);
        pairs.push({ k: kb, v: vb });
    }
    const out = Buffer.alloc(size);
    let p = 0;
    for (let i = 0; i < pairs.length; i++) {
        p = writeLenencString(pairs[i].k, out, p);
        p = writeLenencString(pairs[i].v, out, p);
    }
    return out;
}

// ─── AuthSwitchResponse — raw bytes, no COM byte prefix ─────────────────────

export function writeAuthSwitchResponse(bytes: Buffer): Buffer {
    // The client's reply to AuthSwitchRequest is the raw auth response of
    // the newly-switched-to plugin, with no wrapping.
    return bytes;
}

/** Pre-built 1-byte caching_sha2 "send me your pubkey" request. */
export function writeCachingSha2RequestPublicKey(): Buffer {
    return Buffer.from([CACHING_SHA2_REQUEST_PUBLIC_KEY]);
}

/** For full-auth: raw bytes to send as the next AuthMoreData-style response. */
export function writeAuthMoreDataResponse(bytes: Buffer): Buffer {
    return bytes;
}

// ─── Text-protocol commands ──────────────────────────────────────────────────

export function writeComQuery(sql: string): Buffer {
    const sqlBytes = Buffer.from(sql, 'utf8');
    const out = Buffer.alloc(1 + sqlBytes.length);
    out.writeUInt8(COM_QUERY, 0);
    sqlBytes.copy(out, 1);
    return out;
}

export function writeComQuit(): Buffer {
    return Buffer.from([COM_QUIT]);
}

export function writeComPing(): Buffer {
    return Buffer.from([COM_PING]);
}

export function writeComInitDb(database: string): Buffer {
    const dbBytes = Buffer.from(database, 'utf8');
    const out = Buffer.alloc(1 + dbBytes.length);
    out.writeUInt8(COM_INIT_DB, 0);
    dbBytes.copy(out, 1);
    return out;
}

export function writeComResetConnection(): Buffer {
    return Buffer.from([COM_RESET_CONNECTION]);
}

// ─── Binary-protocol (prepared statement) commands ──────────────────────────

export function writeComStmtPrepare(sql: string): Buffer {
    const sqlBytes = Buffer.from(sql, 'utf8');
    const out = Buffer.alloc(1 + sqlBytes.length);
    out.writeUInt8(COM_STMT_PREPARE, 0);
    sqlBytes.copy(out, 1);
    return out;
}

export function writeComStmtClose(stmtId: number): Buffer {
    const out = Buffer.alloc(5);
    out.writeUInt8(COM_STMT_CLOSE, 0);
    out.writeUInt32LE(stmtId, 1);
    return out;
}

export function writeComStmtReset(stmtId: number): Buffer {
    const out = Buffer.alloc(5);
    out.writeUInt8(COM_STMT_RESET, 0);
    out.writeUInt32LE(stmtId, 1);
    return out;
}

export function writeComStmtSendLongData(
    stmtId: number,
    paramIdx: number,
    data: Buffer,
): Buffer {
    const out = Buffer.alloc(7 + data.length);
    out.writeUInt8(COM_STMT_SEND_LONG_DATA, 0);
    out.writeUInt32LE(stmtId, 1);
    out.writeUInt16LE(paramIdx, 5);
    data.copy(out, 7);
    return out;
}

/**
 * Build a COM_STMT_EXECUTE packet.
 *
 * Layout (new-params-bound-flag = 1 path, the only one we emit):
 *   [0x17][stmt_id: u32 LE][flags: u8][iteration_count: u32 LE = 1]
 *   [null_bitmap: ceil(n/8) bytes]
 *   [new_params_bound_flag: u8 = 1]
 *     (if new_params_bound_flag == 1:)
 *   [type_code_1: u8][unsigned_flag_1: u8] * n_params
 *   [param_value_1][param_value_2] ... (only for non-null params)
 *
 * @param nullBitmap  Pre-built per-param NULL bitmap (see util/null-bitmap).
 * @param paramTypes  Array of { typeCode, unsigned } per param (length n).
 * @param paramBytes  Concatenated encoded param bytes for non-null params,
 *                    in the same order (lenenc-prefixed where required by
 *                    the binary format).
 */
export function writeComStmtExecute(
    stmtId: number,
    flags: number,
    nullBitmap: Buffer,
    paramTypes: Array<{ typeCode: number; unsigned: boolean }>,
    paramBytes: Buffer,
): Buffer {
    const nParams = paramTypes.length;
    const typeTableSize = nParams * 2;
    const total =
        1 /* COM_STMT_EXECUTE */ +
        4 /* stmt_id */ +
        1 /* flags */ +
        4 /* iteration_count */ +
        nullBitmap.length +
        1 /* new_params_bound_flag */ +
        typeTableSize +
        paramBytes.length;
    const out = Buffer.alloc(total);
    let p = 0;
    out.writeUInt8(COM_STMT_EXECUTE, p); p += 1;
    out.writeUInt32LE(stmtId, p); p += 4;
    out.writeUInt8(flags, p); p += 1;
    out.writeUInt32LE(1, p); p += 4; // iteration_count is always 1 in the protocol
    nullBitmap.copy(out, p); p += nullBitmap.length;
    out.writeUInt8(1, p); p += 1; // new_params_bound_flag
    for (let i = 0; i < nParams; i++) {
        const t = paramTypes[i];
        out.writeUInt8(t.typeCode, p); p += 1;
        out.writeUInt8(t.unsigned ? 0x80 : 0x00, p); p += 1;
    }
    paramBytes.copy(out, p);
    return out;
}

/** `no cursor` flag convenience re-export for callers that don't want to import `messages.ts`. */
export const STMT_EXECUTE_FLAG_NO_CURSOR = CURSOR_TYPE_NO_CURSOR;
