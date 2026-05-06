// Idempotent bootstrap for the driver's built-in auth plugins and
// type codecs.
//
// Lives behind a flag because (a) Perry's AOT loader doesn't run the
// top-level bodies of side-effect-only imports — we have to make the
// registration reachable from a call graph rooted at an exported
// function — and (b) repeated calls from tests must not double-register.

import { registerAuthPlugin } from './auth/dispatcher';
import { NATIVE_PASSWORD } from './auth/native-password';
import { CACHING_SHA2_PASSWORD } from './auth/caching-sha2';
import { SHA256_PASSWORD } from './auth/sha256-password';
import { MYSQL_CLEAR_PASSWORD } from './auth/clear-password';
import { CLIENT_ED25519 } from './auth/ed25519';
import { registerType } from './types/registry';
import {
    TINY_CODEC, SHORT_CODEC, LONG_CODEC, INT24_CODEC, LONGLONG_CODEC,
    FLOAT_CODEC, DOUBLE_CODEC, NULL_CODEC,
    NEWDECIMAL_CODEC, DECIMAL_LEGACY_CODEC,
    YEAR_CODEC, BIT_CODEC,
} from './types/codecs/scalars';
import {
    VAR_STRING_CODEC, STRING_CODEC, VARCHAR_CODEC,
    BLOB_CODEC, TINY_BLOB_CODEC, MEDIUM_BLOB_CODEC, LONG_BLOB_CODEC,
    ENUM_CODEC, SET_CODEC, GEOMETRY_CODEC, JSON_CODEC,
} from './types/codecs/strings';
import { DATE_CODEC, DATETIME_CODEC, TIMESTAMP_CODEC, TIME_CODEC } from './types/codecs/temporal';

let registered = false;

/** Register built-in auth plugins AND built-in type codecs. Idempotent. */
export function registerDefaultPlugins(): void {
    if (registered) {
        return;
    }
    registered = true;
    // Auth plugins.
    registerAuthPlugin(NATIVE_PASSWORD);
    registerAuthPlugin(CACHING_SHA2_PASSWORD);
    registerAuthPlugin(SHA256_PASSWORD);
    registerAuthPlugin(MYSQL_CLEAR_PASSWORD);
    registerAuthPlugin(CLIENT_ED25519);
    // Type codecs — 23 total (20 core + 3 blob variants).
    registerType(TINY_CODEC);
    registerType(SHORT_CODEC);
    registerType(LONG_CODEC);
    registerType(INT24_CODEC);
    registerType(LONGLONG_CODEC);
    registerType(FLOAT_CODEC);
    registerType(DOUBLE_CODEC);
    registerType(NULL_CODEC);
    registerType(NEWDECIMAL_CODEC);
    registerType(DECIMAL_LEGACY_CODEC);
    registerType(YEAR_CODEC);
    registerType(BIT_CODEC);
    registerType(VAR_STRING_CODEC);
    registerType(STRING_CODEC);
    registerType(VARCHAR_CODEC);
    registerType(BLOB_CODEC);
    registerType(TINY_BLOB_CODEC);
    registerType(MEDIUM_BLOB_CODEC);
    registerType(LONG_BLOB_CODEC);
    registerType(ENUM_CODEC);
    registerType(SET_CODEC);
    registerType(GEOMETRY_CODEC);
    registerType(JSON_CODEC);
    registerType(DATE_CODEC);
    registerType(DATETIME_CODEC);
    registerType(TIMESTAMP_CODEC);
    registerType(TIME_CODEC);
}
