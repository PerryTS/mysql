// Sequential little-endian reader over a Buffer, tracking position.
//
// MySQL is little-endian in every integer field (packet length, status
// flags, capabilities, column counts, stmt ids, …). This cursor is the
// mirror of `@perryts/postgres`'s BufferCursor — same shape, different
// endianness. It lives in its own module because sharing between drivers
// would require a byte-order flag on every read, which is both slower
// (extra branch per call) and more error-prone.
//
// Guidance for Perry AOT: we never use bracket indexing on the buffer.
// `buf[i]` reads as `undefined` under Perry's codegen. Every byte read
// goes through `Buffer.readUInt8(i)`.

export class BufferCursor {
    public pos: number = 0;
    public buf: Buffer = Buffer.alloc(0);

    constructor(buf: Buffer, startPos: number = 0) {
        this.buf = buf;
        this.pos = startPos;
    }

    readUInt8(): number {
        const v = this.buf.readUInt8(this.pos);
        this.pos += 1;
        return v;
    }

    readInt8(): number {
        const v = this.buf.readInt8(this.pos);
        this.pos += 1;
        return v;
    }

    readUInt16LE(): number {
        const v = this.buf.readUInt16LE(this.pos);
        this.pos += 2;
        return v;
    }

    readInt16LE(): number {
        const v = this.buf.readInt16LE(this.pos);
        this.pos += 2;
        return v;
    }

    /** Unsigned 24-bit LE — used by the packet length field. */
    readUInt24LE(): number {
        // Avoid readUIntLE(pos, 3) because Perry doesn't lower the variable-byte
        // read family. Three explicit u8 reads compose cleanly.
        const b0 = this.buf.readUInt8(this.pos);
        const b1 = this.buf.readUInt8(this.pos + 1);
        const b2 = this.buf.readUInt8(this.pos + 2);
        this.pos += 3;
        return (b2 << 16) | (b1 << 8) | b0;
    }

    readUInt32LE(): number {
        const v = this.buf.readUInt32LE(this.pos);
        this.pos += 4;
        return v;
    }

    readInt32LE(): number {
        const v = this.buf.readInt32LE(this.pos);
        this.pos += 4;
        return v;
    }

    readBigUInt64LE(): bigint {
        const v = this.buf.readBigUInt64LE(this.pos);
        this.pos += 8;
        return v;
    }

    readBigInt64LE(): bigint {
        const v = this.buf.readBigInt64LE(this.pos);
        this.pos += 8;
        return v;
    }

    readFloatLE(): number {
        const v = this.buf.readFloatLE(this.pos);
        this.pos += 4;
        return v;
    }

    readDoubleLE(): number {
        const v = this.buf.readDoubleLE(this.pos);
        this.pos += 8;
        return v;
    }

    /**
     * Read `n` bytes as a subarray view into the underlying buffer.
     * The slice shares memory with the source — caller must not mutate it,
     * and must not retain it past the lifetime of the source.
     */
    readBytes(n: number): Buffer {
        const slice = this.buf.subarray(this.pos, this.pos + n);
        this.pos += n;
        return slice;
    }

    /**
     * Null-terminated UTF-8 string. Used by HandshakeV10 (server version,
     * auth plugin name), AuthSwitchRequest (plugin name), and most
     * string-NUL fields.
     */
    readNullTerminatedString(): string {
        let end = this.pos;
        while (end < this.buf.length && this.buf.readUInt8(end) !== 0) {
            end++;
        }
        if (end >= this.buf.length) {
            throw new Error('readNullTerminatedString: no null terminator');
        }
        const v = this.buf.toString('utf8', this.pos, end);
        this.pos = end + 1;
        return v;
    }

    /**
     * Fixed-length string. The buffer must contain at least `n` more bytes;
     * no null-termination search is performed.
     */
    readFixedString(n: number): string {
        const v = this.buf.toString('utf8', this.pos, this.pos + n);
        this.pos += n;
        return v;
    }

    /** Rest-of-packet UTF-8 string. */
    readRestString(): string {
        const v = this.buf.toString('utf8', this.pos, this.buf.length);
        this.pos = this.buf.length;
        return v;
    }

    /** Rest-of-packet raw bytes (subarray view). */
    readRestBytes(): Buffer {
        const slice = this.buf.subarray(this.pos, this.buf.length);
        this.pos = this.buf.length;
        return slice;
    }

    /** Skip `n` bytes. */
    skip(n: number): void {
        this.pos += n;
    }

    remaining(): number {
        return this.buf.length - this.pos;
    }

    done(): boolean {
        return this.pos >= this.buf.length;
    }

    /** Peek the next byte without advancing. Throws if at end. */
    peekUInt8(): number {
        return this.buf.readUInt8(this.pos);
    }
}
