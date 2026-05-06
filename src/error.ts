// Structured error from a server-sent ERR packet.
//
// ERR packet layout (CLIENT_PROTOCOL_41 active — always, for this driver):
//
//   [0xFF][error_code: u16 LE][# sqlstate_marker (always '#')][sqlstate: 5 bytes]
//   [error message: rest-of-packet UTF-8]
//
// When CLIENT_PROTOCOL_41 is NOT active the packet lacks the marker+sqlstate,
// but the modern driver always declares CLIENT_PROTOCOL_41 so we require it.
//
// Compose `message` to include errno and sqlstate so `console.error(err)`
// shows enough context without requiring callers to poke at the fields.

import { BufferCursor } from './util/buffer-cursor';
import { PACKET_ERR } from './protocol/messages';

export interface MyErrorFields {
    errno: number;
    sqlState: string;
    /** Server-provided message text, in the server's configured language. */
    serverMessage: string;
}

export class MyError extends Error {
    public readonly errno: number;
    public readonly sqlState: string;
    public readonly serverMessage: string;

    constructor(fields: MyErrorFields) {
        super(composeMessage(fields));
        this.name = 'MyError';
        this.errno = fields.errno;
        this.sqlState = fields.sqlState;
        this.serverMessage = fields.serverMessage;
    }
}

function composeMessage(f: MyErrorFields): string {
    // Example: "ER_ACCESS_DENIED_ERROR (1045, 28000): Access denied for user 'bob'@'localhost'"
    // We don't map errno→name here (there are ~6000 codes across MySQL and MariaDB);
    // callers can cross-reference the code.
    return 'MySQL error ' + f.errno + ' (' + f.sqlState + '): ' + f.serverMessage;
}

/**
 * Parse an ERR-packet body into MyErrorFields. `payload` is the whole packet
 * body including the leading 0xFF marker.
 */
export function decodeErrFields(payload: Buffer): MyErrorFields {
    if (payload.length < 3) {
        throw new Error('decodeErrFields: short ERR packet, ' + payload.length + ' bytes');
    }
    const cur = new BufferCursor(payload);
    const marker = cur.readUInt8();
    if (marker !== PACKET_ERR) {
        throw new Error('decodeErrFields: not an ERR packet (first byte 0x' + marker.toString(16) + ')');
    }
    const errno = cur.readUInt16LE();
    // CLIENT_PROTOCOL_41 path: expect '#' marker + 5-byte sqlstate.
    let sqlState = 'HY000';
    if (cur.remaining() >= 6 && cur.peekUInt8() === 0x23 /* '#' */) {
        cur.skip(1);
        sqlState = cur.readFixedString(5);
    }
    const serverMessage = cur.readRestString();
    return { errno: errno, sqlState: sqlState, serverMessage: serverMessage };
}

/** Build a `MyError` directly from a packet body. */
export function parseMyError(payload: Buffer): MyError {
    return new MyError(decodeErrFields(payload));
}
