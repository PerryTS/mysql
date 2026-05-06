// In-process MySQL mock server for integration tests.
//
// Lets us drive the full connection state machine through a scripted
// sequence of packets — including auth-plugin switching, prepared-statement
// preparation, and canned resultsets — without a real MySQL instance.
//
// Parallels `@perryts/postgres`'s tests/integration/mock-server.ts. Uses the
// driver's own framing / lenenc / writer helpers so the mock stays terse
// and every byte we emit is vetted by the production code paths.
//
// The mock server is single-connection (good enough for our tests): it
// accepts one client at a time and emits the scripted sequence.

import * as net from 'net';
import * as tls from 'tls';
import { writePacket } from '../../src/protocol/framing';
import { MessageReader } from '../../src/protocol/reader';
import { writeLenencInt, writeLenencString, lenencStringSize, lenencIntSize } from '../../src/protocol/lenenc';
import {
    DEFAULT_CLIENT_CAPABILITIES,
    CLIENT_PROTOCOL_41,
    CLIENT_SECURE_CONNECTION,
    CLIENT_PLUGIN_AUTH,
    CLIENT_LONG_PASSWORD,
    CLIENT_CONNECT_WITH_DB,
    CLIENT_LONG_FLAG,
    CLIENT_TRANSACTIONS,
    CLIENT_DEPRECATE_EOF,
    CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA,
    CLIENT_SSL,
} from '../../src/protocol/capabilities';
import { HANDSHAKE_PROTOCOL_V10, PACKET_OK, PACKET_ERR, PACKET_EOF, PACKET_AUTH_MORE_DATA } from '../../src/protocol/messages';
import { nativeScramble } from '../../src/auth/native-password';
import { sha256Scramble } from '../../src/auth/caching-sha2';

export interface CannedRow {
    /** Pre-UTF8-encoded per-column strings (null for SQL NULL). */
    cells: (string | null)[];
}

export interface CannedResponse {
    /** Response kind: 'ok' (no resultset) or 'resultset' (columns + rows). */
    kind: 'ok' | 'resultset' | 'err' | 'local-infile';
    /** For 'ok': affected-rows / last-insert-id. */
    affectedRows?: number;
    lastInsertId?: number;
    /** For 'resultset': column metadata (name is enough; type defaults to VARCHAR). */
    columns?: Array<{ name: string; typeCode?: number }>;
    rows?: CannedRow[];
    /** For 'err'. */
    errno?: number;
    sqlState?: string;
    message?: string;
    /** Trigger multi-result: append these extra resultsets after the primary. */
    moreResults?: CannedResponse[];
    /** For 'local-infile': the filename the server pretends to want. */
    localInfileFilename?: string;
}

export type AuthMode = 'trust' | 'native' | 'caching-sha2-fast' | 'caching-sha2-full' | 'switch-to-native';

/** Cross-connection cancel dispatch: cancel() on the `KILL QUERY <id>`
 *  path fires the function registered under that connection id. */
const TARGET_CANCELS = new Map<number, () => void>();

export interface MockServerOptions {
    authMode: AuthMode;
    password: string;
    expectedUser: string;
    serverVersion?: string;
    challenge?: Buffer; // 20-byte challenge; default random-ish
    selectOne?: CannedResponse;
    /** SQL text → canned response. Exact string match. */
    cannedByQuery?: Map<string, CannedResponse>;
    /** Prepared-statement responses keyed by SQL text. */
    cannedPrepared?: Map<string, CannedPrepared>;
    /** If true, advertise CLIENT_DEPRECATE_EOF. Default true. */
    deprecateEof?: boolean;
    /**
     * TLS configuration. When set, the server advertises CLIENT_SSL in
     * HandshakeV10 and expects the client's first packet to be an
     * SSLRequest. After the client's TLS handshake, the remainder of the
     * auth + query protocol runs over TLS.
     */
    tls?: { cert: Buffer; key: Buffer };
    /**
     * Artificial delay before responding to the *first* query, used to
     * exercise `conn.cancel()`.
     */
    simulatedSleepMs?: number;
    /** Reply to `KILL QUERY <id>` with a canned OK, and also push an ERR
     *  (errno 1317) on the *target* connection if one is tracked. */
    killSupported?: boolean;
}

export interface CannedPrepared {
    paramTypes: number[];        // one MYSQL_TYPE_* per param slot
    columns: Array<{ name: string; typeCode: number }>;
    /** Compute the response row(s) given the raw (already decoded) param values. */
    execute: (params: unknown[]) => CannedRow[];
}

export interface MockServer {
    port: number;
    close(): Promise<void>;
    /** Server-side connection id allocator (matches what we sent on the wire). */
    connectionId: number;
}

