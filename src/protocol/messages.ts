// MySQL / MariaDB wire protocol constants.
//
// Command byte (first byte of a client → server packet after the
// 3-byte length + 1-byte seq id header) and the packet-tag bytes that
// identify server-pushed packets (OK, ERR, EOF, AuthMoreData,
// AuthSwitchRequest, LOCAL_INFILE).
//
// References:
//   MySQL 8 — https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol.html
//   MariaDB — https://mariadb.com/kb/en/clientserver-protocol/

// ─── Client → server command bytes (first byte of COM_* packet) ──────────────

export const COM_SLEEP               = 0x00; // server-internal, never sent by client
export const COM_QUIT                = 0x01;
export const COM_INIT_DB             = 0x02;
export const COM_QUERY               = 0x03;
export const COM_FIELD_LIST          = 0x04; // deprecated
export const COM_CREATE_DB           = 0x05; // deprecated
export const COM_DROP_DB             = 0x06; // deprecated
export const COM_REFRESH             = 0x07;
export const COM_SHUTDOWN            = 0x08;
export const COM_STATISTICS          = 0x09;
export const COM_PROCESS_INFO        = 0x0A; // deprecated
export const COM_CONNECT             = 0x0B; // server-internal
export const COM_PROCESS_KILL        = 0x0C;
export const COM_DEBUG               = 0x0D;
export const COM_PING                = 0x0E;
export const COM_TIME                = 0x0F; // server-internal
export const COM_DELAYED_INSERT      = 0x10; // server-internal
export const COM_CHANGE_USER         = 0x11;
export const COM_BINLOG_DUMP         = 0x12;
export const COM_TABLE_DUMP          = 0x13;
export const COM_CONNECT_OUT         = 0x14; // server-internal
export const COM_REGISTER_SLAVE      = 0x15;
export const COM_STMT_PREPARE        = 0x16;
export const COM_STMT_EXECUTE        = 0x17;
export const COM_STMT_SEND_LONG_DATA = 0x18;
export const COM_STMT_CLOSE          = 0x19;
export const COM_STMT_RESET          = 0x1A;
export const COM_SET_OPTION          = 0x1B;
export const COM_STMT_FETCH          = 0x1C;
export const COM_DAEMON              = 0x1D; // server-internal
export const COM_BINLOG_DUMP_GTID    = 0x1E;
export const COM_RESET_CONNECTION    = 0x1F;

// ─── Server → client packet tag bytes (first byte of packet payload) ────────

/** OK packet — command succeeded, no (or done with) resultset. */
export const PACKET_OK              = 0x00;
/**
 * EOF (pre-`CLIENT_DEPRECATE_EOF`), OR AuthSwitchRequest during auth, OR
 * LOCAL INFILE request during resultset. Disambiguate by (state, length).
 */
export const PACKET_EOF             = 0xFE;
/** ERR packet — command failed. */
export const PACKET_ERR             = 0xFF;
/** AuthMoreData packet during auth state (caching_sha2, sha256, ...). */
export const PACKET_AUTH_MORE_DATA  = 0x01;
/** LOCAL_INFILE request sentinel within resultset state (== PACKET_EOF). */
export const PACKET_LOCAL_INFILE    = 0xFB;

// ─── Stmt execute iteration flag field (COM_STMT_EXECUTE second arg) ────────

/** CURSOR_TYPE_NO_CURSOR — the normal non-cursored execute. */
export const CURSOR_TYPE_NO_CURSOR  = 0x00;
export const CURSOR_TYPE_READ_ONLY  = 0x01;
export const CURSOR_TYPE_FOR_UPDATE = 0x02;
export const CURSOR_TYPE_SCROLLABLE = 0x04;

// ─── caching_sha2_password AuthMoreData sub-markers ─────────────────────────

/** Fast-auth success: server recognized cached credential, wait for OK. */
export const CACHING_SHA2_FAST_AUTH_SUCCESS = 0x03;
/** Perform full-auth: send cleartext (if TLS) or request pubkey. */
export const CACHING_SHA2_PERFORM_FULL_AUTH = 0x04;
/** Client → server: request the server's RSA public key. */
export const CACHING_SHA2_REQUEST_PUBLIC_KEY = 0x02;

// ─── HandshakeV10 capability-negotiation constants ──────────────────────────

/** Handshake protocol version byte for the modern protocol. */
export const HANDSHAKE_PROTOCOL_V10 = 0x0A;
/** Legacy; not supported. */
export const HANDSHAKE_PROTOCOL_V9  = 0x09;

/** Maximum packet payload body size (24-bit length field max value). */
export const MAX_PACKET_PAYLOAD = 0xFFFFFF; // 16 777 215 bytes
