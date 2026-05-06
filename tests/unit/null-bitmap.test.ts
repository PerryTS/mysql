import { test, expect } from 'bun:test';
import {
    resultsetNullBitmapSize,
    paramNullBitmapSize,
    isResultsetColumnNull,
    isParamNull,
    buildParamNullBitmap,
} from '../../src/util/null-bitmap';

test('resultset bitmap size accounts for the +2 reserved bits', () => {
    expect(resultsetNullBitmapSize(0)).toBe(1);
    expect(resultsetNullBitmapSize(1)).toBe(1);
    expect(resultsetNullBitmapSize(6)).toBe(1);
    expect(resultsetNullBitmapSize(7)).toBe(2); // 7 + 2 = 9 bits → 2 bytes
    expect(resultsetNullBitmapSize(14)).toBe(2);
    expect(resultsetNullBitmapSize(15)).toBe(3); // 15 + 2 = 17 bits → 3 bytes
});

test('param bitmap size has no +2 offset', () => {
    expect(paramNullBitmapSize(0)).toBe(0);
    expect(paramNullBitmapSize(1)).toBe(1);
    expect(paramNullBitmapSize(8)).toBe(1);
    expect(paramNullBitmapSize(9)).toBe(2);
    expect(paramNullBitmapSize(17)).toBe(3);
});

test('resultset null bit: column 0 lives at bit 2 of byte 0', () => {
    // Bitmap where column 0 is NULL and nothing else.
    // Byte 0 bit index = (0 + 2) = 2 → 0b00000100 = 0x04.
    const buf = Buffer.from([0x04]);
    expect(isResultsetColumnNull(buf, 0, 0)).toBe(true);
    // column 1 would be at bit 3 of byte 0.
    expect(isResultsetColumnNull(buf, 0, 1)).toBe(false);
});

test('resultset null bit: column 6 lives at bit 0 of byte 1', () => {
    // (6 + 2) = 8 → byte 1, bit 0 → byte 1 = 0x01.
    const buf = Buffer.from([0x00, 0x01]);
    expect(isResultsetColumnNull(buf, 0, 6)).toBe(true);
    expect(isResultsetColumnNull(buf, 0, 5)).toBe(false);
});

test('param null bit: column 0 lives at bit 0 of byte 0 (no offset)', () => {
    const buf = Buffer.from([0x01]);
    expect(isParamNull(buf, 0, 0)).toBe(true);
    expect(isParamNull(buf, 0, 1)).toBe(false);
});

test('buildParamNullBitmap marks the right bits for 17 params', () => {
    const nulls = new Array(17).fill(false) as boolean[];
    nulls[0] = true;
    nulls[7] = true;
    nulls[8] = true;
    nulls[16] = true;
    const bm = buildParamNullBitmap(nulls);
    expect(bm.length).toBe(3);
    expect(bm.readUInt8(0)).toBe(0x81); // bits 0 and 7 of byte 0
    expect(bm.readUInt8(1)).toBe(0x01); // bit 0 of byte 1 (param 8)
    expect(bm.readUInt8(2)).toBe(0x01); // bit 0 of byte 2 (param 16)
    expect(isParamNull(bm, 0, 0)).toBe(true);
    expect(isParamNull(bm, 0, 7)).toBe(true);
    expect(isParamNull(bm, 0, 8)).toBe(true);
    expect(isParamNull(bm, 0, 16)).toBe(true);
    expect(isParamNull(bm, 0, 9)).toBe(false);
});
