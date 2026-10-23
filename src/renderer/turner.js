// Page turning: pointer drags, click/keyboard turns, and the three animations
// (Bézier curl, slide, none). The host supplies page images and commits turns.
//
// host: {
//   image(which)  'cur' | 'next' | 'prev' -> canvas, or null
//   has(dir)      'next' | 'prev' -> whether that page exists
//   commit(dir)   the turn finished; make that page current
//   mode()        'curl' | 'slide' | 'none'
//   look()        { back, shadow } colour of the page's back, shadow strength
//   onTap(zone)   'left' | 'middle' | 'right' click without a drag
// }

import { curlPoints } from '../core/curl-geometry.mjs';

const DRAG_THRESHOLD = 6;
const TURN_MS = 420;
const SLIDE_MS = 300;

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t) => 1 - (1 - t) ** 3;
const lerp = (u, v, t) => u + (v - u) * t;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class Turner {
  constructor(canvas, host) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.host = host;
    this.W = 1;
    this.H = 1;
    this.dpr = 1;
    this.press = null; // pointer down, possibly dragging
    this.anim = null;
    this.frame = null; // what to draw instead of the static current page
  }

  setSize(W, H, dpr) {
    this.finish();
    this.press = null;
    this.W = W;
    this.H = H;
    this.dpr = dpr;
  }

  get busy() {
    return this.anim !== null || this.press?.active === true;
  }

  // ---- input -------------------------------------------------------------

  down(x, y) {
    this.finish();
    this.press = { x0: x, y0: y, x, y, active: false };
  }

  move(x, y) {
    const p = this.press;
    if (!p) return;
    p.x = x;
    p.y = y;
    if (!p.active) {
      if (Math.hypot(x - p.x0, y - p.y0) < DRAG_THRESHOLD) return;
      p.active = true;
      p.dir = p.x0 > this.W / 2 ? 'next' : 'prev';
      p.dead = !this.host.has(p.dir);
      const third = this.H / 3;
      p.corner = p.dir === 'next' && p.y0 < third ? 'tr' : p.dir === 'next' && p.y0 > 2 * third ? 'br' : 'mid';
    }
    if (p.dead) return;
    this.frame = this.dragFrame(p);
    this.paint();
  }

  up(x, y) {
    const p = this.press;
    this.press = null;
    if (!p) return;
    if (!p.active) {
      const zone = x < this.W / 3 ? 'left' : x > (2 * this.W) / 3 ? 'right' : 'middle';
      this.host.onTap(zone);
      return;
    }
    if (p.dead) return;
    const complete = p.dir === 'next' ? x < this.W / 2 : x > this.W / 2;
    this.release(this.frame, complete);
  }

  cancelPress() {
    if (this.press?.active && !this.press.dead) this.release(this.frame, false);
    this.press = null;
  }

  // Animated turn for clicks, keys and the wheel. Returns false at the book's ends.
  turn(dir) {
    this.finish();
    if (!this.host.has(dir)) return false;
    const mode = this.host.mode();
    const { W, H } = this;
    if (mode === 'none') {
      this.host.commit(dir);
      this.paint();
    } else if (mode === 'slide') {
      this.animate({ kind: 'slide', dir, p: 0 }, { p: 1 }, SLIDE_MS, easeInOut, true);
    } else {
      const from = dir === 'next' ? { x: W, y: H } : { x: -W, y: H - 1 };
      const to = dir === 'next' ? { x: -W, y: H - 1 } : { x: W, y: H };
      this.animate({ kind: 'curl', dir, corner: 'br', a: from }, { a: to }, TURN_MS, easeInOut, true, true);
    }
    return true;
  }

  dragFrame(p) {
    const { W, H } = this;
    const mode = this.host.mode();
    if (mode === 'none') return { kind: 'none', dir: p.dir };
    if (mode === 'slide') {
      const d = p.dir === 'next' ? p.x0 - p.x : p.x - p.x0;
      return { kind: 'slide', dir: p.dir, p: clamp(d / W, 0, 1) };
    }
    if (p.dir === 'prev') {
      // The previous page rolls in from the left as the pointer travels to the edge.
      const ax = -W + (2 * W * (p.x - p.x0)) / Math.max(1, W - p.x0);
      return { kind: 'curl', dir: 'prev', corner: 'br', a: { x: clamp(ax, -W, W), y: H - 1 } };
    }
    if (p.corner === 'mid') return { kind: 'curl', dir: 'next', corner: 'br', a: { x: p.x, y: H - 1 } };
    // Corner drags keep the page attached at the spine; use the corrected point.
    const pts = curlPoints(p.x, p.y, W, H, p.corner, true);
    return { kind: 'curl', dir: 'next', corner: p.corner, a: pts.a };
  }

  release(frame, complete) {
    const { W, H } = this;
    if (!frame || frame.kind === 'none') {
      this.frame = null;
      if (complete && frame) this.host.commit(frame.dir);
      this.paint();
      return;
    }
    if (frame.kind === 'slide') {
      const target = complete ? 1 : 0;
      this.animate(frame, { p: target }, Math.max(100, Math.abs(target - frame.p) * SLIDE_MS), easeOut, complete);
      return;
    }
    const edgeY = frame.corner === 'tr' ? 0 : H;
    const inward = frame.corner === 'tr' ? 1 : -1;
    let to;
    if (frame.dir === 'next') to = complete ? { x: -W, y: edgeY + inward } : { x: W, y: edgeY };
    else to = complete ? { x: W, y: H } : { x: -W, y: H - 1 };
    const dist = Math.hypot(to.x - frame.a.x, to.y - frame.a.y);
    this.animate(frame, { a: to }, clamp((dist / (2 * W)) * 500, 120, 450), easeOut, complete);
  }

  // ---- animation ---------------------------------------------------------

  animate(frame, target, duration, ease, complete, lift = false) {
    this.anim = { from: frame, target, duration, ease, complete, lift, t0: performance.now(), raf: 0 };
    this.frame = frame;
    const step = (now) => {
      const anim = this.anim;
      if (!anim) return;
      const t = clamp((now - anim.t0) / anim.duration, 0, 1);
      const e = anim.ease(t);
      const f = { ...anim.from };
      if ('p' in anim.target) f.p = lerp(anim.from.p, anim.target.p, e);
      if ('a' in anim.target) {
        f.a = { x: lerp(anim.from.a.x, anim.target.a.x, e), y: lerp(anim.from.a.y, anim.target.a.y, e) };
        // Lift the corner on a clicked turn so it arcs rather than sliding flat.
        if (anim.lift) f.a.y -= Math.sin(Math.PI * e) * this.H * 0.12;
      }
      this.frame = f;
      this.paint();
      if (t >= 1) this.end();
      else anim.raf = requestAnimationFrame(step);
    };
    this.anim.raf = requestAnimationFrame(step);
  }

  end() {
    const anim = this.anim;
    if (!anim) return;
    cancelAnimationFrame(anim.raf);
    this.anim = null;
    this.frame = null;
    if (anim.complete) this.host.commit(anim.from.dir);
    this.paint();
  }

  // Jumps a running animation to its end state.
  finish() {
    if (this.anim) this.end();
  }

  // ---- drawing -----------------------------------------------------------

  paint() {
    const { ctx, W, H, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const f = this.frame;
    const cur = this.host.image('cur');
    if (!f || f.kind === 'none') {
      if (cur) ctx.drawImage(cur, 0, 0, W, H);
      return;
    }
    const other = this.host.image(f.dir);
    if (!cur || !other) {
      if (cur) ctx.drawImage(cur, 0, 0, W, H);
      return;
    }
    const look = this.host.look();
    if (f.kind === 'slide') {
      const [left, right] = f.dir === 'next' ? [cur, other] : [other, cur];
      const p = f.dir === 'next' ? f.p : 1 - f.p;
      const seam = W * (1 - p);
      ctx.drawImage(left, -W * p, 0, W, H);
      ctx.drawImage(right, seam, 0, W, H);
      const g = ctx.createLinearGradient(seam - 14, 0, seam, 0);
      g.addColorStop(0, shade(0, look));
      g.addColorStop(1, shade(0.18, look));
      ctx.fillStyle = g;
      ctx.fillRect(seam - 14, 0, 14, H);
      return;
    }
    const [front, under] = f.dir === 'next' ? [cur, other] : [other, cur];
    const pts = curlPoints(f.a.x, f.a.y, W, H, f.corner);
    drawCurl(ctx, W, H, pts, f.corner, front, under, look);
  }
}

