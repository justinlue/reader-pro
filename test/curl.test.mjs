import test from 'node:test';
import assert from 'node:assert/strict';
import { curlPoints } from '../src/core/curl-geometry.mjs';

const W = 800;
const H = 1000;
const finite = (pts) => Object.values(pts).every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
const dist = (u, v) => Math.hypot(u.x - v.x, u.y - v.y);

test('bottom-right curl: fold points lie on the page edges', () => {
  const p = curlPoints(500, 800, W, H, 'br');
  assert.ok(finite(p));
  assert.equal(p.e.y, H);
  assert.equal(p.h.x, W);
  assert.equal(p.c.y, H);
  assert.equal(p.j.x, W);
  // e and h are on the perpendicular bisector of a–f.
  assert.ok(Math.abs(dist(p.e, p.a) - dist(p.e, p.f)) < 1e-6);
  assert.ok(Math.abs(dist(p.h, p.a) - dist(p.h, p.f)) < 1e-6);
});

test('top-right curl mirrors the bottom-right one', () => {
  const br = curlPoints(500, 800, W, H, 'br');
  const tr = curlPoints(500, H - 800, W, H, 'tr');
  for (const name of Object.keys(br)) {
    assert.ok(Math.abs(br[name].x - tr[name].x) < 1e-9);
    assert.ok(Math.abs(br[name].y - (H - tr[name].y)) < 1e-9);
  }
});

test('pinned curl never starts left of the spine', () => {
  const p = curlPoints(-300, 200, W, H, 'br', true);
  assert.ok(finite(p));
  assert.ok(p.c.x >= -1e-6, `c.x = ${p.c.x}`);
});

test('degenerate touch points stay finite', () => {
  for (const [x, y] of [[W, H], [W, 0], [W + 50, H + 50], [-W, H - 1], [0, H], [W - 0.5, H - 0.5]]) {
    assert.ok(finite(curlPoints(x, y, W, H, 'br')), `${x},${y}`);
  }
});
