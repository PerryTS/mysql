// Public API of @perryts/mysql — pure-TypeScript MySQL / MariaDB wire-protocol
// driver. Runs on Node.js / Bun and ahead-of-time compiles to a native
// binary on Perry via LLVM.
//
// This file is the stable semver surface. Sub-modules under `src/` are
// importable for tests and advanced use but are NOT part of the semver
// contract.

// Core connection API (M2, M4, M6)
export { connect, Connection } from './connection';
export type { ConnectOptions, QueryResult } from './connection';

// Pool (M6)
export { Pool, createPool } from './pool';
export type { PoolOptions } from './pool';

// Tagged template (M6)
export { sql, raw, isSqlQuery } from './sql';
export type { SqlQuery } from './sql';

// URL / env resolution (M6)
export { parseConnectionString } from './url';
export type { ParsedConnectionString, SslMode } from './url';
export { resolveConnectOptions } from './env';
export type { ResolveOptionsInput } from './env';

// Cancellation (M6)
export { sendKillQuery } from './cancel';

// Errors + warnings (M2)
export { MyError, decodeErrFields, parseMyError } from './error';
export type { MyErrorFields } from './error';
export type { MyWarning } from './warnings';

// Auth plugin extension point (M3)
export { registerAuthPlugin, getAuthPlugin } from './auth/dispatcher';
export type { AuthPlugin, AuthCtx, AuthStep } from './auth/dispatcher';

// Type system (M5)
export * from './types/type-codes';
export * from './types/charset';
export { Decimal } from './types/decimal';
export type {
    MyDate, MyTime, MyDateTime,
} from './types/datetime';
export {
    decodeDateText, decodeDateBinary,
    decodeDateTimeText, decodeDateTimeBinary,
    decodeTimeText, decodeTimeBinary,
} from './types/datetime';
export {
    registerType, getCodec, hasBinaryCodec, decodeValue, encodeValue, pickDecoder, listRegisteredTypes,
} from './types/registry';
export type { MyCodec, TextCodec, BinaryCodec, EncodedParam } from './types/registry';

// Protocol framing (M1) — exposed for tools / tests
export { parsePacket, writePacket } from './protocol/framing';
export type { PacketView } from './protocol/framing';
export { MessageReader } from './protocol/reader';
export {
    readLenencInt,
    readLenencIntOrNull,
    writeLenencInt,
    lenencIntSize,
    readLenencString,
    readLenencStringOrNull,
    writeLenencString,
    readLenencUtf8,
    lenencStringSize,
} from './protocol/lenenc';
export * from './protocol/messages';
export * from './protocol/capabilities';
export * from './protocol/status';

// Builders + decoders (M2, M4)
export {
    writeHandshakeResponse41,
    writeSSLRequest,
    writeComQuery,
    writeComQuit,
    writeComPing,
    writeComInitDb,
    writeComResetConnection,
    writeComStmtPrepare,
    writeComStmtExecute,
    writeComStmtClose,
    writeComStmtReset,
    writeComStmtSendLongData,
    writeAuthSwitchResponse,
    writeAuthMoreDataResponse,
    writeCachingSha2RequestPublicKey,
    STMT_EXECUTE_FLAG_NO_CURSOR,
} from './protocol/writer';
export type { HandshakeResponse41Options } from './protocol/writer';
export {
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
    classifyFePacket,
    isOk,
    isErr,
    isEof,
    isAuthMoreData,
} from './protocol/decoder';
export type {
    HandshakeV10,
    OkPacket,
    ErrPacket,
    EofPacket,
    ColumnDefinition41,
    AuthSwitchRequest,
    AuthMoreData,
    PrepareOK,
    RawRow,
    FePacketKind,
} from './protocol/decoder';

// Utilities
export { BufferCursor } from './util/buffer-cursor';
export {
    resultsetNullBitmapSize,
    paramNullBitmapSize,
    isResultsetColumnNull,
    isParamNull,
    buildParamNullBitmap,
} from './util/null-bitmap';

// Bundled auth plugins (M3). Exported so callers can inspect them
// (e.g., for unit-level KATs), not because they need to be re-registered.
export { NATIVE_PASSWORD, nativeScramble } from './auth/native-password';
export { CACHING_SHA2_PASSWORD, sha256Scramble } from './auth/caching-sha2';
export { SHA256_PASSWORD } from './auth/sha256-password';
export { MYSQL_CLEAR_PASSWORD } from './auth/clear-password';
export { CLIENT_ED25519 } from './auth/ed25519';
export { xorScramblePassword, rsaOaepEncrypt } from './auth/rsa';
