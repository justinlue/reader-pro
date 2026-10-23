// Geometry of a Bézier page curl (the classic "simulated page turn").
//
// The page is W×H and is curled from corner f (bottom-right or top-right) towards the
// touch point a. With g the midpoint of a–f, the fold line is the perpendicular bisector
// of a–f; it meets the page edges at e (horizontal edge) and h (vertical edge). The curl
// begins on the line c–j, which is parallel to the fold and halfway between it and the
// spine side. b and k are where a–e and a–h cross c–j; quadratic Béziers c→(e)→b and
// j→(h)→k form the rounded edges of the lifted paper, and d and i (their midpoints)
// bound the visible back of the page:
//
//   still-flat front page:  0,0 → 0,H → c ~e~ b → a → k ~h~ j → W,0      (bottom-right)
//   back of the page:       d → b → a → k → i
//
// Everything is computed for the bottom-right corner; a top-right curl is the same
// figure mirrored vertically.

const EPS = 0.5;

function intersect(p1, p2, p3, p4) {
  const a1 = p2.y - p1.y;
  const b1 = p1.x - p2.x;
  const c1 = a1 * p1.x + b1 * p1.y;
  const a2 = p4.y - p3.y;
  const b2 = p3.x - p4.x;
  const c2 = a2 * p3.x + b2 * p3.y;
  const det = a1 * b2 - a2 * b1;
  if (Math.abs(det) < 1e-9) return { x: (p2.x + p3.x) / 2, y: (p2.y + p3.y) / 2 };
  return { x: (b2 * c1 - b1 * c2) / det, y: (a1 * c2 - a2 * c1) / det };
}

// Keeps a strictly inside the corner so no denominator below is zero.
function guard(a, W, H) {
  return { x: Math.min(a.x, W - EPS), y: Math.min(a.y, H - EPS) };
}

function points(a, W, H) {
  const f = { x: W, y: H };
  const g = { x: (a.x + f.x) / 2, y: (a.y + f.y) / 2 };
  const e = { x: g.x - ((f.y - g.y) * (f.y - g.y)) / (f.x - g.x), y: f.y };
  const h = { x: f.x, y: g.y - ((f.x - g.x) * (f.x - g.x)) / (f.y - g.y) };
  const c = { x: e.x - (f.x - e.x) / 2, y: f.y };
  const j = { x: f.x, y: h.y - (f.y - h.y) / 2 };
  const b = intersect(a, e, c, j);
  const k = intersect(a, h, c, j);
  const d = { x: (c.x + 2 * e.x + b.x) / 4, y: (2 * e.y + c.y + b.y) / 4 };
  const i = { x: (j.x + 2 * h.x + k.x) / 4, y: (2 * h.y + j.y + k.y) / 4 };
  return { a, f, g, e, h, c, j, b, k, d, i };
}

function flip(pts, H) {
  const out = {};
  for (const [name, p] of Object.entries(pts)) out[name] = { x: p.x, y: H - p.y };
  return out;
}

// Curl points for touch point (ax, ay) in page coordinates. corner is 'br' or 'tr'.
// With `pinned`, a is pulled back towards the corner so the curl never starts left of
// the spine (c.x >= 0) — used while dragging, where the paper must stay attached.
export function curlPoints(ax, ay, W, H, corner = 'br', pinned = false) {
  const local = corner === 'tr' ? { x: ax, y: H - ay } : { x: ax, y: ay };
  let a = guard(local, W, H);
  let pts = points(a, W, H);
  if (pinned && pts.c.x < 0) {
    const w0 = W - pts.c.x;
    const w1 = Math.abs(W - a.x);
    const w2 = (W * w1) / w0;
    const h1 = Math.abs(H - a.y);
    const h2 = (w2 * h1) / w1;
    a = guard({ x: Math.abs(W - w2), y: Math.abs(H - h2) }, W, H);
    pts = points(a, W, H);
  }
  return corner === 'tr' ? flip(pts, H) : pts;
}
