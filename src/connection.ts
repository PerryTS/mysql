// Connection lifecycle + query protocols (text + prepared).
//
// State is keyed in a module-level Map<number, ConnState>, not on the
// Connection instance. This is the pattern required by Perry's AOT
// constraints: closures (e.g. the socket 'data' callback) capture values,
// so `this.foo = x` inside an event handler wouldn't propagate. Every
// mutation goes through `CONN_STATES.get(id)` instead.
//
// Scope covered here:
//   M2 — TCP connect + HandshakeV10 + HandshakeResponse41 + COM_QUERY
//   M3 — Auth plugin dispatcher (mid-handshake plugin switch + AuthMoreData)
//   M4 — COM_STMT_PREPARE / COM_STMT_EXECUTE / COM_STMT_CLOSE with LRU cache
//
// TLS (M6), pool (M6), cancel via KILL QUERY (M6) and multi-resultset /
// LOCAL_INFILE handling (M7) land in later milestones.

import { MessageReader } from './protocol/reader';
import { writePacket } from './protocol/framing';
import {
    writeHandshakeResponse41,
    writeSSLRequest,
    writeComQuery,
    writeComQuit,
    writeComStmtPrepare,
    writeComStmtExecute,
    writeComStmtClose,
    STMT_EXECUTE_FLAG_NO_CURSOR,
} from './protocol/writer';
import {
    decodeHandshakeV10,
    decodeOkPacket,
    decodeErrPacket,
    decodeEofPacket,
    decodeColumnCount,
    decodeColumnDefinition41,
    decodeTextResultsetRow,
    decodeAuthSwitchRequest,
    decodeAuthMoreData,
    decodePrepareOK,
    decodeBinaryResultsetRow,
    isOk,
    isErr,
    isEof,
    isAuthMoreData,
    type ColumnDefinition41,
    type RawRow,
} from './protocol/decoder';
import { MyError } from './error';
import type { MyWarning } from './warnings';
import { openSocket, isNodeLike, type Socket } from './transport/net-socket';
import { upgradeToTls } from './transport/upgrade-tls';
import { CLIENT_SSL } from './protocol/capabilities';
import { sendKillQuery } from './cancel';
import { isSqlQuery, type SqlQuery } from './sql';
import { resolveConnectOptions, type ResolveOptionsInput } from './env';
import {
    DEFAULT_CLIENT_CAPABILITIES,
    CLIENT_CONNECT_WITH_DB,
    CLIENT_CONNECT_ATTRS,
    hasCap,
} from './protocol/capabilities';
import { deriveTxnStatus, type TxnStatus, hasMoreResults } from './protocol/status';
import {
    type AuthPlugin,
    type AuthCtx,
    getAuthPlugin,
    handleAuthSwitch,
    handleAuthMoreData,
} from './auth/dispatcher';
import { MAX_PACKET_PAYLOAD } from './protocol/messages';
import { registerDefaultPlugins } from './register-defaults';
import { buildParamNullBitmap } from './util/null-bitmap';
import { pickDecoder, encodeValue, getCodec } from './types/registry';
import { FORMAT_TEXT, FORMAT_BINARY } from './types/type-codes';
import type { WireFormat } from './types/type-codes';

// ─── Public types ────────────────────────────────────────────────────────────

export interface ConnectOptions {
    host: string;
    port: number;
    user: string;
    database: string;
    password?: string;
    /** Milliseconds to wait for the TCP connect + handshake. Default 10000. */
    connectTimeoutMs?: number;
    /**
     * When true, allow fetching the server's RSA public key over plain
     * TCP for caching_sha2 / sha256 full-auth. Default false (matches
     * JDBC). Prefer enabling TLS instead.
     */
    allowPublicKeyRetrieval?: boolean;
    /** Character set (collation id). Default 255 (utf8mb4_0900_ai_ci). */
    charset?: number;
    /** Max client-allowed packet size in bytes. Default ~64MB. */
    maxPacketSize?: number;
    /** Optional connect-attribute key/value pairs echoed to the server. */
    attrs?: Record<string, string>;
    /**
     * TLS configuration. Semantics:
     *   - `disable`      — no TLS (default when `ssl` is omitted).
     *   - `require`      — send SSLRequest, encrypt, do NOT verify cert.
     *   - `verify-ca`    — encrypt and verify chain.
     *   - `verify-full`  — encrypt, verify chain AND hostname.
     */
    ssl?: { mode: 'disable' | 'require' | 'verify-ca' | 'verify-full' };
    /**
     * When true, declare `CLIENT_MULTI_STATEMENTS` and allow the server
     * to stream multiple resultsets per `query()` (use `queryMulti()`
     * to get them all). Default false — safer against SQL-injection
     * surface expansion.
     */
    multipleStatements?: boolean;
    /**
     * Policy for `LOCAL_INFILE` requests sent by the server in response to
     * `LOAD DATA LOCAL INFILE ...`. Default `'refuse'` — the driver
     * terminates the request with an empty packet and rejects the query
     * with a `MyError`. Opt in to `'allow-any'` only when you trust the
     * server (a malicious server can read arbitrary files from the client).
     */
    localInfile?: 'refuse' | 'allow-any';
}

export interface QueryResult<T = Record<string, unknown>> {
    /** Column metadata, one entry per column. */
    fields: ColumnDefinition41[];
    /**
     * Each row as an object keyed by column name. Values are decoded from
     * the text or binary format into JS primitives. In M2-M4, values are
     * UTF-8 strings for text columns and raw Buffers otherwise; richer
     * codecs land in M5.
     */
    rows: T[];
    /** Same data as `rows` in positional form. */
    rowsArray: unknown[][];
    /** Raw per-cell buffers as they arrived on the wire. `null` for SQL NULL. */
    rowsRaw: RawRow[];
    /** Non-standard command tag. "SELECT", "INSERT", etc., as best we can infer. */
    command: string;
    /** Rows affected (OK packet `affected_rows` field). */
    rowCount: number;
    /** Last insert id (OK packet `last_insert_id` field). */
    lastInsertId: number | bigint;
    /** Number of warnings raised by the last statement. */
    warningCount: number;
    /**
     * When the server streamed additional resultsets (only possible with
     * `multipleStatements: true` AND a multi-statement SQL string), every
     * resultset including this one lives here in order. For single-result
     * queries the field is undefined.
     */
    resultSets?: QueryResult[];
}

// ─── Internal state ──────────────────────────────────────────────────────────

type Phase =
    | 'connecting'
    | 'auth-handshake'        // waiting for HandshakeV10
    | 'ssl-upgrading'         // SSLRequest written, TLS handshake in flight
    | 'auth-response-sent'    // HandshakeResponse41 written, waiting for OK / AuthSwitch / AuthMoreData / ERR
    | 'ready'
    | 'query-simple-columns'  // expecting ColumnDefinition41 packets
    | 'query-simple-rows'     // expecting text rows or EOF/OK
    | 'query-stmt-prep-ok'    // waiting for the OK of PREPARE, then param defs + column defs
    | 'query-stmt-prep-param-defs'
    | 'query-stmt-prep-col-defs'
    | 'query-stmt-exec-columns'
    | 'query-stmt-exec-rows'
    | 'closed';

