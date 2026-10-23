import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeText, detectEncoding } from '../src/core/encoding.mjs';
import { hasSample, sampleBytes } from './helpers.mjs';

const GBK_HELLO = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3, 0xa3, 0xac, 0xca, 0xc0, 0xbd, 0xe7]); // 你好，世界

function utf16(str, littleEndian, bom) {
  const out = [];
  if (bom) out.push(...(littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]));
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    out.push(...(littleEndian ? [c & 0xff, c >> 8] : [c >> 8, c & 0xff]));
  }
  return new Uint8Array(out);
}

test('plain UTF-8 is detected and decoded', () => {
  const bytes = new TextEncoder().encode('Héllo 世界\r\nline two');
  const r = decodeText(bytes);
  assert.equal(r.encoding, 'utf-8');
  assert.equal(r.text, 'Héllo 世界\nline two');
});

test('UTF-8 BOM is stripped', () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('abc')]);
  assert.deepEqual(decodeText(bytes), { encoding: 'utf-8', detected: true, text: 'abc' });
});

test('invalid UTF-8 falls back to GB18030', () => {
  const r = decodeText(GBK_HELLO);
  assert.equal(r.encoding, 'gb18030');
  assert.equal(r.text, '你好，世界');
});

test('UTF-16 with and without BOM', () => {
  assert.equal(decodeText(utf16('Hello\r\nWorld', true, true)).text, 'Hello\nWorld');
  assert.equal(decodeText(utf16('Hello 世界', false, true)).text, 'Hello 世界');
  assert.equal(detectEncoding(utf16('Plain ASCII text here', true, false)), 'utf-16le');
  assert.equal(detectEncoding(utf16('Plain ASCII text here', false, false)), 'utf-16be');
});

test('explicit encoding overrides detection', () => {
  const r = decodeText(GBK_HELLO, 'big5');
  assert.equal(r.encoding, 'big5');
  assert.equal(r.detected, false);
  assert.notEqual(r.text, '你好，世界');
});

test('lone CR line endings are normalized', () => {
  assert.equal(decodeText(new TextEncoder().encode('a\rb\r\nc')).text, 'a\nb\nc');
});

test('sample.txt decodes as UTF-8', { skip: !hasSample && 'sample.txt not present' }, () => {
  const r = decodeText(sampleBytes());
  assert.equal(r.encoding, 'utf-8');
  assert.ok(r.text.startsWith('CHAPTER I—M. MYRIEL\n'));
  assert.ok(!r.text.includes('\r'));
});
