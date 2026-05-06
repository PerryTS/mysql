// MySQL / MariaDB CLIENT_* capability flag bits.
//
// The capability bitmap is exchanged in two halves during HandshakeV10:
//   - lower 16 bits after the auth-plugin-data-part-1
//   - upper 16 bits after the charset byte + status flags
//
// The client echoes a 32-bit subset in HandshakeResponse41 to tell the
// server which features it intends to use. The effective capability set is
// the intersection of client-declared and server-declared bits.
//
// MariaDB reuses the upper 32 bits of a 64-bit capabilities field for its
// own extensions; those are handled in a separate `capabilitiesMariaDB`
// module when we need them. For M1-M6 we stay inside the standard 32-bit
// MySQL capability space.
//
// References:
//   https://dev.mysql.com/doc/dev/mysql-server/latest/group__group__cs__capabilities__flags.html
//   https://mariadb.com/kb/en/connection/

export const CLIENT_LONG_PASSWORD                  = 0x00000001;
export const CLIENT_FOUND_ROWS                     = 0x00000002;
export const CLIENT_LONG_FLAG                      = 0x00000004;
export const CLIENT_CONNECT_WITH_DB                = 0x00000008;
export const CLIENT_NO_SCHEMA                      = 0x00000010;
export const CLIENT_COMPRESS                       = 0x00000020; // not supported in v0.1
export const CLIENT_ODBC                           = 0x00000040; // deprecated
export const CLIENT_LOCAL_FILES                    = 0x00000080;
export const CLIENT_IGNORE_SPACE                   = 0x00000100;
export const CLIENT_PROTOCOL_41                    = 0x00000200;
export const CLIENT_INTERACTIVE                    = 0x00000400;
export const CLIENT_SSL                            = 0x00000800;
export const CLIENT_IGNORE_SIGPIPE                 = 0x00001000;
export const CLIENT_TRANSACTIONS                   = 0x00002000;
export const CLIENT_RESERVED                       = 0x00004000;
export const CLIENT_SECURE_CONNECTION              = 0x00008000;
export const CLIENT_MULTI_STATEMENTS               = 0x00010000;
export const CLIENT_MULTI_RESULTS                  = 0x00020000;
export const CLIENT_PS_MULTI_RESULTS               = 0x00040000;
export const CLIENT_PLUGIN_AUTH                    = 0x00080000;
export const CLIENT_CONNECT_ATTRS                  = 0x00100000;
export const CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA = 0x00200000;
export const CLIENT_CAN_HANDLE_EXPIRED_PASSWORDS   = 0x00400000;
export const CLIENT_SESSION_TRACK                  = 0x00800000;
export const CLIENT_DEPRECATE_EOF                  = 0x01000000;
export const CLIENT_OPTIONAL_RESULTSET_METADATA    = 0x02000000;
export const CLIENT_ZSTD_COMPRESSION_ALGORITHM     = 0x04000000;
export const CLIENT_QUERY_ATTRIBUTES               = 0x08000000;
export const MULTI_FACTOR_AUTHENTICATION           = 0x10000000;
export const CLIENT_CAPABILITY_EXTENSION           = 0x20000000;
export const CLIENT_SSL_VERIFY_SERVER_CERT         = 0x40000000;
export const CLIENT_REMEMBER_OPTIONS               = 0x80000000 >>> 0;

/**
 * Default capability set the driver declares. Conservative on dangerous
 * features (no MULTI_STATEMENTS, no LOCAL_FILES, no COMPRESS), aggressive
 * on the protocol features we rely on.
 *
 * Uses `| 0` at the end to coerce to int32 so downstream `writeUInt32LE`
 * doesn't choke on out-of-range signed values.
 */
export const DEFAULT_CLIENT_CAPABILITIES = (
    CLIENT_LONG_PASSWORD
    | CLIENT_LONG_FLAG
    | CLIENT_CONNECT_WITH_DB
    | CLIENT_PROTOCOL_41
    | CLIENT_TRANSACTIONS
    | CLIENT_SECURE_CONNECTION
    | CLIENT_MULTI_RESULTS
    | CLIENT_PS_MULTI_RESULTS
    | CLIENT_PLUGIN_AUTH
    | CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA
    | CLIENT_CONNECT_ATTRS
    | CLIENT_SESSION_TRACK
    | CLIENT_DEPRECATE_EOF
) >>> 0;

/** True if the given bit is set in `caps`. */
export function hasCap(caps: number, bit: number): boolean {
    return (caps & bit) !== 0;
}