interface PendingQuery {
    resolve: (r: QueryResult) => void;
    reject: (e: Error) => void;
    // Text-protocol fields.
    textColumnCount: number;
    fields: ColumnDefinition41[];
    rowsRaw: RawRow[];
    // Prepared-protocol fields.
    stmt: PreparedStatement | null;
    params: unknown[] | null;
    // Common.
    commandTag: string;
    rowCount: number;
    lastInsertId: number | bigint;
    warningCount: number;
    error: MyError | null;
    // For stmt prepare: how many column / param definitions still to collect.
    remainingColumnDefs: number;
    remainingParamDefs: number;
    paramFields: ColumnDefinition41[];
    /** Accumulated previous resultsets when the server streams multiples. */
    priorResults: QueryResult[];
    /** True iff the original query was issued through the text protocol. */
    textProtocol: boolean;
}

interface StartupGate {
    resolve: (c: Connection) => void;
    reject: (e: Error) => void;
    settled: boolean;
}

interface PreparedStatement {
    sql: string;
    stmtId: number;
    numColumns: number;
    numParams: number;
    paramFields: ColumnDefinition41[];
    columnFields: ColumnDefinition41[];
}

interface ConnState {
    id: number;
    sock: Socket;
    opts: ConnectOptions;
    reader: MessageReader;
    phase: Phase;
    /** Sequence id to write on the NEXT outbound packet in the current command. */
    nextSeq: number;
    /** Server-declared capabilities (from HandshakeV10). */
    serverCaps: number;
    /** Effective capabilities (client & server). */
    effectiveCaps: number;
    connectionId: number;
    serverVersion: string;
    isMariaDB: boolean;
    txnStatus: TxnStatus;
    startupGate: StartupGate | null;
    pending: PendingQuery | null;
    preparedCache: Map<string, PreparedStatement>;
    authPlugin: AuthPlugin | null;
    authCtx: AuthCtx;
    warningHandlers: Array<(w: MyWarning) => void>;
    errorHandlers: Array<(e: Error) => void>;
    connection: Connection;
    dataListener: (chunk: Buffer) => void;
    /** True → route writes through the deferred queue (Perry runtimes). */
    deferWrites: boolean;
    /** Outbound frames awaiting the next timer-tick flush (deferWrites only). */
    writeQueue: Buffer[];
    writeFlushScheduled: boolean;
    /** Callbacks to run after the next queue flush hits the socket. */
    afterWriteFlush: Array<() => void>;
    /** Cached handshake so we can finish it once TLS is negotiated. */
    pendingHandshake: {
        h: import('./protocol/decoder').HandshakeV10;
        seq: number;
    } | null;
}

let NEXT_CONN_ID = 1;
const CONN_STATES = new Map<number, ConnState>();

// ─── Deferred socket writes (PerryTS/perry#5021 workaround) ──────────────────
//
// Under a Perry-compiled Linux binary, `net.Socket.write()` issued from
// inside a 'data' callback is silently dropped — no write(2) syscall is
// emitted. Every server-driven frame this driver sends originates from
// exactly that context: HandshakeResponse41 after the greeting, auth-switch
// and AuthMoreData responses, COM_STMT_EXECUTE after PrepareOK, and the
// LOCAL_INFILE terminator. Workaround: on Perry, queue outbound bytes and
// flush them from a zero-delay timer, which runs outside the data dispatch.
// Node/Bun keep the direct synchronous write. See PerryTS/mysql#2.

let FORCE_DEFER_WRITES = false;

/** Test hook: force the Perry deferred-write path under Node/Bun. */
export function setForceDeferredWrites(v: boolean): void {
    FORCE_DEFER_WRITES = v;
}

function socketWrite(st: ConnState, bytes: Buffer): void {
    if (!st.deferWrites) {
        st.sock.write(bytes);
        return;
    }
    st.writeQueue.push(bytes);
    if (!st.writeFlushScheduled) {
        st.writeFlushScheduled = true;
        const id = st.id;
        setTimeout(() => { flushWriteQueue(id); }, 0);
    }
}

function flushWriteQueue(id: number): void {
    const st = CONN_STATES.get(id);
    if (st === undefined) {
        return;
    }
    st.writeFlushScheduled = false;
    const q = st.writeQueue;
    st.writeQueue = [];
    for (let i = 0; i < q.length; i++) {
        st.sock.write(q[i]);
    }
    const after = st.afterWriteFlush;
    st.afterWriteFlush = [];
    for (let i = 0; i < after.length; i++) {
        after[i]();
    }
}

// ─── Connection class ────────────────────────────────────────────────────────

export class Connection {
    private readonly _id: number;

    public connection_id: number = 0;
    public serverVersion: string = '';

    constructor(id: number) {
        this._id = id;
    }

    _stateId(): number {
        return this._id;
    }

    /**
     * Run a query. No params → text protocol (COM_QUERY). With params →
     * prepared protocol (COM_STMT_PREPARE/EXECUTE) with a per-connection
     * LRU cache keyed on the SQL text.
     *
     * `sql` may be a `SqlQuery` from the `sql\`\`` tagged template —
     * parameters embedded there are used automatically.
     */
    query<T = Record<string, unknown>>(
        sql: string | SqlQuery,
        params?: unknown[],
    ): Promise<QueryResult<T>> {
        let text: string;
        let effectiveParams: unknown[] | undefined;
        if (isSqlQuery(sql)) {
            text = sql.text;
            effectiveParams = params !== undefined ? params : sql.params;
        } else {
            text = sql;
            effectiveParams = params;
        }
        if (effectiveParams === undefined || effectiveParams.length === 0) {
            return runTextQuery(this._id, text) as Promise<QueryResult<T>>;
        }
        return runPreparedQuery(this._id, text, effectiveParams) as Promise<QueryResult<T>>;
    }

    /**
     * Cancel the in-flight query (if any) by opening a fresh connection
     * and sending `KILL QUERY <connection_id>`. Fire-and-forget —
     * resolves when the side connection has closed. The target's
     * in-flight `query()` promise rejects once the server processes
     * the cancel (errno 1317 / SQLSTATE 70100).
     */
    cancel(): Promise<void> {
        const st = CONN_STATES.get(this._id);
        if (st === undefined) {
            return Promise.resolve();
        }
        return sendKillQuery(st.opts, st.connectionId);
    }

    async transaction<T>(cb: (conn: Connection) => Promise<T>): Promise<T> {
        await this.query('BEGIN');
        try {
            const result = await cb(this);
            await this.query('COMMIT');
            return result;
        } catch (e) {
            try {
                await this.query('ROLLBACK');
            } catch (_rollbackErr) {
                // Swallow rollback errors; the original failure is what callers need.
            }
            throw e;
        }
    }

    close(): Promise<void> {
        return closeConnection(this._id);
    }

    on(event: 'warning', cb: (w: MyWarning) => void): void;
    on(event: 'error', cb: (e: Error) => void): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, cb: (...args: any[]) => void): void {
        const st = CONN_STATES.get(this._id);
        if (st === undefined) {
            return;
        }
        if (event === 'warning') {
            st.warningHandlers.push(cb as (w: MyWarning) => void);
        } else if (event === 'error') {
            st.errorHandlers.push(cb as (e: Error) => void);
        }
    }
}