export function startMockServer(opts: MockServerOptions): Promise<MockServer> {
    return new Promise((resolve) => {
        const challenge = opts.challenge !== undefined
            ? opts.challenge
            : Buffer.from([
                0x0A, 0x14, 0x1E, 0x28, 0x32, 0x3C, 0x46, 0x50,
                0x5A, 0x64, 0x6E, 0x78, 0x01, 0x02, 0x03, 0x04,
                0x05, 0x06, 0x07, 0x08,
            ]);
        // Allocate unique connection ids so `KILL QUERY` can target the
        // right target from a sibling connection.
        let nextConnectionId = 100;
        const firstConnectionId = nextConnectionId;
        // `pauseOnConnect: true` keeps the socket in paused mode so we can
        // manually `read(36)` the SSLRequest without letting the kernel
        // buffer drain into JS land (which would make the bytes
        // inaccessible to a TLSSocket wrap).
        const server = net.createServer({ pauseOnConnect: opts.tls !== undefined }, (sock) => {
            const connectionId = nextConnectionId;
            nextConnectionId += 1;
            driveConnection(sock, opts, challenge, connectionId).catch((e) => {
                // eslint-disable-next-line no-console
                console.error('[mock-server] connection error:', e);
                sock.destroy();
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address !== null ? address.port : 0;
            resolve({
                port: port,
                connectionId: firstConnectionId,
                close: () => new Promise<void>((done) => server.close(() => done())),
            });
        });
    });
}

async function driveConnection(
    plainSock: net.Socket,
    opts: MockServerOptions,
    challenge: Buffer,
    connectionId: number,
): Promise<void> {
    // `sock` is the current active socket — the plain one at first, may
    // be replaced with a TLSSocket after the client sends SSLRequest.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sock: any = plainSock;
    const reader = new MessageReader();
    const deprecateEof = opts.deprecateEof !== false;
    const tlsEnabled = opts.tls !== undefined;
    const serverCaps =
        (DEFAULT_CLIENT_CAPABILITIES
            | CLIENT_LONG_PASSWORD
            | CLIENT_LONG_FLAG
            | CLIENT_PROTOCOL_41
            | CLIENT_SECURE_CONNECTION
            | CLIENT_PLUGIN_AUTH
            | CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA
            | CLIENT_TRANSACTIONS
            | CLIENT_CONNECT_WITH_DB
            | (tlsEnabled ? CLIENT_SSL : 0)
            | (deprecateEof ? CLIENT_DEPRECATE_EOF : 0)) >>> 0;

    // Send HandshakeV10.
    const initialPluginName =
        opts.authMode === 'caching-sha2-fast' || opts.authMode === 'caching-sha2-full'
            ? 'caching_sha2_password'
            : 'mysql_native_password';
    const serverVersion = opts.serverVersion !== undefined ? opts.serverVersion : '8.0.36';
    const handshake = buildHandshakeV10({
        serverVersion: serverVersion,
        connectionId: connectionId,
        challenge: challenge,
        capabilities: serverCaps,
        pluginName: initialPluginName,
    });
    sendPacket(sock, 0, handshake);

    let seq = 1;
    let expectedPlugin = initialPluginName;
    let cachingSha2Phase: 'idle' | 'waiting-after-fast' | 'done' = 'idle';
    let activeStatus: 'auth-ssl' | 'auth' | 'query' | 'closed' = tlsEnabled ? 'auth-ssl' : 'auth';
    // Track prepared statements the client asked us to pre-chew.
    let nextStmtId = 1;
    const preparedByStmt = new Map<number, { sql: string; canned: CannedPrepared }>();

    const onChunk = (chunk: Buffer): void => {
        const packets = reader.feed(chunk);
        for (let i = 0; i < packets.length; i++) {
            const p = packets[i];
            if (activeStatus === 'auth') {
                const nextSeq = (p.seq + 1) & 0xFF;
                seq = nextSeq;
                handleClientAuthPacket(p.payload).catch((e) => {
                    // eslint-disable-next-line no-console
                    console.error('[mock-server] auth error:', e);
                });
            } else if (activeStatus === 'query') {
                handleClientCommand(p.payload, p.seq).catch((e) => {
                    // eslint-disable-next-line no-console
                    console.error('[mock-server] query error:', e);
                });
            }
        }
    };

    const attachDataListeners = (): void => {
        sock.on('data', onChunk);
        sock.on('error', () => { /* swallow */ });
        sock.on('close', () => {
            activeStatus = 'closed';
        });
    };

    if (tlsEnabled) {
        // Server was started with pauseOnConnect. Read the fixed-size
        // SSLRequest (36 bytes) via explicit `socket.read()` calls so
        // the rest of the kernel-buffered bytes stay available for the
        // TLSSocket wrap.
        readSSLRequestBytes();
    } else {
        attachDataListeners();
    }

    function readSSLRequestBytes(): void {
        const plain = sock as net.Socket;
        // Resume briefly to get a 'readable' event, then read(36).
        const tryRead = (): void => {
            const buf = plain.read(36);
            if (buf === null || buf.length < 36) {
                plain.once('readable', tryRead);
                return;
            }
            plain.removeAllListeners('readable');
            handleSSLRequest().catch((e) => {
                // eslint-disable-next-line no-console
                console.error('[mock-server] TLS upgrade error:', e);
            });
        };
        plain.once('readable', tryRead);
    }

    async function handleSSLRequest(): Promise<void> {
        const plain = sock as net.Socket;
        const secureContext = tls.createSecureContext({
            cert: opts.tls!.cert,
            key: opts.tls!.key,
        });
        const tlsSock = new tls.TLSSocket(plain, {
            isServer: true,
            secureContext: secureContext,
        });
        tlsSock.once('secure', () => {
            sock = tlsSock;
            activeStatus = 'auth';
            reader.reset();
            tlsSock.on('data', onChunk);
            tlsSock.on('error', () => { /* swallow */ });
            tlsSock.on('close', () => { activeStatus = 'closed'; });
        });
        tlsSock.once('error', (e) => {
            // eslint-disable-next-line no-console
            console.error('[mock-server] TLS handshake error:', e);
            activeStatus = 'closed';
            plain.destroy();
        });
    }

    async function handleClientAuthPacket(payload: Buffer): Promise<void> {
        // Minimal HandshakeResponse41 parser — we only care about user +
        // auth response + plugin name for dispatch.
        const { user, authResponse, pluginName } = parseHandshakeResponse41(payload);
        if (user !== opts.expectedUser) {
            sendErr(sock, seq, 1045, '28000', "Access denied for user '" + user + "'");
            activeStatus = 'closed';
            sock.end();
            return;
        }
        expectedPlugin = pluginName;
        if (opts.authMode === 'trust' || opts.password === '') {
            // Accept empty-password auth regardless of plugin: empty-response is legal.
            sendOk(sock, seq, 0, 0, 2, 0);
            activeStatus = 'query';
            return;
        }
        if (opts.authMode === 'switch-to-native' && expectedPlugin !== 'mysql_native_password') {
            sendAuthSwitchRequest(sock, seq, 'mysql_native_password', challenge);
            seq = (seq + 1) & 0xFF;
            // Wait for the next packet = scrambled response under native-password.
            sock.removeAllListeners('data');
            sock.on('data', (next) => {
                const pkts = reader.feed(next);
                for (let i = 0; i < pkts.length; i++) {
                    const response = pkts[i].payload;
                    const expected = nativeScramble(opts.password, challenge);
                    if (response.equals(expected)) {
                        sendOk(sock, (pkts[i].seq + 1) & 0xFF, 0, 0, 2, 0);
                        activeStatus = 'query';
                        sock.on('data', onChunk);
                        return;
                    }
                    sendErr(sock, (pkts[i].seq + 1) & 0xFF, 1045, '28000', 'Bad password');
                    activeStatus = 'closed';
                    sock.end();
                    return;
                }
            });
            return;
        }
        // native_password verification
        if (expectedPlugin === 'mysql_native_password') {
            const expected = nativeScramble(opts.password, challenge);
            if (authResponse.equals(expected)) {
                sendOk(sock, seq, 0, 0, 2, 0);
                activeStatus = 'query';
                return;
            }
            sendErr(sock, seq, 1045, '28000', 'Bad password');
            activeStatus = 'closed';
            sock.end();
            return;
        }
        // caching_sha2: fast path → AuthMoreData{0x03} → OK.
        if (expectedPlugin === 'caching_sha2_password') {
            const expected = sha256Scramble(opts.password, challenge);
            if (!authResponse.equals(expected)) {
                sendErr(sock, seq, 1045, '28000', 'Bad password');
                activeStatus = 'closed';
                sock.end();
                return;
            }
            if (opts.authMode === 'caching-sha2-fast') {
                sendAuthMoreData(sock, seq, Buffer.from([0x03]));
                seq = (seq + 1) & 0xFF;
                // OK packet follows immediately in the same flight.
                sendOk(sock, seq, 0, 0, 2, 0);
                activeStatus = 'query';
                return;
            }
            // caching-sha2-full: tell client to do full-auth, expect the next
            // packet (cleartext under TLS or RSA-encrypted). For this mock we
            // accept any bytes and OK. Tests that want stricter behaviour can
            // tailor the mock.
            sendAuthMoreData(sock, seq, Buffer.from([0x04]));
            seq = (seq + 1) & 0xFF;
            cachingSha2Phase = 'waiting-after-fast';
            sock.removeAllListeners('data');
            sock.on('data', (next) => {
                const pkts = reader.feed(next);
                for (let i = 0; i < pkts.length; i++) {
                    // We don't validate the RSA blob in the mock — just ack.
                    sendOk(sock, (pkts[i].seq + 1) & 0xFF, 0, 0, 2, 0);
                    activeStatus = 'query';
                    cachingSha2Phase = 'done';
                    sock.on('data', onChunk);
                    return;
                }
            });
            return;
        }
        sendErr(sock, seq, 1251, '08004', 'Client does not support authentication protocol');
        activeStatus = 'closed';
        sock.end();
    }
    // Silence unused warning.
    void cachingSha2Phase;

    async function handleClientCommand(payload: Buffer, recvSeq: number): Promise<void> {
        if (payload.length === 0) {
            return;
        }
        const cmd = payload.readUInt8(0);
        const outSeq = (recvSeq + 1) & 0xFF;
        if (cmd === 0x01 /* COM_QUIT */) {
            sock.end();
            activeStatus = 'closed';
            return;
        }
        if (cmd === 0x0E /* COM_PING */) {
            sendOk(sock, outSeq, 0, 0, 2, 0);
            return;
        }
        if (cmd === 0x03 /* COM_QUERY */) {
            const sql = payload.toString('utf8', 1);
            // KILL QUERY <id>: answer OK and notify any shared state. The
            // tracked target connection ERRs on its next data callback via
            // `cancelTargetFn` when the test framework provides one.
            const killMatch = /^KILL QUERY\s+(\d+)/i.exec(sql);
            if (killMatch !== null && opts.killSupported === true) {
                const id = Number(killMatch[1]);
                const tgt = TARGET_CANCELS.get(id);
                if (tgt !== undefined) {
                    tgt();
                }
                sendOk(sock, outSeq, 0, 0, 2, 0);
                return;
            }
            const canned = resolveCanned(opts, sql);
            if (canned === undefined) {
                sendErr(sock, outSeq, 1064, '42000', "mock: unhandled SQL '" + sql + "'");
                return;
            }
            // Track ourselves as a cancellable target if simulatedSleepMs is set.
            if (opts.simulatedSleepMs !== undefined && opts.simulatedSleepMs > 0) {
                let cancelled = false;
                const cancelFn = (): void => {
                    if (cancelled) return;
                    cancelled = true;
                    // On cancel, server responds to the in-flight query with an ERR
                    // (1317 / 70100 "Query execution was interrupted") — matches real
                    // MySQL server semantics.
                    sendErr(sock, outSeq, 1317, '70100', 'Query execution was interrupted');
                };
                TARGET_CANCELS.set(connectionId, cancelFn);
                await new Promise<void>((resolve) => setTimeout(resolve, opts.simulatedSleepMs!));
                TARGET_CANCELS.delete(connectionId);
                if (cancelled) {
                    return;
                }
            }
            emitCanned(sock, outSeq, canned, deprecateEof);
            return;
        }
        if (cmd === 0x16 /* COM_STMT_PREPARE */) {
            const sql = payload.toString('utf8', 1);
            const canned = opts.cannedPrepared !== undefined ? opts.cannedPrepared.get(sql) : undefined;
            if (canned === undefined) {
                sendErr(sock, outSeq, 1243, '42000', "mock: unprepared SQL '" + sql + "'");
                return;
            }
            const stmtId = nextStmtId;
            nextStmtId += 1;
            preparedByStmt.set(stmtId, { sql: sql, canned: canned });
            // PrepareOK
            const nCols = canned.columns.length;
            const nParams = canned.paramTypes.length;
            const ok = buildPrepareOk(stmtId, nCols, nParams);
            sendPacket(sock, outSeq, ok);
            let s = (outSeq + 1) & 0xFF;
            // Param definitions (if any), then trailing EOF when DEPRECATE_EOF is off.
            for (let i = 0; i < nParams; i++) {
                sendPacket(sock, s, buildColumnDef41('?', canned.paramTypes[i]));
                s = (s + 1) & 0xFF;
            }
            if (nParams > 0 && !deprecateEof) {
                sendPacket(sock, s, buildEof());
                s = (s + 1) & 0xFF;
            }
            // Column definitions (if any), then trailing EOF when DEPRECATE_EOF is off.
            for (let i = 0; i < nCols; i++) {
                sendPacket(sock, s, buildColumnDef41(canned.columns[i].name, canned.columns[i].typeCode));
                s = (s + 1) & 0xFF;
            }
            if (nCols > 0 && !deprecateEof) {
                sendPacket(sock, s, buildEof());
                s = (s + 1) & 0xFF;
            }
            return;
        }
        if (cmd === 0x17 /* COM_STMT_EXECUTE */) {
            const stmtId = payload.readUInt32LE(1);
            const entry = preparedByStmt.get(stmtId);
            if (entry === undefined) {
                sendErr(sock, outSeq, 1243, 'HY000', 'mock: unknown stmt id ' + stmtId);
                return;
            }
            // Parse params — minimal, the mock only needs unsigned-flag aware ints / floats / strings.
            const params = parseExecuteParams(payload, entry.canned);
            const rows = entry.canned.execute(params);
            // Emit: column count → column defs → [pre-row EOF] → binary rows → [EOF or OK].
            const nCols = entry.canned.columns.length;
            sendPacket(sock, outSeq, encodeLenencInt(nCols));
            let s = (outSeq + 1) & 0xFF;
            for (let i = 0; i < nCols; i++) {
                sendPacket(sock, s, buildColumnDef41(entry.canned.columns[i].name, entry.canned.columns[i].typeCode));
                s = (s + 1) & 0xFF;
            }
            if (!deprecateEof) {
                sendPacket(sock, s, buildEof());
                s = (s + 1) & 0xFF;
            }
            for (let r = 0; r < rows.length; r++) {
                sendPacket(sock, s, buildBinaryRow(entry.canned.columns, rows[r]));
                s = (s + 1) & 0xFF;
            }
            if (deprecateEof) {
                // Final OK-end-of-results. Shape it small so the driver's
                // short-length heuristic kicks in.
                sendPacket(sock, s, Buffer.from([0xFE, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]));
            } else {
                sendPacket(sock, s, buildEof());
            }
            return;
        }
        if (cmd === 0x19 /* COM_STMT_CLOSE */) {
            const stmtId = payload.readUInt32LE(1);
            preparedByStmt.delete(stmtId);
            // No response for COM_STMT_CLOSE.
            return;
        }
        sendErr(sock, outSeq, 1047, '08S01', 'mock: unhandled command 0x' + cmd.toString(16));
    }
}

// ─── Mock packet builders ────────────────────────────────────────────────────

interface HandshakeV10Opts {
    serverVersion: string;
    connectionId: number;
    challenge: Buffer;
    capabilities: number;
    pluginName: string;
}

function buildHandshakeV10(opts: HandshakeV10Opts): Buffer {
    const versionBytes = Buffer.from(opts.serverVersion, 'utf8');
    const part1 = opts.challenge.subarray(0, 8);
    const part2Raw = opts.challenge.subarray(8);
    const pluginBytes = Buffer.from(opts.pluginName, 'utf8');
    // Part 2 is padded to at least 12 bytes so the total auth_plugin_data
    // is ≥ 20 bytes. We write part2 + trailing NUL (13 bytes on the wire).
    const part2PaddedLen = part2Raw.length < 12 ? 12 : part2Raw.length;
    const part2Field = Buffer.alloc(part2PaddedLen + 1);
    part2Raw.copy(part2Field, 0);
    // Trailing NUL is already there (Buffer.alloc zeros).

    const size =
        1 /* protocol */ +
        versionBytes.length + 1 /* NUL */ +
        4 /* connection id */ +
        8 /* part1 */ +
        1 /* filler */ +
        2 /* caps lower */ +
        1 /* charset */ +
        2 /* status */ +
        2 /* caps upper */ +
        1 /* auth_plugin_data_len */ +
        10 /* reserved */ +
        part2Field.length +
        pluginBytes.length + 1 /* NUL */;

    const out = Buffer.alloc(size);
    let p = 0;
    out.writeUInt8(HANDSHAKE_PROTOCOL_V10, p); p += 1;
    versionBytes.copy(out, p); p += versionBytes.length;
    out.writeUInt8(0, p); p += 1;
    out.writeUInt32LE(opts.connectionId, p); p += 4;
    part1.copy(out, p); p += 8;
    out.writeUInt8(0, p); p += 1;
    out.writeUInt16LE(opts.capabilities & 0xFFFF, p); p += 2;
    out.writeUInt8(255 /* utf8mb4_0900_ai_ci */, p); p += 1;
    out.writeUInt16LE(0x0002 /* SERVER_STATUS_AUTOCOMMIT */, p); p += 2;
    out.writeUInt16LE((opts.capabilities >>> 16) & 0xFFFF, p); p += 2;
    out.writeUInt8(8 + part2Field.length, p); p += 1; // auth_plugin_data_len
    p += 10; // reserved (already zero)
    part2Field.copy(out, p); p += part2Field.length;
    pluginBytes.copy(out, p); p += pluginBytes.length;
    out.writeUInt8(0, p); p += 1;
    return out;
}

function parseHandshakeResponse41(payload: Buffer): {
    user: string;
    authResponse: Buffer;
    pluginName: string;
} {
    let p = 0;
    // caps(4) + max_packet(4) + charset(1) + reserved(23)
    p += 4 + 4 + 1 + 23;
    // user: null-terminated
    let userEnd = p;
    while (userEnd < payload.length && payload.readUInt8(userEnd) !== 0) userEnd++;
    const user = payload.toString('utf8', p, userEnd);
    p = userEnd + 1;
    // auth_response: lenenc-prefixed (assumes CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA)
    const first = payload.readUInt8(p);
    let authLen = 0;
    if (first < 0xFB) { authLen = first; p += 1; }
    else if (first === 0xFC) { authLen = payload.readUInt16LE(p + 1); p += 3; }
    else if (first === 0xFD) { authLen = payload.readUInt8(p + 1) | (payload.readUInt8(p + 2) << 8) | (payload.readUInt8(p + 3) << 16); p += 4; }
    else { authLen = Number(payload.readBigUInt64LE(p + 1)); p += 9; }
    const authResponse = Buffer.from(payload.subarray(p, p + authLen));
    p += authLen;
    // Optional database (null-terminated if CLIENT_CONNECT_WITH_DB): skip if present.
    // We only need user/authResp/pluginName; detect db by looking for a null.
    // To keep this parser simple, we just scan forward: if the *first* null byte
    // is before the end of the buffer, treat everything between as db; the
    // following null-terminated string is the plugin name. That works for the
    // mock's purposes.
    const rest = payload.subarray(p);
    const nulIdx = rest.indexOf(0);
    let pluginName = '';
    if (nulIdx >= 0) {
        // Skip db (or auth-plugin-name if no db).
        // If the server advertised CLIENT_CONNECT_WITH_DB, the layout is
        // db\0plugin\0 — we can detect by checking whether a *second* null
        // exists.
        const afterFirstNul = rest.subarray(nulIdx + 1);
        const secondNul = afterFirstNul.indexOf(0);
        if (secondNul >= 0) {
            // db followed by plugin name.
            pluginName = afterFirstNul.toString('utf8', 0, secondNul);
        } else {
            // Just plugin name, no db.
            pluginName = rest.toString('utf8', 0, nulIdx);
        }
    }
    return { user: user, authResponse: authResponse, pluginName: pluginName };
}

function resolveCanned(opts: MockServerOptions, sql: string): CannedResponse | undefined {
    if (opts.cannedByQuery !== undefined) {
        const direct = opts.cannedByQuery.get(sql);
        if (direct !== undefined) return direct;
    }
    if (opts.selectOne !== undefined && /^\s*SELECT\s+1\s*$/i.test(sql)) {
        return opts.selectOne;
    }
    return undefined;
}

function emitCanned(sock: net.Socket, startSeq: number, canned: CannedResponse, deprecateEof: boolean): void {
    emitCannedWithMore(sock, startSeq, canned, deprecateEof);
}

function emitCannedWithMore(sock: net.Socket, startSeq: number, canned: CannedResponse, deprecateEof: boolean): number {
    const hasMore = canned.moreResults !== undefined && canned.moreResults.length > 0;
    const statusFlags = 2 | (hasMore ? 0x0008 /* SERVER_MORE_RESULTS_EXISTS */ : 0);
    let s = startSeq;

    if (canned.kind === 'err') {
        sendErr(sock, s,
            canned.errno !== undefined ? canned.errno : 1064,
            canned.sqlState !== undefined ? canned.sqlState : '42000',
            canned.message !== undefined ? canned.message : 'mock error');
        return (s + 1) & 0xFF;
    }
    if (canned.kind === 'local-infile') {
        const filename = canned.localInfileFilename !== undefined ? canned.localInfileFilename : '/tmp/fake.csv';
        sendLocalInfile(sock, s, filename);
        return (s + 1) & 0xFF;
    }
    if (canned.kind === 'ok') {
        sendOk(sock, s,
            canned.affectedRows !== undefined ? canned.affectedRows : 0,
            canned.lastInsertId !== undefined ? canned.lastInsertId : 0,
            statusFlags,
            0 /* warnings */);
        s = (s + 1) & 0xFF;
        if (hasMore) {
            for (let i = 0; i < canned.moreResults!.length; i++) {
                s = emitCannedWithMore(sock, s, canned.moreResults![i], deprecateEof);
            }
        }
        return s;
    }
    const cols = canned.columns !== undefined ? canned.columns : [];
    const rows = canned.rows !== undefined ? canned.rows : [];
    sendPacket(sock, s, encodeLenencInt(cols.length));
    s = (s + 1) & 0xFF;
    for (let i = 0; i < cols.length; i++) {
        const typeCode = cols[i].typeCode !== undefined ? cols[i].typeCode! : 0xFD /* VAR_STRING */;
        sendPacket(sock, s, buildColumnDef41(cols[i].name, typeCode));
        s = (s + 1) & 0xFF;
    }
    if (!deprecateEof) {
        sendPacket(sock, s, buildEof());
        s = (s + 1) & 0xFF;
    }
    for (let r = 0; r < rows.length; r++) {
        sendPacket(sock, s, buildTextRow(rows[r]));
        s = (s + 1) & 0xFF;
    }
    if (deprecateEof) {
        // OK end-of-results, carrying SERVER_MORE_RESULTS_EXISTS when applicable.
        const lo = statusFlags & 0xFF;
        const hi = (statusFlags >>> 8) & 0xFF;
        sendPacket(sock, s, Buffer.from([0xFE, 0x00, 0x00, lo, hi, 0x00, 0x00]));
    } else {
        const eof = Buffer.alloc(5);
        eof.writeUInt8(0xFE, 0);
        eof.writeUInt16LE(0, 1);
        eof.writeUInt16LE(statusFlags, 3);
        sendPacket(sock, s, eof);
    }
    s = (s + 1) & 0xFF;
    if (hasMore) {
        for (let i = 0; i < canned.moreResults!.length; i++) {
            s = emitCannedWithMore(sock, s, canned.moreResults![i], deprecateEof);
        }
    }
    return s;
}

function sendLocalInfile(sock: net.Socket, seq: number, filename: string): void {
    const fn = Buffer.from(filename, 'utf8');
    const out = Buffer.alloc(1 + fn.length);
    out.writeUInt8(0xFB, 0);
    fn.copy(out, 1);
    sendPacket(sock, seq, out);
    // Wait for the client's empty-packet refusal, then send OK.
    const reader = new MessageReader();
    const onData = (chunk: Buffer): void => {
        const pkts = reader.feed(chunk);
        for (let i = 0; i < pkts.length; i++) {
            // Client sent empty packet → ack with OK.
            sock.off('data', onData);
            const ackSeq = (pkts[i].seq + 1) & 0xFF;
            // Unused; mock only needs to not wedge. The driver has already
            // pre-failed its pending query locally.
            void ackSeq;
            return;
        }
    };
    sock.on('data', onData);
}

function buildColumnDef41(name: string, typeCode: number): Buffer {
    // catalog="def", schema="", table="", orgTable="", name=<name>, orgName=<name>,
    // filler-lenenc=0x0C, collation, length, type, flags, decimals, filler(2).
    const parts: Array<string | Buffer> = [
        'def', '', '', '', name, name,
    ];
    let size = 0;
    const bufs: Buffer[] = [];
    for (let i = 0; i < parts.length; i++) {
        const b = Buffer.from(parts[i] as string, 'utf8');
        size += lenencStringSize(b.length);
        bufs.push(b);
    }
    const fixed = 1 + 2 + 4 + 1 + 2 + 1 + 2; // 0x0C + collation + length + type + flags + decimals + filler
    size += fixed;
    const out = Buffer.alloc(size);
    let p = 0;
    for (let i = 0; i < bufs.length; i++) {
        p = writeLenencString(bufs[i], out, p);
    }
    out.writeUInt8(0x0C, p); p += 1;
    out.writeUInt16LE(255 /* utf8mb4_0900_ai_ci */, p); p += 2;
    out.writeUInt32LE(65535, p); p += 4;
    out.writeUInt8(typeCode, p); p += 1;
    out.writeUInt16LE(0 /* flags */, p); p += 2;
    out.writeUInt8(0, p); p += 1; // decimals
    out.writeUInt16LE(0, p); p += 2; // filler
    return out;
}

function buildTextRow(row: CannedRow): Buffer {
    let size = 0;
    for (let i = 0; i < row.cells.length; i++) {
        const c = row.cells[i];
        if (c === null) {
            size += 1; // NULL sentinel
        } else {
            const b = Buffer.from(c, 'utf8');
            size += lenencStringSize(b.length);
        }
    }
    const out = Buffer.alloc(size);
    let p = 0;
    for (let i = 0; i < row.cells.length; i++) {
        const c = row.cells[i];
        if (c === null) {
            out.writeUInt8(0xFB, p); p += 1;
        } else {
            const b = Buffer.from(c, 'utf8');
            p = writeLenencString(b, out, p);
        }
    }
    return out;
}

function buildBinaryRow(columns: Array<{ name: string; typeCode: number }>, row: CannedRow): Buffer {
    const n = columns.length;
    const bitmapSize = (n + 7 + 2) >> 3;
    // Compute per-cell bytes.
    const cellBytes: Buffer[] = [];
    const nullBitmap = Buffer.alloc(bitmapSize);
    for (let i = 0; i < n; i++) {
        const c = row.cells[i];
        if (c === null) {
            const bitIdx = i + 2;
            const byteIdx = bitIdx >> 3;
            nullBitmap.writeUInt8(nullBitmap.readUInt8(byteIdx) | (1 << (bitIdx & 7)), byteIdx);
            continue;
        }
        cellBytes.push(encodeBinaryCell(columns[i].typeCode, c));
    }
    const total = 1 + bitmapSize + cellBytes.reduce((a, b) => a + b.length, 0);
    const out = Buffer.alloc(total);
    let p = 0;
    out.writeUInt8(0x00, p); p += 1;
    nullBitmap.copy(out, p); p += bitmapSize;
    for (let i = 0; i < cellBytes.length; i++) {
        cellBytes[i].copy(out, p); p += cellBytes[i].length;
    }
    return out;
}

function encodeBinaryCell(typeCode: number, s: string): Buffer {
    // s is a text representation we parse into the right binary layout.
    if (typeCode === 0x01) { const o = Buffer.alloc(1); o.writeInt8(parseInt(s, 10), 0); return o; }
    if (typeCode === 0x02) { const o = Buffer.alloc(2); o.writeInt16LE(parseInt(s, 10), 0); return o; }
    if (typeCode === 0x03 || typeCode === 0x09) { const o = Buffer.alloc(4); o.writeInt32LE(parseInt(s, 10), 0); return o; }
    if (typeCode === 0x08) {
        const o = Buffer.alloc(8);
        o.writeBigInt64LE(BigInt(s), 0);
        return o;
    }
    if (typeCode === 0x04) { const o = Buffer.alloc(4); o.writeFloatLE(parseFloat(s), 0); return o; }
    if (typeCode === 0x05) { const o = Buffer.alloc(8); o.writeDoubleLE(parseFloat(s), 0); return o; }
    if (typeCode === 0x0D) { const o = Buffer.alloc(2); o.writeUInt16LE(parseInt(s, 10), 0); return o; }
    // Fallback: lenenc string.
    const b = Buffer.from(s, 'utf8');
    const out = Buffer.alloc(lenencStringSize(b.length));
    writeLenencString(b, out, 0);
    return out;
}

function parseExecuteParams(payload: Buffer, canned: CannedPrepared): unknown[] {
    // Layout: [cmd(1)][stmt_id(4)][flags(1)][iter(4)][null_bitmap][new_params_bound(1)]
    //         [type_codes: 2 bytes per param][values...]
    const n = canned.paramTypes.length;
    if (n === 0) return [];
    let p = 1 + 4 + 1 + 4;
    const bitmapSize = (n + 7) >> 3;
    const nullBitmap = payload.subarray(p, p + bitmapSize);
    p += bitmapSize;
    const newParams = payload.readUInt8(p); p += 1;
    if (newParams !== 1) {
        throw new Error('mock: new_params_bound_flag must be 1');
    }
    const types: Array<{ typeCode: number; unsigned: boolean }> = [];
    for (let i = 0; i < n; i++) {
        const tc = payload.readUInt8(p); p += 1;
        const flag = payload.readUInt8(p); p += 1;
        types.push({ typeCode: tc, unsigned: (flag & 0x80) !== 0 });
    }
    const out: unknown[] = new Array<unknown>(n);
    for (let i = 0; i < n; i++) {
        const isNull = (nullBitmap.readUInt8(i >> 3) & (1 << (i & 7))) !== 0;
        if (isNull) { out[i] = null; continue; }
        const tc = types[i].typeCode;
        if (tc === 0x01) { out[i] = payload.readInt8(p); p += 1; }
        else if (tc === 0x02) { out[i] = payload.readInt16LE(p); p += 2; }
        else if (tc === 0x03 || tc === 0x09) { out[i] = payload.readInt32LE(p); p += 4; }
        else if (tc === 0x08) { out[i] = payload.readBigInt64LE(p); p += 8; }
        else if (tc === 0x04) { out[i] = payload.readFloatLE(p); p += 4; }
        else if (tc === 0x05) { out[i] = payload.readDoubleLE(p); p += 8; }
        else if (tc === 0x0D) { out[i] = payload.readUInt16LE(p); p += 2; }
        else {
            // Lenenc string.
            const first = payload.readUInt8(p);
            let len = 0;
            if (first < 0xFB) { len = first; p += 1; }
            else if (first === 0xFC) { len = payload.readUInt16LE(p + 1); p += 3; }
            else if (first === 0xFD) { len = payload.readUInt8(p + 1) | (payload.readUInt8(p + 2) << 8) | (payload.readUInt8(p + 3) << 16); p += 4; }
            else { len = Number(payload.readBigUInt64LE(p + 1)); p += 9; }
            out[i] = payload.toString('utf8', p, p + len);
            p += len;
        }
    }
    return out;
}

function buildPrepareOk(stmtId: number, nCols: number, nParams: number): Buffer {
    const out = Buffer.alloc(12);
    out.writeUInt8(PACKET_OK, 0);
    out.writeUInt32LE(stmtId, 1);
    out.writeUInt16LE(nCols, 5);
    out.writeUInt16LE(nParams, 7);
    out.writeUInt8(0 /* filler */, 9);
    out.writeUInt16LE(0 /* warnings */, 10);
    return out;
}

function buildEof(): Buffer {
    const out = Buffer.alloc(5);
    out.writeUInt8(PACKET_EOF, 0);
    out.writeUInt16LE(0 /* warnings */, 1);
    out.writeUInt16LE(0x0002 /* SERVER_STATUS_AUTOCOMMIT */, 3);
    return out;
}

function encodeLenencInt(n: number): Buffer {
    const out = Buffer.alloc(lenencIntSize(n));
    writeLenencInt(n, out, 0);
    return out;
}

// ─── Low-level senders ───────────────────────────────────────────────────────

function sendPacket(sock: net.Socket, seq: number, payload: Buffer): void {
    const { bytes } = writePacket(seq, payload);
    sock.write(bytes);
}

function sendOk(sock: net.Socket, seq: number, affectedRows: number, lastInsertId: number, statusFlags: number, warnings: number): void {
    // Minimal OK packet: header + lenenc affectedRows + lenenc lastInsertId + status + warnings.
    const size = 1 + lenencIntSize(affectedRows) + lenencIntSize(lastInsertId) + 2 + 2;
    const out = Buffer.alloc(size);
    let p = 0;
    out.writeUInt8(PACKET_OK, p); p += 1;
    p = writeLenencInt(affectedRows, out, p);
    p = writeLenencInt(lastInsertId, out, p);
    out.writeUInt16LE(statusFlags, p); p += 2;
    out.writeUInt16LE(warnings, p); p += 2;
    sendPacket(sock, seq, out);
}

function sendErr(sock: net.Socket, seq: number, errno: number, sqlState: string, msg: string): void {
    const msgBytes = Buffer.from(msg, 'utf8');
    const out = Buffer.alloc(1 + 2 + 1 + 5 + msgBytes.length);
    let p = 0;
    out.writeUInt8(PACKET_ERR, p); p += 1;
    out.writeUInt16LE(errno, p); p += 2;
    out.writeUInt8(0x23 /* '#' */, p); p += 1;
    out.write(sqlState, p, 5, 'ascii'); p += 5;
    msgBytes.copy(out, p);
    sendPacket(sock, seq, out);
}

function sendAuthMoreData(sock: net.Socket, seq: number, data: Buffer): void {
    const out = Buffer.alloc(1 + data.length);
    out.writeUInt8(PACKET_AUTH_MORE_DATA, 0);
    data.copy(out, 1);
    sendPacket(sock, seq, out);
}

function sendAuthSwitchRequest(sock: net.Socket, seq: number, pluginName: string, challenge: Buffer): void {
    const nameBytes = Buffer.from(pluginName, 'utf8');
    const out = Buffer.alloc(1 + nameBytes.length + 1 + challenge.length + 1);
    let p = 0;
    out.writeUInt8(0xFE, p); p += 1;
    nameBytes.copy(out, p); p += nameBytes.length;
    out.writeUInt8(0, p); p += 1;
    challenge.copy(out, p); p += challenge.length;
    out.writeUInt8(0, p); p += 1;
    sendPacket(sock, seq, out);
}
