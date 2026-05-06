// Parser for MySQL connection strings.
//
// Supported schemes:
//   mysql://   — the classic one
//   mariadb:// — accepted as a synonym; servers are wire-compatible
//
// Examples:
//   mysql://root@localhost
//   mysql://root:pw@localhost:3306/appdb
//   mysql://user:p%40ss@[::1]:3306/appdb?ssl-mode=REQUIRED&charset=45
//
// Supported query params:
//   ssl-mode        DISABLED | PREFERRED | REQUIRED | VERIFY_CA | VERIFY_IDENTITY
//   charset         Collation id (number). Alternatively a known name like utf8mb4_general_ci.
//   connectTimeout  Integer milliseconds.
//   multipleStatements  "true" | "false" (default false).
//   allowPublicKeyRetrieval "true" | "false" (default false).

export type SslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';

export interface ParsedConnectionString {
    host: string;
    port: number;
    user: string;
    password: string | undefined;
    database: string;
    sslMode: SslMode | undefined;
    charset: number | undefined;
    connectTimeoutMs: number | undefined;
    multipleStatements: boolean | undefined;
    allowPublicKeyRetrieval: boolean | undefined;
}

export function parseConnectionString(s: string): ParsedConnectionString {
    const schemeEnd = s.indexOf('://');
    if (schemeEnd < 0) {
        throw new Error("parseConnectionString: missing scheme (expected 'mysql://' or 'mariadb://')");
    }
    const scheme = s.substring(0, schemeEnd).toLowerCase();
    if (scheme !== 'mysql' && scheme !== 'mariadb') {
        throw new Error("parseConnectionString: unsupported scheme '" + scheme + "'");
    }
    let rest = s.substring(schemeEnd + 3);

    // Strip optional query string.
    let query = '';
    const qIdx = rest.indexOf('?');
    if (qIdx >= 0) {
        query = rest.substring(qIdx + 1);
        rest = rest.substring(0, qIdx);
    }

    // Split path (database) off the end.
    let database = '';
    const slashIdx = rest.indexOf('/');
    if (slashIdx >= 0) {
        database = decodePercent(rest.substring(slashIdx + 1));
        rest = rest.substring(0, slashIdx);
    }

    // Split userinfo from host.
    let userinfo = '';
    let hostPart = rest;
    const atIdx = rest.lastIndexOf('@');
    if (atIdx >= 0) {
        userinfo = rest.substring(0, atIdx);
        hostPart = rest.substring(atIdx + 1);
    }

    let user = 'root';
    let password: string | undefined = undefined;
    if (userinfo !== '') {
        const colon = userinfo.indexOf(':');
        if (colon >= 0) {
            user = decodePercent(userinfo.substring(0, colon));
            password = decodePercent(userinfo.substring(colon + 1));
        } else {
            user = decodePercent(userinfo);
        }
    }

    // Host / port. Handle [IPv6]:port.
    let host = 'localhost';
    let port = 3306;
    if (hostPart.length > 0) {
        if (hostPart.charAt(0) === '[') {
            const close = hostPart.indexOf(']');
            if (close < 0) {
                throw new Error('parseConnectionString: malformed IPv6 host');
            }
            host = hostPart.substring(1, close);
            const after = hostPart.substring(close + 1);
            if (after.length > 0 && after.charAt(0) === ':') {
                port = parseInt(after.substring(1), 10);
            }
        } else {
            const colon = hostPart.indexOf(':');
            if (colon >= 0) {
                host = hostPart.substring(0, colon);
                port = parseInt(hostPart.substring(colon + 1), 10);
            } else {
                host = hostPart;
            }
        }
    }

    const out: ParsedConnectionString = {
        host: host,
        port: port,
        user: user,
        password: password,
        database: database,
        sslMode: undefined,
        charset: undefined,
        connectTimeoutMs: undefined,
        multipleStatements: undefined,
        allowPublicKeyRetrieval: undefined,
    };

    if (query !== '') {
        applyQueryParams(out, query);
    }
    return out;
}

function applyQueryParams(out: ParsedConnectionString, query: string): void {
    const pairs = query.split('&');
    for (let i = 0; i < pairs.length; i++) {
        const kv = pairs[i];
        const eq = kv.indexOf('=');
        const rawKey = eq < 0 ? kv : kv.substring(0, eq);
        const rawVal = eq < 0 ? '' : kv.substring(eq + 1);
        const key = decodePercent(rawKey).toLowerCase();
        const val = decodePercent(rawVal);
        if (key === 'ssl-mode' || key === 'sslmode') {
            out.sslMode = normaliseSslMode(val);
        } else if (key === 'charset') {
            const n = Number(val);
            if (!Number.isNaN(n)) {
                out.charset = n;
            }
        } else if (key === 'connecttimeout' || key === 'connect-timeout' || key === 'connecttimeoutms') {
            const n = Number(val);
            if (!Number.isNaN(n)) {
                out.connectTimeoutMs = n;
            }
        } else if (key === 'multiplestatements') {
            out.multipleStatements = val.toLowerCase() === 'true';
        } else if (key === 'allowpublickeyretrieval') {
            out.allowPublicKeyRetrieval = val.toLowerCase() === 'true';
        }
    }
}

function normaliseSslMode(v: string): SslMode {
    const u = v.toUpperCase();
    if (u === 'DISABLED' || u === 'DISABLE') return 'disable';
    if (u === 'REQUIRED' || u === 'REQUIRE' || u === 'PREFERRED' || u === 'PREFER') return 'require';
    if (u === 'VERIFY_CA' || u === 'VERIFY-CA') return 'verify-ca';
    if (u === 'VERIFY_IDENTITY' || u === 'VERIFY-IDENTITY' || u === 'VERIFY_FULL' || u === 'VERIFY-FULL') return 'verify-full';
    throw new Error("parseConnectionString: unknown ssl-mode '" + v + "'");
}

/** Minimal URI percent-decoding. Handles %XX. */
function decodePercent(s: string): string {
    if (s.indexOf('%') < 0 && s.indexOf('+') < 0) {
        return s;
    }
    let out = '';
    let i = 0;
    while (i < s.length) {
        const c = s.charAt(i);
        if (c === '+') {
            out += ' ';
            i += 1;
            continue;
        }
        if (c === '%' && i + 2 < s.length) {
            const hex = s.substring(i + 1, i + 3);
            const n = parseInt(hex, 16);
            if (!Number.isNaN(n)) {
                out += String.fromCharCode(n);
                i += 3;
                continue;
            }
        }
        out += c;
        i += 1;
    }
    return out;
}