// ─── Public entry point ──────────────────────────────────────────────────────

export function connect(
    input: string | ConnectOptions | ResolveOptionsInput,
): Promise<Connection> {
    registerDefaultPlugins();

    const opts: ConnectOptions =
        typeof input === 'string'
            ? resolveConnectOptions({ url: input })
            : isFullyResolved(input)
            ? (input as ConnectOptions)
            : resolveConnectOptions(input);

    return new Promise<Connection>((resolve, reject) => {
        const id = NEXT_CONN_ID;
        NEXT_CONN_ID += 1;

        const sock = openSocket(opts.host, opts.port);
        const conn = new Connection(id);

        const dataListener = (chunk: Buffer): void => {
            onSocketData(id, chunk);
        };

        const maxPacketSize = opts.maxPacketSize !== undefined ? opts.maxPacketSize : 64 * 1024 * 1024;
        const charset = opts.charset !== undefined ? opts.charset : 255;

        const state: ConnState = {
            id: id,
            sock: sock,
            opts: opts,
            reader: new MessageReader(),
            phase: 'connecting',
            nextSeq: 0,
            serverCaps: 0,
            effectiveCaps: 0,
            connectionId: 0,
            serverVersion: '',
            isMariaDB: false,
            txnStatus: 'idle',
            startupGate: { resolve: resolve, reject: reject, settled: false },
            pending: null,
            preparedCache: new Map<string, PreparedStatement>(),
            authPlugin: null,
            authCtx: {
                username: opts.user,
                password: opts.password !== undefined ? opts.password : '',
                challenge: Buffer.alloc(0),
                tlsActive: false,
                allowPublicKeyRetrieval:
                    opts.allowPublicKeyRetrieval !== undefined ? opts.allowPublicKeyRetrieval : false,
                scratch: new Map<string, unknown>(),
            },
            warningHandlers: [],
            errorHandlers: [],
            connection: conn,
            dataListener: dataListener,
            deferWrites: FORCE_DEFER_WRITES || !isNodeLike(),
            writeQueue: [],
            writeFlushScheduled: false,
            afterWriteFlush: [],
            pendingHandshake: null,
        };
        // Silence unused-constant warnings for a few imports we'll use in later milestones.
        void maxPacketSize; void charset; void CLIENT_CONNECT_WITH_DB; void CLIENT_CONNECT_ATTRS;
        void hasCap; void hasMoreResults; void MAX_PACKET_PAYLOAD;
        CONN_STATES.set(id, state);

        const connectTimeoutMs = opts.connectTimeoutMs !== undefined ? opts.connectTimeoutMs : 10000;
        let handshakeTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
            failStartup(id, new Error('connection timeout after ' + connectTimeoutMs + 'ms'));
        }, connectTimeoutMs);
        const clearHandshakeTimer = (): void => {
            if (handshakeTimer !== null) {
                clearTimeout(handshakeTimer);
                handshakeTimer = null;
            }
        };

        sock.on('connect', () => {
            onSocketConnect(id);
        });
        sock.on('data', dataListener);
        sock.on('error', (err: Error | string) => {
            clearHandshakeTimer();
            onSocketError(id, err);
        });
        sock.on('close', () => {
            clearHandshakeTimer();
            onSocketClose(id);
        });

        const origResolve = state.startupGate!.resolve;
        const origReject = state.startupGate!.reject;
        state.startupGate!.resolve = (c: Connection) => {
            clearHandshakeTimer();
            origResolve(c);
        };
        state.startupGate!.reject = (e: Error) => {
            clearHandshakeTimer();
            origReject(e);
        };
    });
}

// ─── Socket callbacks ────────────────────────────────────────────────────────

function onSocketConnect(id: number): void {
    const st = CONN_STATES.get(id);
    if (st === undefined) {
        return;
    }
    // MySQL: server speaks first. Nothing to send until HandshakeV10 arrives.
    st.phase = 'auth-handshake';
}

function onSocketData(id: number, chunk: Buffer): void {
    const st = CONN_STATES.get(id);
    if (st === undefined) {
        return;
    }
    const packets = st.reader.feed(chunk);
    for (let i = 0; i < packets.length; i++) {
        handlePacket(id, packets[i].payload, packets[i].seq);
    }
}

function onSocketError(id: number, err: Error | string): void {
    const st = CONN_STATES.get(id);
    if (st === undefined) {
        return;
    }
    const asError = err instanceof Error ? err : new Error(String(err));
    if (st.startupGate !== null && !st.startupGate.settled) {
        failStartup(id, asError);
    }
    if (st.pending !== null) {
        const p = st.pending;
        st.pending = null;
        st.phase = 'closed';
        p.reject(asError);
    }
    for (let i = 0; i < st.errorHandlers.length; i++) {
        st.errorHandlers[i](asError);
    }
}

function onSocketClose(id: number): void {
    const st = CONN_STATES.get(id);
    if (st === undefined) {
        return;
    }
    st.phase = 'closed';
    if (st.startupGate !== null && !st.startupGate.settled) {
        failStartup(id, new Error('connection closed before handshake completed'));
    }
    if (st.pending !== null) {
        const p = st.pending;
        st.pending = null;
        p.reject(new Error('connection closed mid-query'));
    }
    CONN_STATES.delete(id);
}

// ─── Outbound helpers ────────────────────────────────────────────────────────

function sendAuthFrame(st: ConnState, payload: Buffer): void {
    // Auth-phase packets preserve the seq id from the server's last packet + 1.
    const { bytes, nextSeq } = writePacket(st.nextSeq, payload);
    socketWrite(st, bytes);
    st.nextSeq = nextSeq;
}

function sendCommand(st: ConnState, payload: Buffer): void {
    // A new command resets the seq id to 0.
    st.nextSeq = 0;
    const { bytes, nextSeq } = writePacket(0, payload);
    socketWrite(st, bytes);
    st.nextSeq = nextSeq;
}

// ─── Packet dispatch ─────────────────────────────────────────────────────────

function handlePacket(id: number, payload: Buffer, seq: number): void {
    const st = CONN_STATES.get(id);
    if (st === undefined) {
        return;
    }
    // Track seq so our next outbound auth packet lines up. Command packets
    // reset to 0 in sendCommand.
    st.nextSeq = (seq + 1) & 0xFF;

    if (st.phase === 'auth-handshake') {
        handleHandshakeV10(id, payload);
        return;
    }
    if (st.phase === 'auth-response-sent') {
        handleAuthPacket(id, payload);
        return;
    }
    if (st.phase === 'query-simple-columns') {
        handleTextColumnPacket(id, payload);
        return;
    }
    if (st.phase === 'query-simple-rows') {
        handleTextRowPacket(id, payload);
        return;
    }
    if (st.phase === 'query-stmt-prep-ok') {
        handlePrepareOkPacket(id, payload);
        return;
    }
    if (st.phase === 'query-stmt-prep-param-defs') {
        handleStmtParamDefPacket(id, payload);
        return;
    }
    if (st.phase === 'query-stmt-prep-col-defs') {
        handleStmtColumnDefPacket(id, payload);
        return;
    }
    if (st.phase === 'query-stmt-exec-columns') {
        handleStmtExecColumnPacket(id, payload);
        return;
    }
    if (st.phase === 'query-stmt-exec-rows') {
        handleStmtExecRowPacket(id, payload);
        return;
    }
    // Unsolicited packet on an idle connection: surface to 'error' handlers.
    const unsolicited = new Error('unsolicited server packet in phase ' + st.phase);
    for (let i = 0; i < st.errorHandlers.length; i++) {
        st.errorHandlers[i](unsolicited);
    }
}

