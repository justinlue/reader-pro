// Turns normalized text into paragraphs, detected chapter headings, and layout segments.
//
// Offsets everywhere are UTF-16 indices into `book.text`. A paragraph is one non-blank
// line with its surrounding whitespace trimmed (the reader applies its own indent).
// A segment is a run of paragraphs that is paginated independently: every segment
// starts on a fresh page, so chapters start on new pages and any one segment can be
// paginated on demand without paginating what comes before it.

const CN_NUM = '0-9０-９零〇一二三四五六七八九十百千万两';

// Ordered by level: 0 = volume/part, 1 = book/卷, 2 = chapter/回/节.
const HEADING_RULES = [
  { level: 0, max: 160, re: /^(VOLUME|Volume|PART|Part)\s+([IVXLCDM]+|\d+|[A-Z][a-z]+|[A-Z]+)\b/ },
  { level: 0, max: 40, re: new RegExp(`^第[${CN_NUM}]+[部集篇](\\s|$|[:：·、.])`) },
  { level: 1, max: 160, re: /^(BOOK|Book)\s+([IVXLCDM]+|\d+|[A-Z][a-z]+|[A-Z]+)\b/ },
  { level: 1, max: 40, re: new RegExp(`^(第[${CN_NUM}]+卷|卷[${CN_NUM}]+)(\\s|$|[:：·、.])`) },
  { level: 2, max: 160, re: /^(CHAPTER|Chapter)\s+([IVXLCDM]+|\d+|[A-Z][a-z]+|[A-Z]+)\b/ },
  { level: 2, max: 40, re: new RegExp(`^第[${CN_NUM}]+[章回节](\\s|$|[:：·、.]|[^，。！？”]*$)`) },
  { level: 2, max: 20, re: /^(序章|序言|序|楔子|引子|尾声|后记|終章|终章|番外)(\s|$|[:：·、.]|[^，。！？]{0,15}$)/ },
];

export function headingLevel(line) {
  for (const rule of HEADING_RULES) {
    if (line.length <= rule.max && rule.re.test(line)) return rule.level;
  }
  return -1;
}

// Segments longer than this (in characters) are split at a paragraph boundary, so a
// file with no headings still paginates in chunks that are cheap to lay out on demand.
export const MAX_SEGMENT_CHARS = 100_000;

const LEADING_WS = /^[\s　 ﻿]+/;
const TRAILING_WS = /[\s　 ]+$/;

export function buildBook(text) {
  const paraStart = [];
  const paraEnd = [];
  const paraLevel = []; // heading level, or -1 for body text
  let lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd);
    const lead = line.match(LEADING_WS)?.[0].length ?? 0;
    const trail = line.match(TRAILING_WS)?.[0].length ?? 0;
    if (lead < line.length) {
      const trimmed = line.slice(lead, line.length - trail);
      paraStart.push(lineStart + lead);
      paraEnd.push(lineEnd - trail);
      paraLevel.push(headingLevel(trimmed));
    }
    lineStart = lineEnd + 1;
  }

  const chapters = [];
  paraLevel.forEach((level, i) => {
    if (level >= 0) {
      chapters.push({ title: text.slice(paraStart[i], paraEnd[i]), level, para: i, offset: paraStart[i] });
    }
  });

  // A new segment starts at each heading that does not directly follow another
  // heading ("BOOK SECOND" + "CHAPTER I" share a page), and inside very long runs.
  const segments = [];
  let segFirst = 0;
  let segChars = 0;
  for (let i = 0; i < paraStart.length; i++) {
    const startsHeading = paraLevel[i] >= 0 && (i === 0 || paraLevel[i - 1] < 0);
    const tooLong = segChars > MAX_SEGMENT_CHARS;
    if (i > segFirst && (startsHeading || tooLong)) {
      segments.push({ first: segFirst, end: i });
      segFirst = i;
      segChars = 0;
    }
    segChars += paraEnd[i] - paraStart[i];
  }
  if (paraStart.length > segFirst) segments.push({ first: segFirst, end: paraStart.length });
  for (const seg of segments) {
    seg.start = paraStart[seg.first];
    seg.stop = paraEnd[seg.end - 1];
  }

  return { text, paraStart, paraEnd, paraLevel, chapters, segments, cjk: isMostlyCjk(text) };
}

// True when CJK characters dominate a sample of the text, so CJK fonts should come
// first (shared punctuation like “”…— then takes the full-width CJK glyphs).
export function isMostlyCjk(text) {
  const sample = text.slice(0, 20_000);
  const cjk = sample.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/g)?.length ?? 0;
  const letters = sample.match(/[A-Za-z\u00c0-\u024f]/g)?.length ?? 0;
  return cjk > letters;
}

// Index of the last element of a sorted array that is <= value, or -1.
export function lastAtOrBefore(sorted, value, key = (x) => x) {
  let lo = 0;
  let hi = sorted.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(sorted[mid]) <= value) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function segmentAt(book, offset) {
  return Math.max(0, lastAtOrBefore(book.segments, offset, (s) => s.start));
}

export function chapterAt(book, offset) {
  return lastAtOrBefore(book.chapters, offset, (c) => c.offset);
}
