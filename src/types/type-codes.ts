// MYSQL_TYPE_* constants and column-flag bits.
//
// Reference: https://dev.mysql.com/doc/dev/mysql-server/latest/field__types_8h.html
// The type code is a single byte in every ColumnDefinition41 and a single
// byte per param in COM_STMT_EXECUTE. The flags word (u16) accompanies it
// in ColumnDefinition41 — UNSIGNED_FLAG / BINARY_FLAG / etc. disambiguate
// some JS decoding choices (int unsigned vs signed, VARCHAR binary vs text).

export const MYSQL_TYPE_DECIMAL      = 0x00;
export const MYSQL_TYPE_TINY         = 0x01;
export const MYSQL_TYPE_SHORT        = 0x02;
export const MYSQL_TYPE_LONG         = 0x03;
export const MYSQL_TYPE_FLOAT        = 0x04;
export const MYSQL_TYPE_DOUBLE       = 0x05;
export const MYSQL_TYPE_NULL         = 0x06;
export const MYSQL_TYPE_TIMESTAMP    = 0x07;
export const MYSQL_TYPE_LONGLONG     = 0x08;
export const MYSQL_TYPE_INT24        = 0x09;
export const MYSQL_TYPE_DATE         = 0x0A;
export const MYSQL_TYPE_TIME         = 0x0B;
export const MYSQL_TYPE_DATETIME     = 0x0C;
export const MYSQL_TYPE_YEAR         = 0x0D;
export const MYSQL_TYPE_NEWDATE      = 0x0E; // internal, rarely on-wire
export const MYSQL_TYPE_VARCHAR      = 0x0F;
export const MYSQL_TYPE_BIT          = 0x10;
export const MYSQL_TYPE_TIMESTAMP2   = 0x11; // internal
export const MYSQL_TYPE_DATETIME2    = 0x12; // internal
export const MYSQL_TYPE_TIME2        = 0x13; // internal
export const MYSQL_TYPE_TYPED_ARRAY  = 0x14;
export const MYSQL_TYPE_VECTOR       = 0xF2; // MySQL 9.0+
export const MYSQL_TYPE_JSON         = 0xF5;
export const MYSQL_TYPE_NEWDECIMAL   = 0xF6;
export const MYSQL_TYPE_ENUM         = 0xF7;
export const MYSQL_TYPE_SET          = 0xF8;
export const MYSQL_TYPE_TINY_BLOB    = 0xF9;
export const MYSQL_TYPE_MEDIUM_BLOB  = 0xFA;
export const MYSQL_TYPE_LONG_BLOB    = 0xFB;
export const MYSQL_TYPE_BLOB         = 0xFC;
export const MYSQL_TYPE_VAR_STRING   = 0xFD;
export const MYSQL_TYPE_STRING       = 0xFE;
export const MYSQL_TYPE_GEOMETRY     = 0xFF;

// ─── Field flags (u16 in ColumnDefinition41) ─────────────────────────────────

export const NOT_NULL_FLAG        = 0x0001;
export const PRI_KEY_FLAG         = 0x0002;
export const UNIQUE_KEY_FLAG      = 0x0004;
export const MULTIPLE_KEY_FLAG    = 0x0008;
export const BLOB_FLAG            = 0x0010;
export const UNSIGNED_FLAG        = 0x0020;
export const ZEROFILL_FLAG        = 0x0040;
export const BINARY_FLAG          = 0x0080;
export const ENUM_FLAG            = 0x0100;
export const AUTO_INCREMENT_FLAG  = 0x0200;
export const TIMESTAMP_FLAG       = 0x0400;
export const SET_FLAG             = 0x0800;
export const NO_DEFAULT_VALUE_FLAG = 0x1000;
export const ON_UPDATE_NOW_FLAG   = 0x2000;
export const NUM_FLAG             = 0x8000;

/** True iff the column flags say this is a binary string (BLOB / BINARY / VARBINARY). */
export function isBinaryCollation(flags: number, collation: number): boolean {
    if ((flags & BINARY_FLAG) !== 0 || (flags & BLOB_FLAG) !== 0) {
        return true;
    }
    // `binary` collation id.
    return collation === 63;
}

// ─── Format tags ─────────────────────────────────────────────────────────────

/** Tagged format: the driver's two resultset row protocols. */
export const FORMAT_TEXT   = 0;
export const FORMAT_BINARY = 1;
export type WireFormat = typeof FORMAT_TEXT | typeof FORMAT_BINARY;