// ─── Auth handshake ──────────────────────────────────────────────────────────

function handleHandshakeV10(id: number, payload: Buffer): void {
    const st = CONN_STATES.get(id);
    if (st === undefined) {
        return;
    }
    if (isErr(payload)) {
        failStartup(id, new MyError(decodeErrPacket(payload)));
        st.sock.destroy();
        return;
    }
    let h;
    try {
        h = decodeHandshakeV10(payload);
    } catch (e) {
        failStartup(id, e instanceof Error ? e : new Error(String(e)));
        st.sock.destroy();
        return;
    }
    st.serverCaps = h.capabilities;
    // Compute the effective capability set up front — BEFORE SSLRequest —
    // so the SSLRequest and the subsequent HandshakeResponse41 advertise
    // exactly the same caps. MySQL cross-checks the two and rejects
    // connections with errno 1043 ("Bad handshake") if they differ.
    let initialCaps = (DEFAULT_CLIENT_CAPABILITIES & h.capabilities) >>> 0;
    if (st.opts.database === '') {
        initialCaps &= ~CLIENT_CONNECT_WITH_DB;
    }
    if (st.opts.attrs === undefined) {
        initialCaps &= ~CLIENT_CONNECT_ATTRS;
    }
    if (st.opts.multipleStatements === true) {
        initialCaps |= 0x00010000; // CLIENT_MULTI_STATEMENTS
    }
    if (st.opts.localInfile === 'allow-any') {
        initialCaps |= 0x00000080; // CLIENT_LOCAL_FILES
    }
    st.effectiveCaps = initialCaps;
    st.connectionId = h.connectionId;
    st.serverVersion = h.serverVersion;
    st.isMariaDB = h.isMariaDB;
    st.connection.connection_id = h.connectionId;
    st.connection.serverVersion = h.serverVersion;
    st.authCtx.challenge = h.authPluginData;

    // Decide TLS: sslmode !== 'disable' requires CLIENT_SSL on the server side.
    const wantsTls = st.opts.ssl !== undefined && st.opts.ssl.mode !== 'disable';
    if (wantsTls) {
        if ((h.capabilities & CLIENT_SSL) === 0) {
            failStartup(id, new Error("server does not advertise CLIENT_SSL but sslmode='" + st.opts.ssl!.mode + "'"));
            st.sock.destroy();
            return;
        }
        // Cache the handshake; we'll finish it after TLS upgrade.
        st.pendingHandshake = { h: h, seq: st.nextSeq };
        // Detach our 'data' listener BEFORE sending SSLRequest: once the
        // server processes SSLRequest it starts the TLS ServerHello
        // immediately, and we need Node's TLS stack to own the plain
        // socket's byte stream from that moment on.
        if (isNodeLike()) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sockAny = st.sock as any;
            if (typeof sockAny.removeListener === 'function') {
                sockAny.removeListener('data', st.dataListener);
            } else if (typeof sockAny.off === 'function') {
                sockAny.off('data', st.dataListener);
            }
        }
        // Send SSLRequest packet *with the same seq id*.
        const caps = (st.effectiveCaps | CLIENT_SSL) >>> 0;
        st.effectiveCaps = caps;
        const maxPacketSize = st.opts.maxPacketSize !== undefined ? st.opts.maxPacketSize : 64 * 1024 * 1024;
        const charset = st.opts.charset !== undefined ? st.opts.charset : 255;
        const sslReq = writeSSLRequest(caps, maxPacketSize, charset);
        st.phase = 'ssl-upgrading';
        sendAuthFrame(st, sslReq);
        if (st.deferWrites) {
            // SSLRequest is sitting in the write queue. The TLS ClientHello
            // must not reach the wire before it, so start the upgrade only
            // after the queue has flushed.
            st.afterWriteFlush.push(() => { runUpgrade(id); });
        } else {
            runUpgrade(id);
        }
        return;
    }
    sendAuthResponseForPlugin(st, h);
}

/** Fire-and-forget async helper that awaits TLS upgrade, then resumes auth. */
async function runUpgrade(id: number): Promise<void> {
    const st = CONN_STATES.get(id);
    if (st === undefined || st.pendingHandshake === null) {
        return;
    }
    const mode = st.opts.ssl !== undefined ? st.opts.ssl.mode : 'disable';
    const verify = mode === 'verify-ca' || mode === 'verify-full';
    // Plain 'data' listener was detached synchronously in handleHandshakeV10
    // before SSLRequest was written — the bytes that follow on the plain
    // socket belong to the TLS handshake and must go to Node's TLS stack.
    try {
        const newSock = await upgradeToTls(st.sock, { servername: st.opts.host, verify: verify });
        // Mark TLS active for auth plugins that gate on it.
        st.authCtx.tlsActive = true;
        // On Node the upgraded socket is a new object; rewire listeners.
        if (newSock !== st.sock) {
            st.sock = newSock;
            newSock.on('data', st.dataListener);
            newSock.on('error', (err: Error | string) => onSocketError(id, err));
            newSock.on('close', () => onSocketClose(id));
        }
        // Resume the cached handshake over TLS — send HandshakeResponse41.
        const cached = st.pendingHandshake!;
        st.pendingHandshake = null;
        sendAuthResponseForPlugin(st, cached.h);
    } catch (e) {
        failStartup(id, e instanceof Error ? e : new Error(String(e)));
        st.sock.destroy();
    }
}

function sendAuthResponseForPlugin(
    st: ConnState,
    h: import('./protocol/decoder').HandshakeV10,
): void {
    const pluginName = h.authPluginName !== '' ? h.authPluginName : 'mysql_native_password';
    const plugin = getAuthPlugin(pluginName);
    if (plugin === undefined) {
        failStartup(st.id, new Error('server requested unknown auth plugin: ' + pluginName));
        st.sock.destroy();
        return;
    }
    st.authPlugin = plugin;
    let authResp: Buffer;
    try {
        authResp = plugin.initialResponse(st.authCtx);
    } catch (e) {
        failStartup(st.id, e instanceof Error ? e : new Error(String(e)));
        st.sock.destroy();
        return;
    }
    // Capabilities were finalised in handleHandshakeV10 so SSLRequest
    // (if sent) and HandshakeResponse41 agree exactly.
    const maxPacketSize =
        st.opts.maxPacketSize !== undefined ? st.opts.maxPacketSize : 64 * 1024 * 1024;
    const charset = st.opts.charset !== undefined ? st.opts.charset : 255;

    const respPayload = writeHandshakeResponse41({
        capabilities: st.effectiveCaps,
        maxPacketSize: maxPacketSize,
        charset: charset,
        username: st.opts.user,
        authResponse: authResp,
        database: st.opts.database !== '' ? st.opts.database : null,
        authPluginName: plugin.name,
        attrs: st.opts.attrs,
    });
    st.phase = 'auth-response-sent';
    sendAuthFrame(st, respPayload);
}

