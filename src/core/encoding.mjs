// Text decoding for .txt files: BOM sniffing, UTF-16 heuristics, UTF-8 validation,
// then GB18030 as the fallback for legacy Chinese files.

export const ENCODINGS = ['utf-8', 'gb18030', 'utf-16le', 'utf-16be', 'big5'];

export const ENCODING_LABELS = {
  'utf-8': 'UTF-8',
  gb18030: 'GB18030 / GBK',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
  big5: 'Big5',
};

function bomEncoding(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return null;
}

// BOM-less UTF-16 of mostly-ASCII text has a zero in every other byte.
function utf16Guess(bytes) {
  const n = Math.min(bytes.length, 4096) & ~1;
  if (n < 4) return null;
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) evenZeros++;
    if (bytes[i + 1] === 0) oddZeros++;
  }
  const pairs = n / 2;
  if (oddZeros / pairs > 0.3 && evenZeros / pairs < 0.05) return 'utf-16le';
  if (evenZeros / pairs > 0.3 && oddZeros / pairs < 0.05) return 'utf-16be';
  return null;
}

function isValidUtf8(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function detectEncoding(bytes) {
  return bomEncoding(bytes) ?? utf16Guess(bytes) ?? (isValidUtf8(bytes) ? 'utf-8' : 'gb18030');
}

// Decodes with the given encoding, or detects one when `encoding` is null.
// TextDecoder strips a matching BOM itself.
export function decodeText(bytes, encoding = null) {
  const used = encoding ?? detectEncoding(bytes);
  const text = new TextDecoder(used).decode(bytes);
  return { encoding: used, detected: encoding === null, text: normalizeText(text) };
}

export function normalizeText(text) {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}
