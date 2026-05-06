// Perry-vs-Node branch for TLS upgrade on an existing socket.
//
// MySQL negotiates TLS mid-stream: the client sends a 32-byte SSLRequest
// packet (the first 32 bytes of HandshakeResponse41, with CLIENT_SSL set),
// the server upgrades the same socket to TLS, and the rest of the
// HandshakeResponse41 is sent over TLS. Identical to the pg shape.

import type { Socket } from './net-socket';
import { isNodeLike } from './net-socket';

export interface TlsUpgradeOpts {
    servername: string;
    /**
     * `true`  → verify full cert chain + hostname (sslmode=VERIFY_IDENTITY).
     * `false` → accept any certificate (sslmode=REQUIRED).
     */
    verify: boolean;
}

/**
 * Upgrade `sock` from plain TCP to TLS in place. Returns the post-upgrade
 * handle — which may or may not be the same object as the input:
 *
 *   - Perry: returns the same `Socket` (transport swapped internally)
 *   - Node:  returns a new `Socket` wrapping the plain one
 *
 * If the returned handle is a different object, the caller must rewire
 * its `'data' | 'error' | 'close'` listeners to the new handle.
 */
export async function upgradeToTls(sock: Socket, opts: TlsUpgradeOpts): Promise<Socket> {
    if (!isNodeLike()) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sockAny = sock as any;
        await sockAny.upgradeToTLS(opts.servername, opts.verify ? 1 : 0);
        return sock;
    }
    return upgradeNode(sock, opts);
}

async function upgradeNode(sock: Socket, opts: TlsUpgradeOpts): Promise<Socket> {
    const tls = await import('node:tls');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plainAny = sock as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const connectOpts: any = {
        socket: plainAny,
        rejectUnauthorized: opts.verify,
    };
    if (!isIpLiteral(opts.servername)) {
        connectOpts.servername = opts.servername;
    }
    const tlsSock = tls.connect(connectOpts);

    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (err: Error | null): void => {
            if (settled) {
                return;
            }
            settled = true;
            tlsSock.removeListener('secureConnect', onSecure);
            tlsSock.removeListener('error', onError);
            if (err !== null) {
                reject(err);
            } else {
                resolve();
            }
        };
        const onSecure = (): void => {
            settle(null);
        };
        const onError = (e: Error): void => {
            settle(e);
        };
        tlsSock.once('secureConnect', onSecure);
        tlsSock.once('error', onError);
    });

    return tlsSock as unknown as Socket;
}

/** RFC 6066: SNI servername must be a DNS name, not an IP literal. */
function isIpLiteral(s: string): boolean {
    if (s.indexOf(':') >= 0) {
        return true;
    }
    let dots = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 0x2e) {
            dots++;
        } else if (c < 0x30 || c > 0x39) {
            return false;
        }
    }
    return dots === 3;
}
