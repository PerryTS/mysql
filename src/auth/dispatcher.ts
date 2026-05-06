// Auth plugin registry + state driver.
//
// MySQL's auth is a small state machine that sits on top of a named-plugin
// registry. The server picks a plugin at handshake time (`default_auth`),
// and may ask the client to switch to a different plugin mid-handshake
// via an AuthSwitchRequest packet (0xFE). Some plugins (caching_sha2,
// sha256) also exchange additional rounds via AuthMoreData (0x01) before
// the server finally sends OK (0x00) or ERR (0xFF).
//
// We keep the dispatcher platform-free: it doesn't touch sockets or
// Promises. Callers feed it incoming packets and get back the next
// thing to write (or a terminal state). That makes it trivial to unit
// test independently of the connection state machine.

import type { AuthMoreData, AuthSwitchRequest } from '../protocol/decoder';

/** Per-connection context passed to every plugin callback. */
export interface AuthCtx {
    username: string;
    password: string;
    /** Challenge bytes from the most recent HandshakeV10 / AuthSwitchRequest. */
    challenge: Buffer;
    /** True if we're already running over TLS (cleartext passwords ok). */
    tlsActive: boolean;
    /**
     * Opt-in to receiving the server's public key over plain TCP for
     * `caching_sha2_password` / `sha256_password` full-auth. Defaults
     * to false. Matches the JDBC `allowPublicKeyRetrieval` flag.
     */
    allowPublicKeyRetrieval: boolean;
    /**
     * Plugin-private scratch. Typed as unknown; each plugin owns its key.
     * We use a Map so Perry's AOT doesn't choke on dynamic bracket keys.
     */
    scratch: Map<string, unknown>;
}

/**
 * Outcome of feeding a packet to a plugin.
 *
 *   - `write`: send these bytes to the server, keep driving.
 *   - `ok`:    plugin is done, waiting for the server's OK packet.
 *   - `fail`:  plugin surrenders (TLS required, bad state, ...); throw.
 */
export type AuthStep =
    | { kind: 'write'; bytes: Buffer }
    | { kind: 'ok' }
    | { kind: 'fail'; reason: string };

export interface AuthPlugin {
    /** Wire name as it appears in HandshakeV10 / AuthSwitchRequest. */
    name: string;

    /**
     * Build the initial auth response for this plugin. Called once,
     * either right after HandshakeV10 (initial plugin) or after the
     * dispatcher sees an AuthSwitchRequest that named this plugin.
     */
    initialResponse(ctx: AuthCtx): Buffer;

    /**
     * React to an AuthMoreData (0x01-prefixed) packet from the server.
     * Plugins that never exchange additional rounds can omit this.
     */
    onAuthMoreData?(ctx: AuthCtx, payload: Buffer): AuthStep;
}

const PLUGINS = new Map<string, AuthPlugin>();

export function registerAuthPlugin(p: AuthPlugin): void {
    PLUGINS.set(p.name, p);
}

export function getAuthPlugin(name: string): AuthPlugin | undefined {
    return PLUGINS.get(name);
}

/**
 * React to an AuthSwitchRequest: look up the new plugin, update `ctx`
 * with its challenge, and return the first bytes to send back.
 */
export function handleAuthSwitch(
    ctx: AuthCtx,
    req: AuthSwitchRequest,
): { plugin: AuthPlugin; step: AuthStep } {
    const plugin = PLUGINS.get(req.pluginName);
    if (plugin === undefined) {
        throw new Error('server asked for unknown auth plugin: ' + req.pluginName);
    }
    ctx.challenge = req.authPluginData;
    ctx.scratch = new Map<string, unknown>();
    const bytes = plugin.initialResponse(ctx);
    return { plugin: plugin, step: { kind: 'write', bytes: bytes } };
}

/**
 * React to an AuthMoreData packet by delegating to the active plugin.
 */
export function handleAuthMoreData(
    plugin: AuthPlugin,
    ctx: AuthCtx,
    data: AuthMoreData,
): AuthStep {
    if (plugin.onAuthMoreData === undefined) {
        return {
            kind: 'fail',
            reason: 'plugin ' + plugin.name + ' received unexpected AuthMoreData',
        };
    }
    return plugin.onAuthMoreData(ctx, data.data);
}
