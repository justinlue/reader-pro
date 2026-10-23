import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBook } from '../src/core/book.mjs';
import { decodeText } from '../src/core/encoding.mjs';
import { breakLine, layoutPage, pageIndexAt, paginateSegment, placeLine, tokenEnd } from '../src/core/layout.mjs';
import { METRICS, fakeMeasure, hasSample, sampleBytes } from './helpers.mjs';

function tokens(text) {
  const out = [];
  for (let i = 0; i < text.length; ) {
    const t = tokenEnd(text, i, text.length);
    out.push(text.slice(i, t));
    i = t;
  }
  return out;
}

test('tokenizer: words, spaces, CJK and punctuation gluing', () => {
  assert.deepEqual(tokens('Hello, world.'), ['Hello,', ' ', 'world.']);
  assert.deepEqual(tokens('他说：「好的。」'), ['他', '说：', '「好', '的。」']);
  assert.deepEqual(tokens('用Python写'), ['用', 'Python', '写']);
  assert.deepEqual(tokens('等等……'), ['等', '等……']);
});

test('breakLine is greedy and never splits words that fit', () => {
  const text = 'aaa bbb ccc ddd';
  assert.equal(breakLine(text, 0, text.length, 75, fakeMeasure), 7); // "aaa bbb" = 70
  assert.equal(breakLine(text, 8, text.length, 75, fakeMeasure), 15);
});

test('breakLine force-breaks a word longer than the line', () => {
  const text = 'abcdefghij';
  assert.equal(breakLine(text, 0, text.length, 45, fakeMeasure), 4);
});

test('closing punctuation never starts a CJK line', () => {
  const text = '一二三四。五六';
  // Fits 4 wide chars (80px); "四。" is one token so it moves down as a pair.
  const end = breakLine(text, 0, text.length, 80, fakeMeasure);
  assert.equal(text.slice(0, end), '一二三');
});

test('pages tile each segment exactly and are reproducible from their starts', () => {
  const body = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ` + 'word '.repeat(20 + (i % 7))).join('\n');
  const book = buildBook(`CHAPTER I—START\n${body}\nCHAPTER II—NEXT\n${body}`);
  for (let s = 0; s < book.segments.length; s++) {
    const starts = paginateSegment(book, s, METRICS, fakeMeasure);
    assert.equal(starts[0], book.segments[s].start);
    starts.forEach((start, idx) => {
      const page = layoutPage(book, s, start, METRICS, fakeMeasure);
      const expectedEnd = idx + 1 < starts.length ? starts[idx + 1] : book.segments[s].stop;
      assert.equal(page.end, expectedEnd);
      const last = page.lines.at(-1);
      assert.ok(last.y + METRICS.lineHeight <= METRICS.height, 'page overflows');
      for (const line of page.lines) {
        assert.ok(fakeMeasure(book.text.slice(line.start, line.end), line.kind) <= METRICS.width - line.indent);
      }
    });
  }
});

test('first-line indent and justification flags', () => {
  const book = buildBook('word '.repeat(40).trim());
  const page = layoutPage(book, 0, 0, METRICS, fakeMeasure);
  assert.equal(page.lines[0].indent, METRICS.indent);
  assert.equal(page.lines[1].indent, 0);
  assert.ok(page.lines.slice(0, -1).every((l) => l.justify));
  assert.equal(page.lines.at(-1).justify, false);
});

test('placeLine justifies to the full width', () => {
  const text = 'aa bb cc';
  const line = { start: 0, end: text.length, kind: 'body', indent: 0, justify: true };
  const placed = placeLine(text, line, 90, fakeMeasure);
  assert.deepEqual(placed.map((p) => p.str), ['aa', 'bb', 'cc']);
  assert.equal(placed.at(-1).x + fakeMeasure('cc'), 90);
});

test('saved offsets map back to the page that contains them', () => {
  const body = Array.from({ length: 60 }, (_, i) => `Para ${i} ` + 'text '.repeat(15)).join('\n');
  const book = buildBook(body);
  const starts = paginateSegment(book, 0, METRICS, fakeMeasure);
  assert.ok(starts.length > 5);
  const target = starts[3] + 7;
  assert.equal(pageIndexAt(starts, target), 3);
  assert.equal(pageIndexAt(starts, starts[3]), 3);
  assert.equal(pageIndexAt(starts, 0), 0);
  // The same offset under different metrics still lands on a page containing it.
  const wide = { ...METRICS, width: 500 };
  const wideStarts = paginateSegment(book, 0, wide, fakeMeasure);
  const idx = pageIndexAt(wideStarts, target);
  const page = layoutPage(book, 0, wideStarts[idx], wide, fakeMeasure);
  assert.ok(page.start <= target && target < page.end);
});

test('sample.txt paginates completely', { skip: !hasSample && 'sample.txt not present' }, () => {
  const book = buildBook(decodeText(sampleBytes()).text);
  const metrics = { ...METRICS, width: 600, height: 700 };
  let pages = 0;
  for (let s = 0; s < book.segments.length; s++) pages += paginateSegment(book, s, metrics, fakeMeasure).length;
  assert.ok(pages > 1000, `only ${pages} pages`);
});
