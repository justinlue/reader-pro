// Line breaking and pagination, independent of any rendering surface.
//
// The caller supplies `measure(str, kind)` returning a width in px, where kind is
// 'body' or 'heading'. Layout is greedy and memoryless across lines, so laying out a
// page from its start offset always reproduces the same lines; a pagination is
// therefore just the list of page start offsets for each segment.

import { lastAtOrBefore } from './book.mjs';

// Punctuation that must not start a line (attaches to the preceding token)…
const CLOSERS = new Set(
  '，。、；：！？）》」』】〕〉〗〙〛”’…—～·．・％,.;:!?)]}%'.split(''),
);
// …and punctuation that must not end a line (attaches to the following token).
const OPENERS = new Set('（《「『【〔〈〖〘〚“‘([{'.split(''));

function isSpace(code) {
  return code === 32 || code === 9 || code === 0x3000 || code === 0xa0;
}

function isWide(cp) {
  return (
    (cp >= 0x2e80 && cp <= 0x9fff) || // CJK radicals, kana, unified ideographs
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x20000 && cp <= 0x3134f)
  );
}

function cpLen(cp) {
  return cp > 0xffff ? 2 : 1;
}

// End index of the token starting at i (i < end). A token is a run of spaces, one wide
// character, or a run of narrow non-space characters; openers glue to what follows
// and closers glue to what precedes.
export function tokenEnd(text, i, end) {
  if (isSpace(text.charCodeAt(i))) {
    let j = i + 1;
    while (j < end && isSpace(text.charCodeAt(j))) j++;
    return j;
  }
  let j = i;
  while (j < end && OPENERS.has(text[j])) j++;
  if (j < end && !isSpace(text.charCodeAt(j))) {
    const cp = text.codePointAt(j);
    if (isWide(cp)) {
      j += cpLen(cp);
    } else {
      while (j < end) {
        const c = text.codePointAt(j);
        if (isSpace(c) || isWide(c)) break;
        j += cpLen(c);
      }
    }
  }
  while (j < end && CLOSERS.has(text[j])) j++;
  return j;
}

export function isSpaceToken(text, start) {
  return isSpace(text.charCodeAt(start));
}

function skipSpaces(text, i, end) {
  while (i < end && isSpace(text.charCodeAt(i))) i++;
  return i;
}

// Longest prefix of text[start, end) that fits in avail; at least one code point.
function forcedBreak(text, start, end, avail, measure, kind) {
  let j = start + cpLen(text.codePointAt(start));
  while (j < end) {
    const next = j + cpLen(text.codePointAt(j));
    if (measure(text.slice(start, next), kind) > avail) break;
    j = next;
  }
  return j;
}

// Greedy line break: returns the end offset of the line starting at `start`.
// Trailing spaces are not part of the returned line.
export function breakLine(text, start, end, avail, measure, kind = 'body') {
  let x = 0;
  let lineEnd = start;
  let i = start;
  while (i < end) {
    const t = tokenEnd(text, i, end);
    const w = measure(text.slice(i, t), kind);
    if (isSpace(text.charCodeAt(i))) {
      x += w;
    } else {
      if (x + w > avail) {
        if (lineEnd > start) return lineEnd;
        return forcedBreak(text, i, t, avail, measure, kind);
      }
      x += w;
      lineEnd = t;
    }
    i = t;
  }
  return lineEnd;
}

// metrics: { width, height, lineHeight, headingLineHeight, paraSpacing, headingGap, indent }
//
// Lays out one page starting at `offset` inside segment `seg`. Returns
// { start, end, lines } where `end` is the start offset of the following page and each
// line is { start, end, y, kind, indent, justify }. `y` is the top of the line box
// relative to the text area.
export function layoutPage(book, seg, offset, metrics, measure) {
  const { text, paraStart, paraEnd, paraLevel } = book;
  const segment = book.segments[seg];
  let p = Math.max(segment.first, lastAtOrBefore(paraStart, offset));
  let pos = offset;
  if (pos >= paraEnd[p]) {
    p++;
    pos = paraStart[p];
  }
  pos = Math.max(pos, paraStart[p]);

  const lines = [];
  let y = 0;
  // A segment's opening heading gets breathing room at the top of its page.
  if (offset === segment.start && paraLevel[p] >= 0) y = metrics.lineHeight;

  for (; p < segment.end; p++) {
    const heading = paraLevel[p] >= 0;
    const kind = heading ? 'heading' : 'body';
    const lh = heading ? metrics.headingLineHeight : metrics.lineHeight;
    const pEnd = paraEnd[p];
    if (pos === paraStart[p] && lines.length > 0) {
      const gap = paraLevel[p - 1] >= 0 && !heading ? metrics.headingGap : metrics.paraSpacing;
      if (y + gap + lh > metrics.height) return { start: offset, end: pos, lines };
      y += gap;
    }
    while (pos < pEnd) {
      if (y + lh > metrics.height && lines.length > 0) return { start: offset, end: pos, lines };
      const indent = !heading && pos === paraStart[p] ? metrics.indent : 0;
      const lineEnd = breakLine(text, pos, pEnd, metrics.width - indent, measure, kind);
      const next = skipSpaces(text, lineEnd, pEnd);
      lines.push({ start: pos, end: lineEnd, y, kind, indent, justify: !heading && next < pEnd });
      y += lh;
      pos = next;
    }
    if (p + 1 < segment.end) pos = paraStart[p + 1];
  }
  return { start: offset, end: segment.stop, lines };
}

// Start offsets of every page in segment `seg`.
export function paginateSegment(book, seg, metrics, measure) {
  const segment = book.segments[seg];
  const starts = [];
  let offset = segment.start;
  while (offset < segment.stop) {
    starts.push(offset);
    const page = layoutPage(book, seg, offset, metrics, measure);
    if (page.end <= offset) throw new Error(`layout made no progress at offset ${offset}`);
    offset = page.end;
  }
  return starts;
}

// Page index within a segment's starts whose page contains `offset`.
export function pageIndexAt(starts, offset) {
  return Math.max(0, lastAtOrBefore(starts, offset));
}

// Splits a laid-out line into drawable pieces with x positions, spreading the slack
// over the gaps between tokens when the line is justified.
export function placeLine(text, line, avail, measure) {
  const pieces = [];
  let natural = 0;
  let i = line.start;
  while (i < line.end) {
    const t = tokenEnd(text, i, line.end);
    const str = text.slice(i, t);
    const w = measure(str, line.kind);
    pieces.push({ str, w, space: isSpace(text.charCodeAt(i)) });
    natural += w;
    i = t;
  }
  const words = pieces.filter((pc) => !pc.space);
  const gaps = words.length - 1;
  const width = avail - line.indent;
  const slack = width - natural;
  // Very loose lines (a long word pushed down) look worse justified than ragged.
  const perGap = line.justify && gaps > 0 && slack > 0 && slack < width * 0.25 ? slack / gaps : 0;
  let x = line.kind === 'heading' ? Math.max(0, (avail - natural) / 2) : line.indent;
  const placed = [];
  let seenWord = false;
  for (const pc of pieces) {
    if (pc.space) {
      x += pc.w;
      continue;
    }
    if (seenWord) x += perGap;
    placed.push({ str: pc.str, x });
    x += pc.w;
    seenWord = true;
  }
  return placed;
}
