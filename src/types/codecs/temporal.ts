// Temporal codecs: DATE, TIME, DATETIME, TIMESTAMP.
//
// Text decode/encode delegates to datetime.ts's string parsers.
// Binary decode reads the packed u8-prefixed struct; binary encode
// writes the minimal-length form (omit time components that are 0,
// omit micros that are 0).

import type { MyCodec, EncodedParam } from '../registry';
import {
    MYSQL_TYPE_DATE,
    MYSQL_TYPE_DATETIME,
    MYSQL_TYPE_TIMESTAMP,
    MYSQL_TYPE_TIME,
} from '../type-codes';
import {
    decodeDateText,
    decodeDateBinary,
    decodeDateTimeText,
    decodeDateTimeBinary,
    decodeTimeText,
    decodeTimeBinary,
    type MyDate,
    type MyDateTime,
    type MyTime,
} from '../datetime';

// ─── DATE ────────────────────────────────────────────────────────────────────

export const DATE_CODEC: MyCodec<MyDate> = {
    typeCode: MYSQL_TYPE_DATE,
    name: 'date',
    text: {
        decode: (buf) => decodeDateText(buf),
        encode: (v) => Buffer.from(v.toString(), 'utf8'),
    },
    binary: {
        decode: (buf) => decodeDateBinary(buf),
        encode: (v): EncodedParam => encodeDateBinary(v),
    },
};

function encodeDateBinary(v: MyDate): EncodedParam {
    if (v.isZero()) {
        const out = Buffer.alloc(1);
        return { typeCode: MYSQL_TYPE_DATE, unsigned: false, bytes: out };
    }
    const out = Buffer.alloc(1 + 4);
    out.writeUInt8(4, 0);
    out.writeUInt16LE(v.year, 1);
    out.writeUInt8(v.month, 3);
    out.writeUInt8(v.day, 4);
    return { typeCode: MYSQL_TYPE_DATE, unsigned: false, bytes: out };
}

// ─── DATETIME / TIMESTAMP (identical wire shape) ────────────────────────────

function mkDateTimeCodec(typeCode: number, name: string): MyCodec<MyDateTime> {
    return {
        typeCode: typeCode,
        name: name,
        text: {
            decode: (buf) => decodeDateTimeText(buf),
            encode: (v) => Buffer.from(v.toString(), 'utf8'),
        },
        binary: {
            decode: (buf) => decodeDateTimeBinary(buf),
            encode: (v): EncodedParam => encodeDateTimeBinary(typeCode, v),
        },
    };
}

function encodeDateTimeBinary(typeCode: number, v: MyDateTime): EncodedParam {
    if (v.isZero()) {
        return { typeCode: typeCode, unsigned: false, bytes: Buffer.alloc(1) };
    }
    // Choose the narrowest length that preserves the value.
    if (v.microsecond === 0 && v.hour === 0 && v.minute === 0 && v.second === 0) {
        const out = Buffer.alloc(1 + 4);
        out.writeUInt8(4, 0);
        out.writeUInt16LE(v.year, 1);
        out.writeUInt8(v.month, 3);
        out.writeUInt8(v.day, 4);
        return { typeCode: typeCode, unsigned: false, bytes: out };
    }
    if (v.microsecond === 0) {
        const out = Buffer.alloc(1 + 7);
        out.writeUInt8(7, 0);
        out.writeUInt16LE(v.year, 1);
        out.writeUInt8(v.month, 3);
        out.writeUInt8(v.day, 4);
        out.writeUInt8(v.hour, 5);
        out.writeUInt8(v.minute, 6);
        out.writeUInt8(v.second, 7);
        return { typeCode: typeCode, unsigned: false, bytes: out };
    }
    const out = Buffer.alloc(1 + 11);
    out.writeUInt8(11, 0);
    out.writeUInt16LE(v.year, 1);
    out.writeUInt8(v.month, 3);
    out.writeUInt8(v.day, 4);
    out.writeUInt8(v.hour, 5);
    out.writeUInt8(v.minute, 6);
    out.writeUInt8(v.second, 7);
    out.writeUInt32LE(v.microsecond, 8);
    return { typeCode: typeCode, unsigned: false, bytes: out };
}

export const DATETIME_CODEC  = mkDateTimeCodec(MYSQL_TYPE_DATETIME, 'datetime');
export const TIMESTAMP_CODEC = mkDateTimeCodec(MYSQL_TYPE_TIMESTAMP, 'timestamp');

// ─── TIME ────────────────────────────────────────────────────────────────────

export const TIME_CODEC: MyCodec<MyTime> = {
    typeCode: MYSQL_TYPE_TIME,
    name: 'time',
    text: {
        decode: (buf) => decodeTimeText(buf),
        encode: (v) => Buffer.from(v.toString(), 'utf8'),
    },
    binary: {
        decode: (buf) => decodeTimeBinary(buf),
        encode: (v): EncodedParam => encodeTimeBinary(v),
    },
};

function encodeTimeBinary(v: MyTime): EncodedParam {
    const totalZero = v.days === 0 && v.hours === 0 && v.minutes === 0 && v.seconds === 0 && v.microseconds === 0;
    if (totalZero) {
        return { typeCode: MYSQL_TYPE_TIME, unsigned: false, bytes: Buffer.alloc(1) };
    }
    const len = v.microseconds === 0 ? 8 : 12;
    const out = Buffer.alloc(1 + len);
    out.writeUInt8(len, 0);
    out.writeUInt8(v.isNegative ? 1 : 0, 1);
    out.writeUInt32LE(v.days, 2);
    out.writeUInt8(v.hours, 6);
    out.writeUInt8(v.minutes, 7);
    out.writeUInt8(v.seconds, 8);
    if (len === 12) {
        out.writeUInt32LE(v.microseconds, 9);
    }
    return { typeCode: MYSQL_TYPE_TIME, unsigned: false, bytes: out };
}
