// Resolve ConnectOptions from the caller's explicit inputs, an optional
// connection-string URL, and MYSQL_* environment variables.
//
// Precedence (highest wins):
//   1. Explicit fields passed to `connect({...})`
//   2. Fields parsed from a `url` / connection string
//   3. MYSQL_* environment variables
//   4. Built-in defaults (host=localhost, port=3306, user=root, database='', ssl=off)
//
// Environment variables recognised:
//   MYSQL_HOST            → host
//   MYSQL_TCP_PORT        → port        (matches libmysqlclient; MYSQL_PORT is
//                                        the docker-compose env name and
//                                        deliberately NOT consumed here)
//   MYSQL_USER            → user
//   MYSQL_PWD             → password    (matches libmysqlclient)
//   MYSQL_DATABASE        → database
//   MYSQL_SSL_MODE        → ssl.mode

import type { ConnectOptions } from './connection';
import { parseConnectionString, type SslMode } from './url';

export interface ResolveOptionsInput extends Partial<ConnectOptions> {
    /** Optional DSN that seeds the base options before explicit overrides. */
    url?: string;
}

export function resolveConnectOptions(input: ResolveOptionsInput | string): ConnectOptions {
    const asInput: ResolveOptionsInput = typeof input === 'string' ? { url: input } : input;

    let fromUrl: Partial<ConnectOptions> = {};
    let sslModeFromUrl: SslMode | undefined = undefined;
    if (typeof asInput.url === 'string' && asInput.url.length > 0) {
        const parsed = parseConnectionString(asInput.url);
        fromUrl = {
            host: parsed.host,
            port: parsed.port,
            user: parsed.user,
            database: parsed.database,
        };
        if (parsed.password !== undefined) {
            fromUrl.password = parsed.password;
        }
        if (parsed.charset !== undefined) {
            fromUrl.charset = parsed.charset;
        }
        if (parsed.connectTimeoutMs !== undefined) {
            fromUrl.connectTimeoutMs = parsed.connectTimeoutMs;
        }
        if (parsed.allowPublicKeyRetrieval !== undefined) {
            fromUrl.allowPublicKeyRetrieval = parsed.allowPublicKeyRetrieval;
        }
        sslModeFromUrl = parsed.sslMode;
    }

    const env = readEnv();

    const host = pick3<string>(asInput.host, fromUrl.host, env.host, 'localhost');
    const port = pick3<number>(asInput.port, fromUrl.port, env.port, 3306);
    const user = pick3<string>(asInput.user, fromUrl.user, env.user, 'root');
    const password = pickOpt3<string>(asInput.password, fromUrl.password, env.password);
    const database = pick3<string>(asInput.database, fromUrl.database, env.database, '');
    const charset = pickOpt3<number>(asInput.charset, fromUrl.charset, undefined);
    const connectTimeoutMs = pickOpt3<number>(asInput.connectTimeoutMs, fromUrl.connectTimeoutMs, undefined);
    const allowPublicKeyRetrieval = pickOpt3<boolean>(
        asInput.allowPublicKeyRetrieval,
        fromUrl.allowPublicKeyRetrieval,
        undefined,
    );

    const ssl = resolveSsl(asInput.ssl, sslModeFromUrl, env.sslMode);

    const out: ConnectOptions = {
        host: host,
        port: port,
        user: user,
        database: database,
    };
    if (password !== undefined) {
        out.password = password;
    }
    if (charset !== undefined) {
        out.charset = charset;
    }
    if (connectTimeoutMs !== undefined) {
        out.connectTimeoutMs = connectTimeoutMs;
    }
    if (allowPublicKeyRetrieval !== undefined) {
        out.allowPublicKeyRetrieval = allowPublicKeyRetrieval;
    }
    if (ssl !== undefined) {
        out.ssl = ssl;
    }
    if (asInput.maxPacketSize !== undefined) {
        out.maxPacketSize = asInput.maxPacketSize;
    }
    if (asInput.attrs !== undefined) {
        out.attrs = asInput.attrs;
    }
    return out;
}

interface EnvView {
    host: string | undefined;
    port: number | undefined;
    user: string | undefined;
    password: string | undefined;
    database: string | undefined;
    sslMode: SslMode | undefined;
}

function readEnv(): EnvView {
    const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
    const env = g.process !== undefined && g.process.env !== undefined ? g.process.env : {};
    let port: number | undefined = undefined;
    if (typeof env.MYSQL_TCP_PORT === 'string' && env.MYSQL_TCP_PORT.length > 0) {
        const n = Number(env.MYSQL_TCP_PORT);
        if (!Number.isNaN(n)) {
            port = n;
        }
    }
    let sslMode: SslMode | undefined = undefined;
    if (typeof env.MYSQL_SSL_MODE === 'string' && env.MYSQL_SSL_MODE.length > 0) {
        const u = env.MYSQL_SSL_MODE.toUpperCase();
        if (u === 'DISABLED') sslMode = 'disable';
        else if (u === 'REQUIRED' || u === 'PREFERRED') sslMode = 'require';
        else if (u === 'VERIFY_CA') sslMode = 'verify-ca';
        else if (u === 'VERIFY_IDENTITY' || u === 'VERIFY_FULL') sslMode = 'verify-full';
    }
    return {
        host: orUndef(env.MYSQL_HOST),
        port: port,
        user: orUndef(env.MYSQL_USER),
        password: orUndef(env.MYSQL_PWD),
        database: orUndef(env.MYSQL_DATABASE),
        sslMode: sslMode,
    };
}

function orUndef(v: string | undefined): string | undefined {
    if (v === undefined || v.length === 0) {
        return undefined;
    }
    return v;
}

function resolveSsl(
    explicit: ConnectOptions['ssl'] | undefined,
    fromUrl: SslMode | undefined,
    fromEnv: SslMode | undefined,
): ConnectOptions['ssl'] | undefined {
    if (explicit !== undefined) {
        return explicit;
    }
    const mode = fromUrl !== undefined ? fromUrl : fromEnv;
    if (mode === undefined) {
        return undefined;
    }
    return { mode: mode };
}

function pick3<T>(a: T | undefined, b: T | undefined, c: T | undefined, fallback: T): T {
    if (a !== undefined) { return a; }
    if (b !== undefined) { return b; }
    if (c !== undefined) { return c; }
    return fallback;
}

function pickOpt3<T>(a: T | undefined, b: T | undefined, c: T | undefined): T | undefined {
    if (a !== undefined) { return a; }
    if (b !== undefined) { return b; }
    return c;
}