function handleAuthPacket(id: number, payload: Buffer): void {
    const st = CONN_STATES.get(id);
    if (st === undefined) {
        return;
    }
    if (isOk(payload)) {
        // Handshake complete — extract warnings/status for accounting.
        const ok = decodeOkPacket(payload, st.effectiveCaps);
        st.txnStatus = deriveTxnStatus(ok.statusFlags);
        st.phase = 'ready';
        const gate = st.startupGate;
        if (gate !== null && !gate.settled) {
            gate.settled = true;
            gate.resolve(st.connection);
        }
        return;
    }
    if (isErr(payload)) {
        const err = new MyError(decodeErrPacket(payload));
        failStartup(id, err);
        st.sock.destroy();
        return;
    }
    if (isAuthMoreData(payload)) {
        if (st.authPlugin === null) {
            failStartup(id, new Error('AuthMoreData before any plugin was selected'));
            st.sock.destroy();
            return;
        }
        const data = decodeAuthMoreData(payload);
        const step = handleAuthMoreData(st.authPlugin, st.authCtx, data);
        if (step.kind === 'write') {
            sendAuthFrame(st, step.bytes);
        } else if (step.kind === 'fail') {
            failStartup(id, new Error(step.reason));
            st.sock.destroy();
        }
        // 'ok' → keep waiting for the server's real OK packet.
        return;
    }
    // 0xFE — AuthSwitchRequest.
    if (payload.length > 0 && payload.readUInt8(0) === 0xFE) {
        try {
            const req = decodeAuthSwitchRequest(payload);
            const { plugin, step } = handleAuthSwitch(st.authCtx, req);
            st.authPlugin = plugin;
            if (step.kind === 'write') {
                sendAuthFrame(st, step.bytes);
            } else if (step.kind === 'fail') {
                failStartup(id, new Error(step.reason));
                st.sock.destroy();
            }
        } catch (e) {
            failStartup(id, e instanceof Error ? e : new Error(String(e)));
            st.sock.destroy();
        }
        return;
    }
    failStartup(id, new Error('unexpected packet during auth (first byte 0x' +
        payload.readUInt8(0).toString(16) + ')'));
    st.sock.destroy();
}

function failStartup(id: number, err: Error): void {
    const st = CONN_STATES.get(id);
    if (st === undefined) {
        return;
    }
    const gate = st.startupGate;
    if (gate !== null && !gate.settled) {
        gate.settled = true;
        gate.reject(err);
    }
}

// ─── Text query path (COM_QUERY) ─────────────────────────────────────────────

function runTextQuery(id: number, sql: string): Promise<QueryResult> {
    return new Promise<QueryResult>((resolve, reject) => {
        const st = CONN_STATES.get(id);
        if (st === undefined) {
            reject(new Error('connection already closed'));
            return;
        }
        if (st.phase !== 'ready') {
            reject(new Error('connection is not ready (phase=' + st.phase + ')'));
            return;
        }
        const pending: PendingQuery = {
            resolve: resolve,
            reject: reject,
            textColumnCount: 0,
            fields: [],
            rowsRaw: [],
            stmt: null,
            params: null,
            commandTag: inferCommand(sql),
            rowCount: 0,
            lastInsertId: 0,
            warningCount: 0,
            error: null,
            remainingColumnDefs: 0,
            remainingParamDefs: 0,
            paramFields: [],
            priorResults: [],
            textProtocol: true,
        };
        st.pending = pending;
        st.phase = 'query-simple-columns'; // pivot in handler once we see first packet
        sendCommand(st, writeComQuery(sql));
    });
}

function handleTextColumnPacket(id: number, payload: Buffer): void {
    const st = CONN_STATES.get(id);
    if (st === undefined || st.pending === null) {
        return;
    }
    const pending = st.pending;
    if (isErr(payload)) {
        failPending(st, new MyError(decodeErrPacket(payload)));
        return;
    }
    // First packet of the response is either OK (no resultset), a
    // LOCAL_INFILE request (0xFB + filename), or a column count.
    if (pending.fields.length === 0 && pending.textColumnCount === 0) {
        if (isOk(payload)) {
            const ok = decodeOkPacket(payload, st.effectiveCaps);
            finishOk(st, ok);
            return;
        }
        if (payload.length > 0 && payload.readUInt8(0) === 0xFB) {
            handleLocalInfileRequest(st, payload);
            return;
        }
        pending.textColumnCount = decodeColumnCount(payload);
        pending.remainingColumnDefs = pending.textColumnCount;
        return;
    }
    // Collecting column definitions.
    if (pending.remainingColumnDefs > 0) {
        pending.fields.push(decodeColumnDefinition41(payload));
        pending.remainingColumnDefs -= 1;
        if (pending.remainingColumnDefs === 0) {
            // If server doesn't deprecate EOF, a dummy EOF follows before rows.
            if (!hasCap(st.effectiveCaps, 0x01000000)) {
                // Wait for the EOF by staying in this phase; handle below.
                return;
            }
            st.phase = 'query-simple-rows';
        }
        return;
    }
    // Expecting the pre-row EOF (when DEPRECATE_EOF not active).
    if (isEof(payload)) {
        st.phase = 'query-simple-rows';
    }
}

function handleTextRowPacket(id: number, payload: Buffer): void {
    const st = CONN_STATES.get(id);
    if (st === undefined || st.pending === null) {
        return;
    }
    const pending = st.pending;
    if (isErr(payload)) {
        failPending(st, new MyError(decodeErrPacket(payload)));
        return;
    }
    // End-of-rows marker: either EOF (old style) or OK (CLIENT_DEPRECATE_EOF).
    const first = payload.readUInt8(0);
    const depEof = hasCap(st.effectiveCaps, 0x01000000);
    const isEndMarker = (depEof && first === 0xFE) || (!depEof && isEof(payload));
    if (isEndMarker) {
        let warningCount = 0;
        let statusFlags = 0;
        if (hasCap(st.effectiveCaps, 0x01000000)) {
            const ok = decodeOkPacket(payload, st.effectiveCaps);
            warningCount = ok.warningCount;
            statusFlags = ok.statusFlags;
        } else {
            const eof = decodeEofPacket(payload);
            warningCount = eof.warningCount;
            statusFlags = eof.statusFlags;
        }
        pending.warningCount = warningCount;
        st.txnStatus = deriveTxnStatus(statusFlags);
        finishResultset(st, statusFlags);
        return;
    }
    pending.rowsRaw.push(decodeTextResultsetRow(payload, pending.textColumnCount));
}

function finishResultset(st: ConnState, statusFlags: number): void {
    const pending = st.pending;
    if (pending === null) {
        return;
    }
    if ((statusFlags & 0x0008) !== 0 /* SERVER_MORE_RESULTS_EXISTS */) {
        const snap = buildResult(pending, !pending.textProtocol);
        pending.priorResults.push(snap);
        resetForNextResultset(pending, st);
        return;
    }
    st.pending = null;
    st.phase = 'ready';
    const result = assembleFinalResult(pending, !pending.textProtocol);
    notifyWarningsFor(st, result);
    pending.resolve(result);
}

