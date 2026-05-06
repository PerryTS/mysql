// Inbound packet accumulator. Owns a small byte buffer, receives chunks
// from the underlying socket's `'data'` event, and yields complete
// logical packets (coalescing >16MB continuation chains) as soon as
// they're available.
//
// Any trailing incomplete bytes are retained for the next `feed` call.

import { parsePacket, PacketView } from './framing';

export class MessageReader {
    private buf: Buffer = Buffer.alloc(0);

    /**
     * Append `chunk` to the internal buffer and return every complete
     * packet that can now be parsed.
     *
     * Returned `payload` values are SUBARRAY views when no continuation
     * splitting was needed (common fast path), or freshly-allocated
     * copies when coalescing a >16MB chain. Consumers can safely retain
     * either across later `feed` calls because reassigning `this.buf`
     * doesn't invalidate existing slices (each held slice keeps the
     * underlying ArrayBuffer alive).
     */
    feed(chunk: Buffer): PacketView[] {
        if (this.buf.length === 0) {
            this.buf = chunk;
        } else {
            this.buf = Buffer.concat([this.buf, chunk]);
        }

        const out: PacketView[] = [];
        let offset = 0;
        while (offset < this.buf.length) {
            const pkt = parsePacket(this.buf, offset);
            if (pkt === null) {
                break;
            }
            out.push(pkt);
            offset += pkt.consumed;
        }

        if (offset > 0) {
            this.buf = offset < this.buf.length
                ? Buffer.from(this.buf.subarray(offset))
                : Buffer.alloc(0);
        }
        return out;
    }

    /** True iff the internal buffer still contains a partial packet. */
    hasPending(): boolean {
        return this.buf.length > 0;
    }

    /** Discard any buffered bytes. Useful on reconnect. */
    reset(): void {
        this.buf = Buffer.alloc(0);
    }
}
