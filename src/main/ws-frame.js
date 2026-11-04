// RFC 6455 frame encoding and decoding. Only what the Edge speech endpoint needs:
// text/binary messages, fragmentation, and the ping/pong/close control frames.

import { randomBytes } from 'node:crypto';

export const BINARY = 0x2;
export const CLOSE = 0x8;
export const CONTINUATION = 0x0;
export const PING = 0x9;
export const PONG = 0xa;
export const TEXT = 0x1;

const CONTROL = (opcode) => (opcode & 0x8) !== 0;
const KNOWN = new Set([CONTINUATION, TEXT, BINARY, CLOSE, PING, PONG]);

export function encodeFrame(opcode, payload, { fin = true, mask = randomBytes(4) } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] |= 0x80; // client frames are always masked
  const masked = Buffer.from(data);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

// Incremental decoder. push() may be called with any TCP chunking; complete frames are
// reported through onFrame({ fin, opcode, payload }).
export class FrameDecoder {
  constructor({ maxPayload = 32 * 1024 * 1024 } = {}) {
    this.buffer = Buffer.alloc(0);
    this.maxPayload = maxPayload;
  }

  push(data, onFrame) {
    this.buffer = this.buffer.length === 0 ? Buffer.from(data) : Buffer.concat([this.buffer, data]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      if ((b0 & 0x70) !== 0) throw new Error('Unexpected WebSocket extension bits');
      if (!KNOWN.has(opcode)) throw new Error(`Unknown WebSocket opcode ${opcode}`);
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) throw new Error('WebSocket frame is too large');
        length = Number(big);
        offset = 10;
      }
      if (length > this.maxPayload) throw new Error('WebSocket frame is too large');
      if (CONTROL(opcode) && (length > 125 || !fin)) throw new Error('Invalid WebSocket control frame');
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      let payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = this.buffer.subarray(offset + length);
      onFrame({ fin, opcode, payload });
    }
  }
}