function finishOk(st: ConnState, ok: {
    affectedRows: number | bigint;
    lastInsertId: number | bigint;
    warningCount: number;
    statusFlags: number;
}): void {
    const pending = st.pending;
    if (pending === null) {
        return;
    }
    pending.rowCount = typeof ok.affectedRows === 'bigint' ? Number(ok.affectedRows) : ok.affectedRows;
    pending.lastInsertId = ok.lastInsertId;
    pending.warningCount = ok.warningCount;
    st.txnStatus = deriveTxnStatus(ok.statusFlags);
    if ((ok.statusFlags & 0x0008) !== 0 /* SERVER_MORE_RESULTS_EXISTS */) {
        const snap = buildResult(pending, /* binary= */ !pending.textProtocol);
        pending.priorResults.push(snap);
        resetForNextResultset(pending, st);
        return;
    }
    st.pending = null;
    st.phase = 'ready';
    const result = assembleFinalResult(pending, /* binary= */ !pending.textProtocol);
    notifyWarningsFor(st, result);
    pending.resolve(result);
}

function resetForNextResultset(pending: PendingQuery, st: ConnState): void {
    pending.textColumnCount = 0;
    pending.fields = [];
    pending.rowsRaw = [];
    pending.remainingColumnDefs = 0;
    pending.rowCount = 0;
    pending.lastInsertId = 0;
    pending.warningCount = 0;
    // Text protocol → back to column phase; binary (prepared) → exec column phase.
    st.phase = pending.textProtocol ? 'query-simple-columns' : 'query-stmt-exec-columns';
}

function assembleFinalResult(pending: PendingQuery, binary: boolean): QueryResult {
    const last = buildResult(pending, binary);
    if (pending.priorResults.length === 0) {
        return last;
    }
    const all = pending.priorResults.slice();
    all.push(last);
    // Return the LAST result as the primary (matches mysql2's behaviour),
    // with every result accessible via `resultSets`.
    last.resultSets = all;
    return last;
}

/** Fire warning summary to any attached listener. Idempotent. */
function notifyWarningsFor(st: ConnState, result: QueryResult): void {
    if (result.resultSets !== undefined) {
        // Sum across all result-sets for multi-statement queries.
        let total = 0;
        for (let i = 0; i < result.resultSets.length; i++) {
            total += result.resultSets[i].warningCount;
        }
        emitWarningSummary(st, total);
        return;
    }
    emitWarningSummary(st, result.warningCount);
}

function handleLocalInfileRequest(st: ConnState, payload: Buffer): void {
    const filename = payload.toString('utf8', 1);
    // Default: refuse. Send an empty packet to terminate the request; the
    // server then sends an ERR which we'll surface naturally.
    if (st.opts.localInfile !== 'allow-any') {
        const { bytes } = writePacket(st.nextSeq, Buffer.alloc(0));
        socketWrite(st, bytes);
        st.nextSeq = (st.nextSeq + 1) & 0xFF;
        // Pre-fail: we know the server will ERR, but give a specific error now.
        failPending(st, new MyError({
            errno: 2000 /* client-side synthetic */,
            sqlState: 'HY000',
            serverMessage: "LOCAL INFILE disabled (server requested '" + filename + "'). Pass localInfile: 'allow-any' if you trust the server.",
        }));
        return;
    }
    // allow-any: still refuse unless a handler is wired. For now we
    // send an empty packet so the connection doesn't wedge, and let
    // the server ERR back.
    const { bytes } = writePacket(st.nextSeq, Buffer.alloc(0));
    socketWrite(st, bytes);
    st.nextSeq = (st.nextSeq + 1) & 0xFF;
}

function failPending(st: ConnState, err: MyError): void {
    const pending = st.pending;
    if (pending === null) {
        return;
    }
    st.pending = null;
    st.phase = 'ready';
    pending.reject(err);
}

// ─── Prepared query path (COM_STMT_PREPARE / COM_STMT_EXECUTE) ──────────────

function runPreparedQuery(id: number, sql: string, params: unknown[]): Promise<QueryResult> {
    return new Promise<QueryResult>((resolve, reject) => {
        const st = CONN_STATES.get(id);
        if (st === undefined) {
            reject(new Error('connection already closed'));
            return;
        }
        if (st.phase !== 'ready') {
            reject(new Error('connection is not ready (phase=' + st.phase + ')'));
            return;
        }
        const cached = st.preparedCache.get(sql);
        const pending: PendingQuery = {
            resolve: resolve,
            reject: reject,
            textColumnCount: 0,
            fields: [],
            rowsRaw: [],
            stmt: cached !== undefined ? cached : null,
            params: params,
            commandTag: inferCommand(sql),
            rowCount: 0,
            lastInsertId: 0,
            warningCount: 0,
            error: null,
            remainingColumnDefs: 0,
            remainingParamDefs: 0,
            paramFields: [],
            priorResults: [],
            textProtocol: false,
        };
        st.pending = pending;
        if (cached !== undefined) {
            executePreparedNow(st, cached, params);
            return;
        }
        st.phase = 'query-stmt-prep-ok';
        pending.stmt = {
            sql: sql,
            stmtId: 0,
            numColumns: 0,
            numParams: 0,
            paramFields: [],
            columnFields: [],
        };
        sendCommand(st, writeComStmtPrepare(sql));
    });
}

function handlePrepareOkPacket(id: number, payload: Buffer): void {
    const st = CONN_STATES.get(id);
    if (st === undefined || st.pending === null) {
        return;
    }
    const pending = st.pending;
    if (isErr(payload)) {
        failPending(st, new MyError(decodeErrPacket(payload)));
        return;
    }
    if (!isOk(payload)) {
        failPending(st, wireError('expected PrepareOK (0x00), got 0x' + payload.readUInt8(0).toString(16)));
        return;
    }
    const ok = decodePrepareOK(payload);
    const stmt = pending.stmt!;
    stmt.stmtId = ok.stmtId;
    stmt.numColumns = ok.numColumns;
    stmt.numParams = ok.numParams;
    pending.remainingParamDefs = ok.numParams;
    pending.remainingColumnDefs = ok.numColumns;
    if (ok.numParams > 0) {
        st.phase = 'query-stmt-prep-param-defs';
    } else if (ok.numColumns > 0) {
        st.phase = 'query-stmt-prep-col-defs';
    } else {
        // No params and no columns → prepare complete, execute now.
        st.preparedCache.set(stmt.sql, stmt);
        executePreparedNow(st, stmt, pending.params!);
    }
}

