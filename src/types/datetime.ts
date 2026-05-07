// Date / time wrappers for MySQL temporal types.
//
// Binary-protocol layouts (same across MySQL and MariaDB):
//
//   DATE:
//     [len: u8]   0 → zero date ("0000-00-00")
//                 4 → y:u16 LE, m:u8, d:u8
//
//   DATETIME / TIMESTAMP:
//     [len: u8]   0 → zero datetime
//                 4 → y,m,d (time = 00:00:00.000000)
//                 7 → +h,m,s
//                11 → +micros:u32 LE
//
//   TIME:
//     [len: u8]   0 → 00:00:00.000000
//                 8 → isneg:u8, days:u32 LE, h:u8, m:u8, s:u8
//                12 → +micros:u32 LE
//
// Text protocol emits the same values as canonical strings:
//   "YYYY-MM-DD", "YYYY-MM-DD HH:MM:SS[.ffffff]", "[-]HHH:MM:SS[.ffffff]"
//   where TIME's hours can exceed 24 (signed range [-838:59:59, 838:59:59]).
//
// We preserve microsecond precision end-to-end. A consumer that only needs
// millisecond JS `Date` can call `.toDate()` on MyDate / MyDateTime.

import { BufferCursor } from '../util/buffer-cursor';

// ─── DATE ────────────────────────────────────────────────────────────────────

export interface MyDate {
    year: number;
    month: number; // 1..12 (0 for zero-date)
    day: number;   // 1..31 (0 for zero-date)
    raw: string;
    toString(): string;
    toDate(): Date;
    isZero(): boolean;
}

export function decodeDateText(buf: Buffer): MyDate {
    const s = buf.toString('utf8');
    if (s === '0000-00-00') {
        return makeMyDate(0, 0, 0, s);
    }
    // YYYY-MM-DD
    const y = parseInt(s.substring(0, 4), 10);
    const m = parseInt(s.substring(5, 7), 10);
    const d = parseInt(s.substring(8, 10), 10);
    return makeMyDate(y, m, d, s);
}

export function decodeDateBinary(buf: Buffer): MyDate {
    if (buf.length === 0) {
        return makeMyDate(0, 0, 0, '0000-00-00');
    }
    const cur = new BufferCursor(buf);
    const y = cur.readUInt16LE();
    const m = cur.readUInt8();
    const d = cur.readUInt8();
    return makeMyDate(y, m, d, renderDate(y, m, d));
}

function makeMyDate(year: number, month: number, day: number, raw: string): MyDate {
    return {
        year: year, month: month, day: day, raw: raw,
        toString(): string { return raw; },
        toDate(): Date {
            if (year === 0 && month === 0 && day === 0) {
                return new Date(NaN);
            }
            return new Date(Date.UTC(year, month - 1, day));
        },
        isZero(): boolean {
            return year === 0 && month === 0 && day === 0;
        },
    };
}

function renderDate(y: number, m: number, d: number): string {
    return pad(y, 4) + '-' + pad(m, 2) + '-' + pad(d, 2);
}

// ─── DATETIME / TIMESTAMP ────────────────────────────────────────────────────

export interface MyDateTime {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    microsecond: number;
    raw: string;
    toString(): string;
    toDate(): Date;
    isZero(): boolean;
}

export function decodeDateTimeText(buf: Buffer): MyDateTime {
    const s = buf.toString('utf8');
    return parseDateTimeText(s);
}

function parseDateTimeText(s: string): MyDateTime {
    if (s === '0000-00-00 00:00:00' || s.startsWith('0000-00-00')) {
        return makeMyDateTime(0, 0, 0, 0, 0, 0, 0, s);
    }
    const y = parseInt(s.substring(0, 4), 10);
    const mo = parseInt(s.substring(5, 7), 10);
    const d = parseInt(s.substring(8, 10), 10);
    const h = parseInt(s.substring(11, 13), 10);
    const mi = parseInt(s.substring(14, 16), 10);
    const sec = parseInt(s.substring(17, 19), 10);
    let micros = 0;
    if (s.length > 19 && s.charAt(19) === '.') {
        const fracStr = padRight(s.substring(20), 6).substring(0, 6);
        micros = parseInt(fracStr, 10);
    }
    return makeMyDateTime(y, mo, d, h, mi, sec, micros, s);
}

export function decodeDateTimeBinary(buf: Buffer): MyDateTime {
    // The buffer arrives as the raw column value (the upstream framing
    // already consumed the lenenc length prefix in `decodeBinaryResultsetRow`).
    // Discriminate on `buf.length`:
    //   0  → zero datetime
    //   4  → date only          (year(2) month(1) day(1))
    //   7  → date + time        (… hour(1) min(1) sec(1))
    //   11 → date + time + frac (… micros(4))
    const len = buf.length;
    if (len === 0) {
        return makeMyDateTime(0, 0, 0, 0, 0, 0, 0, '0000-00-00 00:00:00');
    }
    const cur = new BufferCursor(buf);
    const y = cur.readUInt16LE();
    const mo = cur.readUInt8();
    const d = cur.readUInt8();
    let h = 0, mi = 0, sec = 0, micros = 0;
    if (len >= 7) {
        h = cur.readUInt8();
        mi = cur.readUInt8();
        sec = cur.readUInt8();
    }
    if (len >= 11) {
        micros = cur.readUInt32LE();
    }
    return makeMyDateTime(y, mo, d, h, mi, sec, micros, renderDateTime(y, mo, d, h, mi, sec, micros));
}

