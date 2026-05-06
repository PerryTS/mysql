import { test, expect } from 'bun:test';
import {
    decodeOkPacket,
    decodeErrPacket,
    decodeEofPacket,
    decodeHandshakeV10,
    decodeColumnCount,
    decodeColumnDefinition41,
    decodeTextResultsetRow,
    decodePrepareOK,
    decodeBinaryResultsetRow,
    decodeAuthSwitchRequest,
    decodeAuthMoreData,
    isOk,
    isErr,
    isEof,
    isAuthMoreData,
    classifyFePacket,
} from '../../src/protocol/decoder';
import { PACKET_OK, PACKET_ERR, PACKET_EOF, PACKET_AUTH_MORE_DATA } from '../../src/protocol/messages';
import { writeLenencInt, writeLenencString } from '../../src/protocol/lenenc';

test('isOk / isErr / isEof / isAuthMoreData', () => {
    expect(isOk(Buffer.from([PACKET_OK]))).toBe(true);
    expect(isErr(Buffer.from([PACKET_ERR]))).toBe(true);
    expect(isEof(Buffer.from([PACKET_EOF, 0, 0, 0, 0]))).toBe(true);
    expect(isEof(Buffer.from([PACKET_EOF, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
    expect(isAuthMoreData(Buffer.from([PACKET_AUTH_MORE_DATA, 0x01, 0x02]))).toBe(true);
});

test('decodeOkPacket: basic', () => {
    // 0x00 + lenenc(0) + lenenc(0) + status(0x0002) + warnings(0x0000)
    const buf = Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]);
    const ok = decodeOkPacket(buf, 0);
    expect(ok.affectedRows).toBe(0);
    expect(ok.lastInsertId).toBe(0);
    expect(ok.statusFlags).toBe(0x0002);
    expect(ok.warningCount).toBe(0);
});

test('decodeErrPacket: errno + sqlstate + message', () => {
    const msg = Buffer.from("Access denied", 'utf8');
    const buf = Buffer.concat([
        Buffer.from([0xFF, 0x15, 0x04 /* errno 1045 */, 0x23 /* '#' */]),
        Buffer.from('28000', 'ascii'),
        msg,
    ]);
    const err = decodeErrPacket(buf);
    expect(err.errno).toBe(1045);
    expect(err.sqlState).toBe('28000');
    expect(err.serverMessage).toBe('Access denied');
});

test('decodeEofPacket: warnings + status', () => {
    const buf = Buffer.from([0xFE, 0x03, 0x00, 0x02, 0x00]);
    const eof = decodeEofPacket(buf);
    expect(eof.warningCount).toBe(3);
    expect(eof.statusFlags).toBe(2);
});

test('decodeColumnCount: lenenc int', () => {
    const buf = Buffer.from([0x05]);
    expect(decodeColumnCount(buf)).toBe(5);
});

test('decodeTextResultsetRow: lenenc strings + 0xFB NULL', () => {
    const pieces: Buffer[] = [];
    const b1 = Buffer.alloc(4);
    writeLenencString('abc', b1, 0);
    pieces.push(b1.subarray(0, 4));
    pieces.push(Buffer.from([0xFB])); // null
    const b3 = Buffer.alloc(3);
    writeLenencString('xy', b3, 0);
    pieces.push(b3.subarray(0, 3));
    const row = decodeTextResultsetRow(Buffer.concat(pieces), 3);
    expect(row[0]?.toString('utf8')).toBe('abc');
    expect(row[1]).toBeNull();
    expect(row[2]?.toString('utf8')).toBe('xy');
});

test('decodeColumnDefinition41: round-trip via hand-built payload', () => {
    // Build a minimal column def: catalog="def", schema="", table="", orgTable="",
    // name="foo", orgName="foo", filler 0x0C, collation 255, length 1024, type 3, flags 0, decimals 0, filler 0x0000.
    const strs = ['def', '', '', '', 'foo', 'foo'];
    let size = 0;
    const pieces: Buffer[] = [];
    for (let i = 0; i < strs.length; i++) {
        const b = Buffer.from(strs[i], 'utf8');
        const o = Buffer.alloc(1 + b.length);
        writeLenencString(b, o, 0);
        pieces.push(o);
        size += o.length;
    }
    const fixed = Buffer.alloc(1 + 2 + 4 + 1 + 2 + 1 + 2);
    let p = 0;
    writeLenencInt(0x0C, fixed, p); p += 1;
    fixed.writeUInt16LE(255, p); p += 2;
    fixed.writeUInt32LE(1024, p); p += 4;
    fixed.writeUInt8(3 /* LONG */, p); p += 1;
    fixed.writeUInt16LE(0, p); p += 2;
    fixed.writeUInt8(0, p); p += 1;
    fixed.writeUInt16LE(0, p); p += 2;
    const col = decodeColumnDefinition41(Buffer.concat([...pieces, fixed]));
    expect(col.name).toBe('foo');
    expect(col.orgName).toBe('foo');
    expect(col.collation).toBe(255);
    expect(col.columnLength).toBe(1024);
    expect(col.typeCode).toBe(3);
});

test('decodeHandshakeV10: MariaDB server string flips isMariaDB', () => {
    // Build a minimal-but-valid HandshakeV10 payload.
    const serverVersion = '11.4.3-MariaDB';
    const versionBytes = Buffer.from(serverVersion, 'utf8');
    const challenge = Buffer.alloc(20, 0x42);
    const part1 = challenge.subarray(0, 8);
    const part2 = challenge.subarray(8);
    const plugin = Buffer.from('mysql_native_password', 'utf8');
    // Include CLIENT_PLUGIN_AUTH (0x00080000) + CLIENT_SECURE_CONNECTION (0x00008000)
    // so the decoder walks the plugin-name path.
    const caps = 0x000F_FFFF;
    const size =
        1 + versionBytes.length + 1 + 4 + 8 + 1 + 2 + 1 + 2 + 2 + 1 + 10 + (part2.length + 1) + plugin.length + 1;
    const out = Buffer.alloc(size);
    let pp = 0;
    out.writeUInt8(10, pp); pp += 1;
    versionBytes.copy(out, pp); pp += versionBytes.length;
    out.writeUInt8(0, pp); pp += 1;
    out.writeUInt32LE(100, pp); pp += 4;
    part1.copy(out, pp); pp += 8;
    out.writeUInt8(0, pp); pp += 1;
    out.writeUInt16LE(caps & 0xFFFF, pp); pp += 2;
    out.writeUInt8(255, pp); pp += 1;
    out.writeUInt16LE(2, pp); pp += 2;
    out.writeUInt16LE((caps >>> 16) & 0xFFFF, pp); pp += 2;
    out.writeUInt8(8 + part2.length + 1, pp); pp += 1;
    pp += 10;
    part2.copy(out, pp); pp += part2.length;
    out.writeUInt8(0, pp); pp += 1;
    plugin.copy(out, pp); pp += plugin.length;
    out.writeUInt8(0, pp); pp += 1;

    const h = decodeHandshakeV10(out.subarray(0, pp));
    expect(h.serverVersion).toBe('11.4.3-MariaDB');
    expect(h.isMariaDB).toBe(true);
    expect(h.connectionId).toBe(100);
    expect(h.authPluginName).toBe('mysql_native_password');
    expect(h.authPluginData.length).toBe(20);
});

test('decodeAuthSwitchRequest: parses plugin name + challenge', () => {
    const name = Buffer.from('mysql_native_password', 'utf8');
    const challenge = Buffer.alloc(20, 0x77);
    const payload = Buffer.concat([
        Buffer.from([0xFE]),
        name,
        Buffer.from([0]),
        challenge,
        Buffer.from([0]),
    ]);
    const req = decodeAuthSwitchRequest(payload);
    expect(req.pluginName).toBe('mysql_native_password');
    expect(req.authPluginData.length).toBe(20);
    expect(req.authPluginData.readUInt8(0)).toBe(0x77);
});

test('decodeAuthMoreData: strips 0x01 header', () => {
    const payload = Buffer.from([0x01, 0x03]);
    const data = decodeAuthMoreData(payload);
    expect(data.data.length).toBe(1);
    expect(data.data.readUInt8(0)).toBe(0x03);
});

test('decodePrepareOK: fields', () => {
    const payload = Buffer.alloc(12);
    payload.writeUInt8(0x00, 0);
    payload.writeUInt32LE(7, 1);
    payload.writeUInt16LE(3, 5);
    payload.writeUInt16LE(2, 7);
    payload.writeUInt8(0, 9);
    payload.writeUInt16LE(1, 10);
    const ok = decodePrepareOK(payload);
    expect(ok.stmtId).toBe(7);
    expect(ok.numColumns).toBe(3);
    expect(ok.numParams).toBe(2);
    expect(ok.warningCount).toBe(1);
});

test('decodeBinaryResultsetRow: LONG + NULL + VAR_STRING', () => {
    // 3 columns: LONG, NULL (marked by bitmap), VAR_STRING
    const columns = [
        { catalog: 'def', schema: '', table: '', orgTable: '', name: 'a', orgName: 'a', collation: 63, columnLength: 4, typeCode: 0x03, flags: 0, decimals: 0 },
        { catalog: 'def', schema: '', table: '', orgTable: '', name: 'b', orgName: 'b', collation: 63, columnLength: 4, typeCode: 0x03, flags: 0, decimals: 0 },
        { catalog: 'def', schema: '', table: '', orgTable: '', name: 'c', orgName: 'c', collation: 255, columnLength: 255, typeCode: 0xFD, flags: 0, decimals: 0 },
    ];
    // null bitmap: column 1 null. Bitmap size = (3+7+2)>>3 = 1 byte.
    // bit index for col 1 = 1 + 2 = 3 → 0b0000_1000 = 0x08
    const bitmap = Buffer.from([0x08]);
    // col 0: LONG = 42
    const cell0 = Buffer.alloc(4);
    cell0.writeInt32LE(42, 0);
    // col 2: lenenc "hi"
    const cell2 = Buffer.from([2, 0x68, 0x69]);
    const payload = Buffer.concat([Buffer.from([0x00]), bitmap, cell0, cell2]);
    const row = decodeBinaryResultsetRow(payload, columns);
    expect(row.length).toBe(3);
    expect(row[0]!.readInt32LE(0)).toBe(42);
    expect(row[1]).toBeNull();
    expect(row[2]!.toString('utf8')).toBe('hi');
});

test('classifyFePacket: auth vs resultset contexts', () => {
    expect(classifyFePacket('auth', Buffer.from([0xFE, 0x65]), 0)).toBe('auth-switch-request');
    expect(classifyFePacket('resultset-rows', Buffer.from([0xFE, 0, 0, 0, 0]), 0)).toBe('eof');
    expect(classifyFePacket('resultset-rows', Buffer.from([0xFE, 0, 0, 0, 0]), 0x01000000)).toBe('ok-via-deprecate-eof');
});