function handleStmtParamDefPacket(id: number, payload: Buffer): void {
    const st = CONN_STATES.get(id);
    if (st === undefined || st.pending === null) {
        return;
    }
    const pending = st.pending;
    if (isEof(payload) && pending.remainingParamDefs === 0) {
        // Trailing EOF marker (only when DEPRECATE_EOF not active).
        if (pending.stmt!.numColumns > 0) {
            st.phase = 'query-stmt-prep-col-defs';
        } else {
            st.preparedCache.set(pending.stmt!.sql, pending.stmt!);
            executePreparedNow(st, pending.stmt!, pending.params!);
        }
        return;
    }
    if (pending.remainingParamDefs > 0) {
        pending.paramFields.push(decodeColumnDefinition41(payload));
        pending.remainingParamDefs -= 1;
        if (pending.remainingParamDefs === 0 && hasCap(st.effectiveCaps, 0x01000000)) {
            // No trailing EOF under DEPRECATE_EOF — jump straight to the next phase.
            pending.stmt!.paramFields = pending.paramFields;
            if (pending.stmt!.numColumns > 0) {
                st.phase = 'query-stmt-prep-col-defs';
            } else {
                st.preparedCache.set(pending.stmt!.sql, pending.stmt!);
                executePreparedNow(st, pending.stmt!, pending.params!);
            }
        } else if (pending.remainingParamDefs === 0) {
            // Waiting for trailing EOF; stay in this phase.
            pending.stmt!.paramFields = pending.paramFields;
        }
    }
}

function handleStmtColumnDefPacket(id: number, payload: Buffer): void {
    const st = CONN_STATES.get(id);
    if (st === undefined || st.pending === null) {
        return;
    }
    const pending = st.pending;
    if (isEof(payload) && pending.remainingColumnDefs === 0) {
        // Trailing EOF (old-style). Prepare is done — execute.
        pending.stmt!.columnFields = pending.fields;
        st.preparedCache.set(pending.stmt!.sql, pending.stmt!);
        executePreparedNow(st, pending.stmt!, pending.params!);
        return;
    }
    if (pending.remainingColumnDefs > 0) {
        pending.fields.push(decodeColumnDefinition41(payload));
        pending.remainingColumnDefs -= 1;
        if (pending.remainingColumnDefs === 0 && hasCap(st.effectiveCaps, 0x01000000)) {
            pending.stmt!.columnFields = pending.fields;
            st.preparedCache.set(pending.stmt!.sql, pending.stmt!);
            executePreparedNow(st, pending.stmt!, pending.params!);
        } else if (pending.remainingColumnDefs === 0) {
            pending.stmt!.columnFields = pending.fields;
        }
    }
}

function executePreparedNow(st: ConnState, stmt: PreparedStatement, params: unknown[]): void {
    // Reset the pending query to its pre-execute state; keep resolve/reject.
    const pending = st.pending!;
    pending.fields = stmt.columnFields;
    pending.rowsRaw = [];
    pending.textColumnCount = stmt.numColumns;
    pending.remainingColumnDefs = stmt.numColumns;
    pending.rowCount = 0;
    pending.lastInsertId = 0;
    pending.warningCount = 0;

    if (params.length !== stmt.numParams) {
        failPending(st, wireError(
            'param count mismatch: stmt expects ' + stmt.numParams + ', got ' + params.length
        ));
        return;
    }
    // Encode params.
    const nulls = new Array<boolean>(params.length);
    const paramTypes: Array<{ typeCode: number; unsigned: boolean }> = [];
    const chunks: Buffer[] = [];
    for (let i = 0; i < params.length; i++) {
        const { typeCode, unsigned, bytes, isNull } = encodeParam(params[i]);
        nulls[i] = isNull;
        paramTypes.push({ typeCode: typeCode, unsigned: unsigned });
        if (!isNull) {
            chunks.push(bytes);
        }
    }
    const nullBitmap = buildParamNullBitmap(nulls);
    const paramBytes = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    const payload = writeComStmtExecute(
        stmt.stmtId,
        STMT_EXECUTE_FLAG_NO_CURSOR,
        nullBitmap,
        paramTypes,
        paramBytes,
    );
    // Always start in the exec-columns phase: the first server packet is
    // either an OK (no resultset — INSERT/UPDATE/DELETE) or a column count
    // (resultset incoming). handleStmtExecColumnPacket handles both.
    st.phase = 'query-stmt-exec-columns';
    // Clear prior fields so the column-def collector repopulates from
    // the server's actual response (stmt.columnFields was a pre-execute
    // hint from COM_STMT_PREPARE).
    pending.fields = [];
    pending.textColumnCount = 0;
    pending.remainingColumnDefs = 0;
    sendCommand(st, payload);
}

function handleStmtExecColumnPacket(id: number, payload: Buffer): void {
    const st = CONN_STATES.get(id);
    if (st === undefined || st.pending === null) {
        return;
    }
    const pending = st.pending;
    if (isErr(payload)) {
        failPending(st, new MyError(decodeErrPacket(payload)));
        return;
    }
    if (pending.fields.length === 0 && pending.textColumnCount === 0) {
        if (isOk(payload)) {
            const ok = decodeOkPacket(payload, st.effectiveCaps);
            finishOk(st, ok);
            return;
        }
        pending.textColumnCount = decodeColumnCount(payload);
        pending.remainingColumnDefs = pending.textColumnCount;
        return;
    }
    if (pending.remainingColumnDefs > 0) {
        pending.fields.push(decodeColumnDefinition41(payload));
        pending.remainingColumnDefs -= 1;
        if (pending.remainingColumnDefs === 0) {
            if (hasCap(st.effectiveCaps, 0x01000000)) {
                st.phase = 'query-stmt-exec-rows';
            }
            // Else wait for a trailing EOF in this phase.
        }
        return;
    }
    if (isEof(payload)) {
        st.phase = 'query-stmt-exec-rows';
    }
}

function handleStmtExecRowPacket(id: number, payload: Buffer): void {
    const st = CONN_STATES.get(id);
    if (st === undefined || st.pending === null) {
        return;
    }
    const pending = st.pending;
    if (isErr(payload)) {
        failPending(st, new MyError(decodeErrPacket(payload)));
        return;
    }
    const first = payload.readUInt8(0);
    // Binary rows always start with 0x00. End-of-rows is a 0xFE-prefixed
    // packet — parsed as OK (DEPRECATE_EOF active) or EOF (otherwise).
    if (first === 0xFE) {
        let warningCount = 0;
        let statusFlags = 0;
        if (hasCap(st.effectiveCaps, 0x01000000)) {
            const ok = decodeOkPacket(payload, st.effectiveCaps);
            warningCount = ok.warningCount;
            statusFlags = ok.statusFlags;
        } else {
            const eof = decodeEofPacket(payload);
            warningCount = eof.warningCount;
            statusFlags = eof.statusFlags;
        }
        pending.warningCount = warningCount;
        st.txnStatus = deriveTxnStatus(statusFlags);
        finishResultset(st, statusFlags);
        return;
    }
    pending.rowsRaw.push(decodeBinaryResultsetRow(payload, pending.fields));
}

// ─── Param encoding (M4 minimal — M5 will replace with codec registry) ─────

interface EncodedParam {
    typeCode: number;
    unsigned: boolean;
    bytes: Buffer;
    isNull: boolean;
}

/** Duck-type `Buffer`. Perry-compatible (avoids `Buffer.isBuffer` which
 *  perry-codegen hasn't lowered yet). Works on Node/Bun: a real Buffer
 *  has a `readUInt8` method and a `length` property. */