function makeMyDateTime(y: number, mo: number, d: number, h: number, mi: number, sec: number, micros: number, raw: string): MyDateTime {
    return {
        year: y, month: mo, day: d,
        hour: h, minute: mi, second: sec, microsecond: micros,
        raw: raw,
        toString(): string { return raw; },
        toDate(): Date {
            if (y === 0 && mo === 0 && d === 0) {
                return new Date(NaN);
            }
            // MySQL DATETIME has no timezone — we treat it as UTC for the
            // conversion (consumers that need a wall-clock-zone mapping
            // should do their own arithmetic on the raw fields).
            return new Date(Date.UTC(y, mo - 1, d, h, mi, sec, Math.round(micros / 1000)));
        },
        isZero(): boolean {
            return y === 0 && mo === 0 && d === 0;
        },
    };
}

function renderDateTime(y: number, mo: number, d: number, h: number, mi: number, sec: number, micros: number): string {
    let out = pad(y, 4) + '-' + pad(mo, 2) + '-' + pad(d, 2) + ' ' +
        pad(h, 2) + ':' + pad(mi, 2) + ':' + pad(sec, 2);
    if (micros !== 0) {
        out += '.' + pad(micros, 6);
    }
    return out;
}

// ─── TIME ────────────────────────────────────────────────────────────────────

export interface MyTime {
    /** True when the value is negative (TIME's range is signed). */
    isNegative: boolean;
    /** Whole-day component (0..34 in MySQL's legal range). */
    days: number;
    hours: number;   // 0..23
    minutes: number; // 0..59
    seconds: number; // 0..59
    microseconds: number; // 0..999999
    raw: string;
    toString(): string;
}

export function decodeTimeText(buf: Buffer): MyTime {
    const s = buf.toString('utf8');
    return parseTimeText(s);
}

function parseTimeText(s: string): MyTime {
    let body = s;
    let neg = false;
    if (body.charAt(0) === '-') {
        neg = true;
        body = body.substring(1);
    }
    // MySQL TIME can overflow 24h (HHH:MM:SS up to 838:59:59).
    const colon1 = body.indexOf(':');
    const colon2 = body.indexOf(':', colon1 + 1);
    const h = parseInt(body.substring(0, colon1), 10);
    const mi = parseInt(body.substring(colon1 + 1, colon2), 10);
    const dot = body.indexOf('.', colon2 + 1);
    const sec = parseInt(body.substring(colon2 + 1, dot < 0 ? body.length : dot), 10);
    let micros = 0;
    if (dot >= 0) {
        const fracStr = padRight(body.substring(dot + 1), 6).substring(0, 6);
        micros = parseInt(fracStr, 10);
    }
    const days = Math.trunc(h / 24);
    const hours = h - days * 24;
    return {
        isNegative: neg, days: days, hours: hours, minutes: mi, seconds: sec, microseconds: micros,
        raw: s,
        toString(): string { return s; },
    };
}

export function decodeTimeBinary(buf: Buffer): MyTime {
    // Same fix as decodeDateTimeBinary: the buffer is the raw column value;
    // the upstream framing already consumed the lenenc prefix. Discriminate
    // on `buf.length`:
    //   0  → zero
    //   8  → sign(1) days(4) h(1) m(1) s(1)
    //   12 → … micros(4)
    const len = buf.length;
    if (len === 0) {
        return makeMyTime(false, 0, 0, 0, 0, 0);
    }
    const cur = new BufferCursor(buf);
    const sign = cur.readUInt8();
    const days = cur.readUInt32LE();
    const h = cur.readUInt8();
    const mi = cur.readUInt8();
    const sec = cur.readUInt8();
    let micros = 0;
    if (len >= 12) {
        micros = cur.readUInt32LE();
    }
    return makeMyTime(sign !== 0, days, h, mi, sec, micros);
}

function makeMyTime(isNeg: boolean, days: number, h: number, mi: number, sec: number, micros: number): MyTime {
    const totalH = days * 24 + h;
    let raw = (isNeg ? '-' : '') + pad(totalH, 2) + ':' + pad(mi, 2) + ':' + pad(sec, 2);
    if (micros !== 0) {
        raw += '.' + pad(micros, 6);
    }
    return {
        isNegative: isNeg, days: days, hours: h, minutes: mi, seconds: sec, microseconds: micros,
        raw: raw,
        toString(): string { return raw; },
    };
}

// ─── YEAR ────────────────────────────────────────────────────────────────────

// YEAR is just a `number`. No wrapper. Codec lives in codecs/temporal.ts.

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pad(n: number, width: number): string {
    const s = String(n);
    if (s.length >= width) {
        return s;
    }
    return '0'.repeat(width - s.length) + s;
}

function padRight(s: string, width: number): string {
    if (s.length >= width) {
        return s;
    }
    return s + '0'.repeat(width - s.length);
}
