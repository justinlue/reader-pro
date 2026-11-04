// Speech helpers for the audiobook: page text sent to Edge TTS, safe chunking, and
// mapping the service's word-boundary timings back to book offsets.
//
// Edge TTS returns word boundaries in audio time, not character offsets. The text it
// reports is matched against the page text in order, which survives line breaks and
// indentation. A boundary the service normalised (for example "1815" spoken as
// "eighteen fifteen") is placed by interpolating between its neighbouring matches.

const CONTROL = /[\u0000-\u001f\u007f\ufeff\u200b]/g;
const encoder = new TextEncoder();

const utf8Bytes = (ch) => encoder.encode(ch).length;

// Page slice to speak. Control characters (including line breaks) become spaces while
// the length is preserved, so offsets in the returned string still index the page.
export function speechText(text, start = 0, end = text.length) {
  return text.slice(start, end).replace(CONTROL, ' ');
}

// Splits text into requests no larger than maxBytes. `charBytes` lets the caller charge
// for XML escaping; the default is raw UTF-8. Breaks prefer whitespace, falling back to
// the last code point that fits, and the chunks always cover the whole text.
export function splitSpeech(text, maxBytes = 3500, charBytes = utf8Bytes) {
  const chunks = [];
  if (!text) return chunks;
  let start = 0;
  let size = 0;
  let lastSpace = -1;
  let i = 0;
  while (i < text.length) {
    const ch = String.fromCodePoint(text.codePointAt(i));
    const bytes = charBytes(ch);
    if (i > start && size + bytes > maxBytes) {
      const end = lastSpace > start ? lastSpace : i;
      chunks.push({ start, end });
      start = end;
      size = 0;
      lastSpace = -1;
      i = start;
      continue;
    }
    size += bytes;
    if (i > start && /\s/.test(ch)) lastSpace = i;
    i += ch.length;
    if (size > maxBytes && i === start + ch.length) {
      // A single code point is larger than the limit; it still forms a chunk.
      chunks.push({ start, end: i });
      start = i;
      size = 0;
      lastSpace = -1;
    }
  }
  if (start < text.length) chunks.push({ start, end: text.length });
  return chunks;
}

// A voice for text when the reader has not chosen one. Kana and Hangul are checked
// before Han so Japanese and Korean do not fall back to a Chinese voice.
export function autoVoice(text) {
  const sample = text.slice(0, 8000);
  if (/[\u3040-\u30ff]/.test(sample)) return 'ja-JP-NanamiNeural';
  if (/[\uac00-\ud7af]/.test(sample)) return 'ko-KR-SunHiNeural';
  const han = (sample.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latin = (sample.match(/[A-Za-z\u00c0-\u024f]/g) ?? []).length;
  return han > latin ? 'zh-CN-XiaoxiaoNeural' : 'en-US-AriaNeural';
}

function normalizeWord(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Same-length punctuation folding, so a service word and the source can differ in
// typographic quotes or dashes without losing index mapping.
function fold(value) {
  return value.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, '-');
}

// Collapses whitespace runs to one space and records the source index of every
// normalized code unit. The final entry maps the end of the string.
function normalizeWithMap(text) {
  let out = '';
  const map = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      const run = i;
      while (i < text.length && /\s/.test(text[i])) i++;
      if (out.length > 0 && !out.endsWith(' ')) {
        out += ' ';
        map.push(run);
      }
      continue;
    }
    out += text[i];
    map.push(i);
    i++;
  }
  if (out.endsWith(' ')) {
    out = out.slice(0, -1);
    map.pop();
  }
  map.push(text.length);
  return { text: out, map };
}

function trimPunctuation(value) {
  return value.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

// Bounds of the whitespace-delimited token containing (or following) pos.
function tokenRangeAt(text, pos) {
  let at = Math.min(Math.max(0, pos), text.length);
  while (at < text.length && /\s/.test(text[at])) at++;
  if (at >= text.length) {
    at = Math.min(Math.max(0, pos), text.length) - 1;
    while (at >= 0 && /\s/.test(text[at])) at--;
    if (at < 0) return null;
  }
  let start = at;
  let end = at + 1;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  while (end < text.length && !/\s/.test(text[end])) end++;
  return { start, end };
}

// words: [{ startMs, durationMs, text }] in the order the service reported them.
// Returns [{ start, end, startMs, endMs }] with absolute book offsets.
export function alignSpeechWords(pageText, pageStart, words) {
  const normalized = normalizeWithMap(pageText);
  const hay = normalized.text;
  const hayLower = hay.toLowerCase();
  const foldedHay = fold(hay);
  const hasLower = hayLower.length === hay.length;

  let cursor = 0;
  const bounds = [];
  for (const word of words) {
    const startMs = Number(word.startMs);
    const durationMs = Number(word.durationMs) || 0;
    const entry = {
      startMs: Number.isFinite(startMs) ? Math.max(0, startMs) : NaN,
      durationMs: Math.max(0, durationMs),
      range: null,
    };
    bounds.push(entry);
    if (!Number.isFinite(entry.startMs)) continue;

    const needle = normalizeWord(word.text);
    if (!needle) continue;
    let idx = hay.indexOf(needle, cursor);
    let used = needle;
    if (idx < 0 && hasLower) {
      idx = hayLower.indexOf(needle.toLowerCase(), cursor);
    }
    if (idx < 0) {
      const stripped = trimPunctuation(needle);
      if (stripped && stripped !== needle) {
        idx = hay.indexOf(stripped, cursor);
        used = stripped;
        if (idx < 0 && hasLower) idx = hayLower.indexOf(stripped.toLowerCase(), cursor);
      }
    }
    if (idx < 0) {
      const folded = fold(needle);
      if (folded !== needle) {
        idx = foldedHay.indexOf(folded, cursor);
        used = folded;
      }
    }
    if (idx < 0) continue;
    entry.range = { start: normalized.map[idx], end: normalized.map[idx + used.length] };
    cursor = idx + used.length;
  }

  // Interpolate the boundaries the service normalised into words we could not find.
  const anchors = bounds.filter((b) => b.range);
  for (const entry of bounds) {
    if (entry.range || !Number.isFinite(entry.startMs)) continue;
    const prev = [...anchors].reverse().find((a) => a.startMs <= entry.startMs);
    const next = anchors.find((a) => a.startMs > entry.startMs);
    const fromTime = prev ? prev.startMs + prev.durationMs : 0;
    const fromPos = prev ? prev.range.end : 0;
    const toTime = next ? next.startMs : Math.max(entry.startMs + entry.durationMs, fromTime + 1);
    const toPos = next ? next.range.start : pageText.length;
    const ratio = toTime > fromTime ? Math.min(1, Math.max(0, (entry.startMs - fromTime) / (toTime - fromTime))) : 1;
    const pos = Math.round(fromPos + ratio * (toPos - fromPos));
    const token = tokenRangeAt(pageText, pos);
    if (token) entry.range = token;
  }

  const out = [];
  for (const entry of bounds) {
    if (!entry.range || !Number.isFinite(entry.startMs)) continue;
    const endMs = entry.startMs + Math.max(1, entry.durationMs);
    out.push({
      start: pageStart + entry.range.start,
      end: pageStart + entry.range.end,
      startMs: entry.startMs,
      endMs,
    });
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

// Index of the last word whose playback has started at ms, or -1 before the first.
export function wordIndexAt(words, ms) {
  let lo = 0;
  let hi = words.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].startMs <= ms) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
