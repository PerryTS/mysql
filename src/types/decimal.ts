// Arbitrary-precision decimal wrapper for MySQL's DECIMAL / NEWDECIMAL.
//
// MySQL's binary wire format for DECIMAL is a packed base-10^9 digit
// layout — but the server only uses the binary format for COM_STMT_EXECUTE
// response rows *inconsistently* across versions, and in all cases emits
// the decimal as a lenenc-prefixed string for both text and binary
// protocols (!). That simplifies us dramatically: the codec just wraps
// the string without parsing.
//
// Port of @perryts/postgres's `Decimal` — identical semantics, same opaque
// string backing. Arithmetic stays out of scope; consumers convert to
// `decimal.js` / `bignumber.js` as needed.

export class Decimal {
    private readonly _s: string;

    constructor(s: string) {
        this._s = s;
    }

    toString(): string {
        return this._s;
    }

    toJSON(): string {
        return this._s;
    }

    /** Lossy conversion to a JS number. Opt-in. */
    toNumber(): number {
        return Number(this._s);
    }

    /** True iff the value is the special NaN marker (rare in MySQL). */
    isNaN(): boolean {
        return this._s === 'NaN';
    }

    isFinite(): boolean {
        return this._s !== 'NaN' && this._s !== 'Infinity' && this._s !== '-Infinity';
    }
}

export function decodeDecimalString(buf: Buffer): Decimal {
    return new Decimal(buf.toString('utf8'));
}

export function encodeDecimalString(value: Decimal | string | number | bigint): Buffer {
    if (value instanceof Decimal) {
        return Buffer.from(value.toString(), 'utf8');
    }
    if (typeof value === 'bigint') {
        return Buffer.from(value.toString(), 'utf8');
    }
    return Buffer.from(String(value), 'utf8');
}
