// Cross-environment socket adapter. Perry and Node/Bun both ship a
// Node-compatible `net` module. Both accept the positional
// `(port, host)` form (matching Node's documented signature
// `net.createConnection(port[, host][, connectListener])`); Node
// additionally accepts the object form `({ host, port })`.
//
// This file is the only place in the driver that cares. Everything else
// consumes the returned `Socket` interface.

import * as net from 'net';

/** The common socket surface used throughout the driver. */
export interface Socket {
    write(buf: Buffer): boolean | void;
    end(): void;
    destroy(): void;
    on(event: 'connect', cb: () => void): void;
    on(event: 'data', cb: (buf: Buffer) => void): void;
    on(event: 'error', cb: (err: Error | string) => void): void;
    on(event: 'close', cb: () => void): void;
    /**
     * Detach a previously-attached 'data' listener. Needed before a TLS
     * upgrade on Node — otherwise the plain socket's listener and Node's
     * internal TLS read path race for the same bytes and the handshake
     * stalls. Perry's event model doesn't require detach/reattach, but we
     * expose the method there too as a no-op so callers don't need to
     * branch.
     */
    removeDataListener?(cb: (buf: Buffer) => void): void;
    /**
     * Perry-only: TLS upgrade on an existing socket. Node callers branch
     * to `tls.connect({socket, ...})` via `src/transport/upgrade-tls.ts`.
     */
    upgradeToTLS?(servername: string, verify: 0 | 1): Promise<void>;
}

/** True when running under Node.js or Bun. */
export function isNodeLike(): boolean {
    const g = globalThis as { process?: { versions?: { node?: string } } };
    return g.process !== undefined
        && g.process.versions !== undefined
        && typeof g.process.versions.node === 'string';
}

/**
 * Open a plain TCP socket. Returns immediately — `'connect'` fires
 * asynchronously once the TCP handshake completes.
 */
export function openSocket(host: string, port: number): Socket {
    if (isNodeLike()) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (net as any).createConnection({ host: host, port: port }) as Socket;
    }
    // Perry positional signature is `(port, host)` per Node's documented
    // `net.createConnection(port[, host])`. Pre-fix this called
    // `(host, port)` — perry coerced the host string to a port (NaN)
    // and the port number to a host pointer, returning an invalid
    // socket handle that silently no-op'd the rest of the connection
    // lifecycle. PerryTS/perry#536.
    return net.createConnection(port as never, host as never) as unknown as Socket;
}
