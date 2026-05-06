// Query cancellation via a second, fresh TCP connection running
// `KILL QUERY <connection_id>`.
//
// Unlike Postgres (whose cancel is a single 16-byte datagram on a fresh
// socket), MySQL requires a full auth cycle on the cancel channel before
// we can issue `KILL QUERY`. The in-flight query on the target connection
// rejects with a MyError (errno 1317 / SQLSTATE 70100) once the server
// processes the cancel.
//
// The cost (one full connection round-trip) is the price of MySQL's
// design — documented in CLAUDE.md.

import { connect, type ConnectOptions } from './connection';

/**
 * Open a side connection with the given credentials, authenticate,
 * `KILL QUERY <connectionId>`, and close. Fire-and-forget — resolves
 * after the side connection has cleanly closed. Errors are swallowed:
 * by the time the caller inspects the target's query result the server
 * has either cancelled it or not; additional diagnostics from a
 * cancel-channel failure would be noise.
 */
export async function sendKillQuery(
    opts: ConnectOptions,
    connectionId: number,
): Promise<void> {
    try {
        const side = await connect(opts);
        try {
            await side.query('KILL QUERY ' + connectionId);
        } finally {
            await side.close();
        }
    } catch (_e) {
        // ignore — the target connection surfaces the real outcome.
    }
}
