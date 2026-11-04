import test from 'node:test';
import assert from 'node:assert/strict';
import { BINARY, CLOSE, PING, TEXT, FrameDecoder, encodeFrame } from '../src/main/ws-frame.js';

function collect(data) {
  const frames = [];
  new FrameDecoder().push(data, (frame) => frames.push(frame));
  return frames;
}

function serverFrame(opcode, payload, fin = true) {
  const length = payload.length;
  let head;
  if (length < 126) {
    head = Buffer.from([(fin ? 0x80 : 0) | opcode, length]);
  } else if (length < 65536) {
    head = Buffer.alloc(4);
    head[0] = (fin ? 0x80 : 0) | opcode;
    head[1] = 126;
    head.writeUInt16BE(length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = (fin ? 0x80 : 0) | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([head, payload]);
}

test('encodeFrame masks and the decoder unmasks a text frame', () => {
  const payload = Buffer.from('hello world');
  const frames = collect(encodeFrame(TEXT, payload));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, TEXT);
  assert.equal(frames[0].fin, true);
  assert.equal(frames[0].payload.toString(), 'hello world');
});

test('the decoder accepts frames split at every byte boundary', () => {
  const frame = encodeFrame(BINARY, Buffer.from('abcdefghij'));
  for (let split = 1; split < frame.length; split++) {
    const frames = [];
    const decoder = new FrameDecoder();
    decoder.push(frame.subarray(0, split), (f) => frames.push(f));
    assert.equal(frames.length, 0);
    decoder.push(frame.subarray(split), (f) => frames.push(f));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].payload.toString(), 'abcdefghij');
  }
});

test('16-bit and 64-bit payload lengths are decoded', () => {
  const medium = Buffer.alloc(200, 0x61);
  const large = Buffer.alloc(70000, 0x62);
  const frames = collect(Buffer.concat([serverFrame(BINARY, medium), serverFrame(BINARY, large)]));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].payload.length, 200);
  assert.equal(frames[1].payload.length, 70000);
});

test('fragmented and control frames are reported separately', () => {
  const first = encodeFrame(TEXT, Buffer.from('one '), { fin: false });
  const ping = encodeFrame(PING, Buffer.from('p'));
  const last = encodeFrame(0x0, Buffer.from('two'));
  const frames = collect(Buffer.concat([first, ping, last]));
  assert.deepEqual(
    frames.map((f) => [f.opcode, f.fin, f.payload.toString()]),
    [
      [TEXT, false, 'one '],
      [PING, true, 'p'],
      [0x0, true, 'two'],
    ],
  );
});

test('close frames and maximum payloads are validated', () => {
  const frames = collect(serverFrame(CLOSE, Buffer.from([0x03, 0xe8])));
  assert.equal(frames[0].opcode, CLOSE);
  assert.equal(frames[0].payload.readUInt16BE(0), 1000);
  const decoder = new FrameDecoder({ maxPayload: 10 });
  assert.throws(() => decoder.push(serverFrame(BINARY, Buffer.alloc(11)), () => {}), /too large/);
});
