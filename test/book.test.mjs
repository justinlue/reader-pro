import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBook, headingLevel, isMostlyCjk, segmentAt, chapterAt, MAX_SEGMENT_CHARS } from '../src/core/book.mjs';
import { decodeText } from '../src/core/encoding.mjs';
import { hasSample, sampleBytes } from './helpers.mjs';

test('heading detection, English and Chinese', () => {
  assert.equal(headingLevel('VOLUME II'), 0);
  assert.equal(headingLevel('BOOK SECOND—THE FALL'), 1);
  assert.equal(headingLevel('CHAPTER I—M. MYRIEL'), 2);
  assert.equal(headingLevel('Chapter 12'), 2);
  assert.equal(headingLevel('第一章 少年'), 2);
  assert.equal(headingLevel('第123章'), 2);
  assert.equal(headingLevel('第十回 大闹天宫'), 2);
  assert.equal(headingLevel('第三卷 风起'), 1);
  assert.equal(headingLevel('卷一'), 1);
  assert.equal(headingLevel('楔子'), 2);
  assert.equal(headingLevel('Chapters of his life were long.'), -1);
  assert.equal(headingLevel('第一次见面，他就笑了。'), -1);
  assert.equal(headingLevel('第一章的内容很长，' + '字'.repeat(50)), -1);
});

test('decimal-numbered section headings, as in textbooks', () => {
  assert.equal(headingLevel('1.1 What can we expect'), 1);
  assert.equal(headingLevel('1.2.3 Reduced row echelon form'), 2);
  assert.equal(headingLevel('12.10.4 Exercises'), 2);
  assert.equal(headingLevel('2.3.1.4 Deeper still'), 2);
  assert.equal(headingLevel('3.2 线性方程组'), 1);
  assert.equal(headingLevel('1. Give a brief explanation of your response.'), -1);
  assert.equal(headingLevel('1\t2\t0\t3'), -1);
  assert.equal(headingLevel('3.5 million people fled the city that winter.'), -1);
  assert.equal(headingLevel('2.5 kg of flour, sifted twice'), -1);
  assert.equal(headingLevel('1.4 Why does this work?'), 1);
  assert.equal(headingLevel('1.1. Introduction'), 1);
  assert.equal(headingLevel('2.3.1. Row operations'), 2);
  assert.equal(headingLevel('2.1 Definitions:'), -1);
  assert.equal(headingLevel('1.1' + ' Word'.repeat(20)), -1);
});

test('CJK-dominant text is recognised', () => {
  assert.equal(isMostlyCjk('第一章 他抬起头，望着窗外的雨。Hello'), true);
  assert.equal(isMostlyCjk('CHAPTER I—M. MYRIEL. In 1815, 世界'), false);
});

test('paragraphs are trimmed and blank lines dropped', () => {
  const text = '　　第一段\n\n   second   \n\t\n第三';
  const book = buildBook(text);
  const paras = book.paraStart.map((s, i) => text.slice(s, book.paraEnd[i]));
  assert.deepEqual(paras, ['第一段', 'second', '第三']);
});

test('segments start at headings; consecutive headings share a segment', () => {
  const book = buildBook('front matter\nBOOK FIRST—A\nCHAPTER I—X\nbody one\nCHAPTER II—Y\nbody two');
  assert.deepEqual(book.segments.map((s) => [s.first, s.end]), [[0, 1], [1, 4], [4, 6]]);
  assert.deepEqual(book.chapters.map((c) => [c.title, c.level]), [
    ['BOOK FIRST—A', 1],
    ['CHAPTER I—X', 2],
    ['CHAPTER II—Y', 2],
  ]);
  assert.equal(segmentAt(book, book.text.indexOf('body two')), 2);
  assert.equal(chapterAt(book, book.text.indexOf('body one')), 1);
  assert.equal(chapterAt(book, 0), -1);
});

test('headingless text is split into bounded segments', () => {
  const para = 'x'.repeat(1000);
  const book = buildBook(Array(250).fill(para).join('\n'));
  assert.ok(book.segments.length >= 2);
  for (const s of book.segments) assert.ok(s.stop - s.start <= MAX_SEGMENT_CHARS + 2000);
});

test('sample.txt: all 228 chapters, 27 books and volumes', { skip: !hasSample && 'sample.txt not present' }, () => {
  const book = buildBook(decodeText(sampleBytes()).text);
  const byLevel = [0, 0, 0];
  for (const c of book.chapters) byLevel[c.level]++;
  assert.equal(byLevel[2], 228);
  assert.equal(byLevel[0] + byLevel[1], 27);
  assert.equal(book.chapters[0].title, 'CHAPTER I—M. MYRIEL');
});