function isBufferLike(v: unknown): boolean {
    if (v === null || typeof v !== 'object') {
        return false;
    }
    const anyV = v as { readUInt8?: unknown; length?: unknown };
    return typeof anyV.readUInt8 === 'function' && typeof anyV.length === 'number';
}

function encodeParam(v: unknown): EncodedParam {
    if (v === null || v === undefined) {
        return { typeCode: 0x06 /* NULL */, unsigned: false, bytes: Buffer.alloc(0), isNull: true };
    }
    if (typeof v === 'boolean') {
        const out = Buffer.alloc(1);
        out.writeUInt8(v ? 1 : 0, 0);
        return { typeCode: 0x01 /* TINY */, unsigned: true, bytes: out, isNull: false };
    }
    if (typeof v === 'number') {
        if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) {
            const out = Buffer.alloc(4);
            out.writeInt32LE(v, 0);
            return { typeCode: 0x03 /* LONG */, unsigned: false, bytes: out, isNull: false };
        }
        const out = Buffer.alloc(8);
        out.writeDoubleLE(v, 0);
        return { typeCode: 0x05 /* DOUBLE */, unsigned: false, bytes: out, isNull: false };
    }
    if (typeof v === 'bigint') {
        const out = Buffer.alloc(8);
        out.writeBigInt64LE(v, 0);
        return { typeCode: 0x08 /* LONGLONG */, unsigned: false, bytes: out, isNull: false };
    }
    if (typeof v === 'string') {
        const sb = Buffer.from(v, 'utf8');
        // Lenenc-string-encoded value for VAR_STRING (0xFD).
        const out = lenencStringBytes(sb);
        return { typeCode: 0xFD /* VAR_STRING */, unsigned: false, bytes: out, isNull: false };
    }
    if (isBufferLike(v)) {
        const out = lenencStringBytes(v as Buffer);
        return { typeCode: 0xFC /* BLOB */, unsigned: false, bytes: out, isNull: false };
    }
    // Fallback: toString + VAR_STRING.
    const sb = Buffer.from(String(v), 'utf8');
    const out = lenencStringBytes(sb);
    return { typeCode: 0xFD, unsigned: false, bytes: out, isNull: false };
}

/** Lenenc-int length prefix + raw bytes. Caller passes a Buffer payload. */
function lenencStringBytes(payload: Buffer): Buffer {
    const len = payload.length;
    if (len < 251) {
        const out = Buffer.alloc(1 + len);
        out.writeUInt8(len, 0);
        payload.copy(out, 1);
        return out;
    }
    if (len < 65536) {
        const out = Buffer.alloc(3 + len);
        out.writeUInt8(0xFC, 0);
        out.writeUInt16LE(len, 1);
        payload.copy(out, 3);
        return out;
    }
    if (len < 16777216) {
        const out = Buffer.alloc(4 + len);
        out.writeUInt8(0xFD, 0);
        out.writeUInt8(len & 0xFF, 1);
        out.writeUInt8((len >>> 8) & 0xFF, 2);
        out.writeUInt8((len >>> 16) & 0xFF, 3);
        payload.copy(out, 4);
        return out;
    }
    const out = Buffer.alloc(9 + len);
    out.writeUInt8(0xFE, 0);
    out.writeBigUInt64LE(BigInt(len), 1);
    payload.copy(out, 9);
    return out;
}

// ─── Result assembly + convenience ──────────────────────────────────────────

function emitWarningSummary(st: ConnState, count: number): void {
    if (count <= 0 || st.warningHandlers.length === 0) {
        return;
    }
    const w: MyWarning = {
        level: 'summary',
        code: 0,
        message: count + ' warning(s) reported by the last statement; call SHOW WARNINGS for details',
        count: count,
    };
    for (let i = 0; i < st.warningHandlers.length; i++) {
        try { st.warningHandlers[i](w); } catch (_e) { /* ignore */ }
    }
}

function buildResult(pending: PendingQuery, binary: boolean): QueryResult {
    const fields = pending.fields;
    const rowsRaw = pending.rowsRaw;
    const format: WireFormat = binary ? FORMAT_BINARY : FORMAT_TEXT;
    // Resolve one decoder per column — avoids a registry lookup per cell.
    const decoders: Array<(buf: Buffer) => unknown> = new Array(fields.length);
    for (let c = 0; c < fields.length; c++) {
        decoders[c] = pickDecoder(fields[c], format);
    }
    const rowsArray: unknown[][] = new Array<unknown[]>(rowsRaw.length);
    const rows: Record<string, unknown>[] = new Array<Record<string, unknown>>(rowsRaw.length);
    for (let r = 0; r < rowsRaw.length; r++) {
        const raw = rowsRaw[r];
        const arr: unknown[] = new Array<unknown>(raw.length);
        const obj: Record<string, unknown> = {};
        for (let c = 0; c < raw.length; c++) {
            const cell = raw[c];
            const decoded = cell === null ? null : decoders[c](cell);
            arr[c] = decoded;
            obj[fields[c].name] = decoded;
        }
        rowsArray[r] = arr;
        rows[r] = obj;
    }
    return {
        fields: fields,
        rows: rows,
        rowsArray: rowsArray,
        rowsRaw: rowsRaw,
        command: pending.commandTag,
        rowCount: rowsRaw.length > 0 ? rowsRaw.length : pending.rowCount,
        lastInsertId: pending.lastInsertId,
        warningCount: pending.warningCount,
    };
}

function inferCommand(sql: string): string {
    // Quick & dirty: first alphabetic run, uppercased. Good enough for
    // the `command` field in QueryResult — not user-facing.
    let i = 0;
    while (i < sql.length) {
        const c = sql.charCodeAt(i);
        if ((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A)) {
            break;
        }
        i++;
    }
    let j = i;
    while (j < sql.length) {
        const c = sql.charCodeAt(j);
        if ((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A)) {
            j++;
        } else {
            break;
        }
    }
    return sql.substring(i, j).toUpperCase();
}

function wireError(msg: string): MyError {
    return new MyError({ errno: 0, sqlState: 'HY000', serverMessage: msg });
}

// ─── Close ───────────────────────────────────────────────────────────────────

/**
 * True when the input has all four required `ConnectOptions` fields.
 * Otherwise `resolveConnectOptions` fills the gaps from env / URL.
 */
function isFullyResolved(input: ConnectOptions | ResolveOptionsInput): boolean {
    const o = input as Partial<ConnectOptions>;
    return (
        typeof o.host === 'string'
        && typeof o.port === 'number'
        && typeof o.user === 'string'
        && typeof o.database === 'string'
        && (input as { url?: unknown }).url === undefined
    );
}

function closeConnection(id: number): Promise<void> {
    return new Promise<void>((resolve) => {
        const st = CONN_STATES.get(id);
        if (st === undefined) {
            resolve();
            return;
        }
        try {
            sendCommand(st, writeComQuit());
        } catch (_) {
            // Socket may already be dead; fall through.
        }
        st.phase = 'closed';
        // Give the server a tick to process COM_QUIT, then tear down.
        setTimeout(() => {
            try {
                st.sock.end();
            } catch (_e) {
                // ignore
            }
            CONN_STATES.delete(id);
            resolve();
        }, 10);
    });
}
