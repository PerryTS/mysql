// MySQL binary-resultset / prepared-statement NULL bitmap helpers.
//
// Two wire forms, one off-by-two gotcha:
//
//   Server → client binary-resultset row:
//       bitmap size = ceil((num_columns + 7 + 2) / 8)  bytes
//       column i's null bit lives at byte (i + 2) >> 3, bit (i + 2) & 7.
//       The `+ 2` accounts for two reserved leading bits in every row.
//
//   Client → server COM_STMT_EXECUTE param bitmap:
//       bitmap size = ceil(num_params / 8)  bytes
//       param i's null bit lives at byte i >> 3, bit i & 7.
//       No reserved-bit offset.
//
// The two helpers below bake that difference in so callers can't mix
// them up. See also `decoder.decodeBinaryResultsetRow` and
// `writer.writeComStmtExecute`.

/** Byte length of a server→client binary-resultset NULL bitmap. */
export function resultsetNullBitmapSize(numColumns: number): number {
    return (numColumns + 7 + 2) >> 3;
}

/** Byte length of a COM_STMT_EXECUTE client→server param NULL bitmap. */
export function paramNullBitmapSize(numParams: number): number {
    return (numParams + 7) >> 3;
}

/**
 * True iff column `col` is NULL in a server→client binary-resultset row.
 * `offset` is the byte position in `buf` where the bitmap starts.
 */
export function isResultsetColumnNull(
    buf: Buffer,
    offset: number,
    col: number,
): boolean {
    const bitIndex = col + 2;
    const byte = buf.readUInt8(offset + (bitIndex >> 3));
    return (byte & (1 << (bitIndex & 7))) !== 0;
}

/**
 * True iff param `p` is NULL in a client→server COM_STMT_EXECUTE payload.
 */
export function isParamNull(
    buf: Buffer,
    offset: number,
    p: number,
): boolean {
    const byte = buf.readUInt8(offset + (p >> 3));
    return (byte & (1 << (p & 7))) !== 0;
}

/**
 * Build a COM_STMT_EXECUTE param NULL bitmap.
 * `nulls` is a parallel-to-params boolean array (true = NULL).
 * Returns a freshly-allocated Buffer of length `paramNullBitmapSize(nulls.length)`.
 */
export function buildParamNullBitmap(nulls: boolean[]): Buffer {
    const out = Buffer.alloc(paramNullBitmapSize(nulls.length));
    for (let i = 0; i < nulls.length; i++) {
        if (nulls[i] === true) {
            const byteIdx = i >> 3;
            const bitMask = 1 << (i & 7);
            out.writeUInt8(out.readUInt8(byteIdx) | bitMask, byteIdx);
        }
    }
    return out;
}