function shade(alpha, look) {
  return `rgba(0,0,0,${Math.min(0.9, alpha * look.shadow).toFixed(3)})`;
}

// Unit normal of line p1–p2 on the side of `toward`, or null if degenerate.
function normalToward(p1, p2, toward) {
  const vx = p2.x - p1.x;
  const vy = p2.y - p1.y;
  const len = Math.hypot(vx, vy);
  if (!(len > 1e-6) || !Number.isFinite(len)) return null;
  let n = { x: -vy / len, y: vx / len };
  if ((toward.x - p1.x) * n.x + (toward.y - p1.y) * n.y < 0) n = { x: -n.x, y: -n.y };
  return n;
}

function finitePoint(p) {
  return Number.isFinite(p.x) && Number.isFinite(p.y);
}

// Fills the canvas with a gradient that runs perpendicular to the line through
// `origin`, from `origin` for `length` px along normal `n`.
function bandGradient(ctx, W, H, origin, n, length, stops) {
  if (!n || !(length > 0.5)) return;
  const end = { x: origin.x + n.x * length, y: origin.y + n.y * length };
  if (!finitePoint(origin) || !finitePoint(end)) return;
  const g = ctx.createLinearGradient(origin.x, origin.y, end.x, end.y);
  for (const [at, color] of stops) g.addColorStop(at, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function tracePathA(ctx, p, W, H, corner) {
  const top = corner === 'tr';
  ctx.moveTo(0, top ? H : 0);
  ctx.lineTo(0, top ? 0 : H);
  ctx.lineTo(p.c.x, p.c.y);
  ctx.quadraticCurveTo(p.e.x, p.e.y, p.b.x, p.b.y);
  ctx.lineTo(p.a.x, p.a.y);
  ctx.lineTo(p.k.x, p.k.y);
  ctx.quadraticCurveTo(p.h.x, p.h.y, p.j.x, p.j.y);
  ctx.lineTo(W, top ? H : 0);
  ctx.closePath();
}

function traceFlap(ctx, p) {
  ctx.moveTo(p.d.x, p.d.y);
  ctx.lineTo(p.b.x, p.b.y);
  ctx.lineTo(p.a.x, p.a.y);
  ctx.lineTo(p.k.x, p.k.y);
  ctx.lineTo(p.i.x, p.i.y);
  ctx.closePath();
}

function clipOutsideFront(ctx, p, W, H, corner) {
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  tracePathA(ctx, p, W, H, corner);
  ctx.clip('evenodd');
}

function drawCurl(ctx, W, H, p, corner, front, under, look) {
  const size = Math.hypot(p.a.x - p.f.x, p.a.y - p.f.y);
  const reach = clamp(size / 6, 3, 40);

  // 1. The page being revealed, darkened where the lifted paper overhangs it.
  ctx.drawImage(under, 0, 0, W, H);
  ctx.save();
  clipOutsideFront(ctx, p, W, H, corner);
  const nOut = normalToward(p.d, p.i, p.f);
  bandGradient(ctx, W, H, p.d, nOut, reach * 1.4, [
    [0, shade(0.38, look)],
    [1, shade(0, look)],
  ]);
  ctx.restore();

  // 2. The still-flat part of the turning page, shaded where it starts to rise, with
  //    the shadow the folded-over flap casts on it.
  ctx.save();
  ctx.beginPath();
  tracePathA(ctx, p, W, H, corner);
  ctx.clip();
  ctx.drawImage(front, 0, 0, W, H);
  const nLift = normalToward(p.c, p.j, p.e);
  if (nLift) {
    const rise = (p.d.x - p.c.x) * nLift.x + (p.d.y - p.c.y) * nLift.y;
    bandGradient(ctx, W, H, p.c, nLift, rise, [
      [0, shade(0, look)],
      [0.6, shade(0.06, look)],
      [1, shade(0.22, look)],
    ]);
  }
  const inside = { x: (p.d.x + p.i.x) / 2, y: (p.d.y + p.i.y) / 2 };
  for (const [u, v] of [[p.a, p.b], [p.a, p.k]]) {
    const n = normalToward(u, v, inside);
    if (!n) continue;
    const away = { x: -n.x, y: -n.y };
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(u.x, u.y);
    ctx.lineTo(v.x, v.y);
    ctx.lineTo(v.x + away.x * reach, v.y + away.y * reach);
    ctx.lineTo(u.x + away.x * reach, u.y + away.y * reach);
    ctx.closePath();
    ctx.clip();
    bandGradient(ctx, W, H, u, away, reach * 0.8, [
      [0, shade(0.26, look)],
      [1, shade(0, look)],
    ]);
    ctx.restore();
  }
  ctx.restore();

  // 3. The back of the turning page: plain paper, darkest along the fold.
  ctx.save();
  clipOutsideFront(ctx, p, W, H, corner);
  ctx.beginPath();
  traceFlap(ctx, p);
  ctx.clip();
  ctx.fillStyle = look.back;
  ctx.fillRect(0, 0, W, H);
  const nBack = normalToward(p.d, p.i, p.a);
  if (nBack) {
    const depth = (p.a.x - p.d.x) * nBack.x + (p.a.y - p.d.y) * nBack.y;
    bandGradient(ctx, W, H, p.d, nBack, depth, [
      [0, shade(0.3, look)],
      [0.12, shade(0.1, look)],
      [0.45, shade(0, look)],
      [1, shade(0.07, look)],
    ]);
  }
  ctx.restore();

  ctx.beginPath();
  ctx.moveTo(p.b.x, p.b.y);
  ctx.lineTo(p.a.x, p.a.y);
  ctx.lineTo(p.k.x, p.k.y);
  ctx.strokeStyle = shade(0.18, look);
  ctx.lineWidth = 0.7;
  ctx.stroke();
}
