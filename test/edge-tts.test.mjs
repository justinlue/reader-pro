import test from 'node:test';
import assert from 'node:assert/strict';
import { secMsGec } from '../src/main/edge-tts.js';

const FORMAT = /^[0-9A-F]{16}-[0-9A-F]{64}$/;

test('Sec-MS-GEC v2 token matches the documented algorithm', () => {
  // Fixed timestamp: 2026-01-01T00:00:00Z.
  assert.equal(
    secMsGec(1767225600000),
    '723A6EBC411B23BB-214991EA6B1E401F3D777A699DDDEE75E29740EA7A5DCD1007366FA1090DD267',
  );
  assert.match(secMsGec(Date.now()), FORMAT);
});

test('Sec-MS-GEC is stable inside a five-minute window and rotates after it', () => {
  const base = 1767225600000;
  assert.equal(secMsGec(base), secMsGec(base + 299_999));
  assert.notEqual(secMsGec(base), secMsGec(base + 300_000));
});
