// Minimal Perry AOT probe with diagnostic dumps.

import { writePacket, parsePacket } from '../src/protocol/framing';
import { writeLenencInt, readLenencInt } from '../src/protocol/lenenc';
import { BufferCursor } from '../src/util/buffer-cursor';

const payload = Buffer.from([0x03, 0x53, 0x45, 0x4C, 0x45, 0x43, 0x54, 0x20, 0x31]);
const { bytes, nextSeq } = writePacket(0, payload);
const parsed = parsePacket(bytes, 0);
// eslint-disable-next-line no-console
console.log('framing: nextSeq=' + nextSeq + ' parsed-len=' + (parsed !== null ? parsed.payload.length : 'null'));

const lbuf = Buffer.alloc(9);
const after = writeLenencInt(70000, lbuf, 0);
// eslint-disable-next-line no-console
console.log('after write: pos=' + after + ' b0=' + lbuf.readUInt8(0) + ' b1=' + lbuf.readUInt8(1) + ' b2=' + lbuf.readUInt8(2) + ' b3=' + lbuf.readUInt8(3));

const cur = new BufferCursor(lbuf);
const first = cur.readUInt8();
// eslint-disable-next-line no-console
console.log('readUInt8: first=' + first + ' pos=' + cur.pos);

const v = cur.readUInt24LE();
// eslint-disable-next-line no-console
console.log('readUInt24LE: v=' + v + ' pos=' + cur.pos);

const lval = readLenencInt(new BufferCursor(lbuf));
// eslint-disable-next-line no-console
console.log('lenenc: roundtrip=' + lval);

// eslint-disable-next-line no-console
console.log('perry-aot-minimal: OK');
