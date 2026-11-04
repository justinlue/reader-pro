import test from 'node:test';
import assert from 'node:assert/strict';
import { alignSpeechWords, autoVoice, speechText, splitSpeech, wordIndexAt } from '../src/core/speech.mjs';

const word = (text, startMs, durationMs) => ({ text, startMs, durationMs });

test('speechText keeps offsets while removing characters the service rejects', () => {
  const text = 'one\ntwo\tthree\u0000four\u200b';
  const spoken = speechText(text);
  assert.equal(spoken.length, text.length);
  assert.equal(spoken, 'one two three four ');
  assert.equal(speechText('abcdef', 2, 5), 'cde');
});

test('splitSpeech covers the text and respects the byte budget', () => {
  const text = 'alpha beta gamma delta epsilon zeta eta theta';
  const chunks = splitSpeech(text, 12, (ch) => ch.length);
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks.at(-1).end, text.length);
  for (let i = 0; i < chunks.length; i++) {
    const { start, end } = chunks[i];
    assert.ok(end > start);
    assert.ok(end - start <= 12);
    if (i > 0) assert.equal(start, chunks[i - 1].end);
  }
});

test('splitSpeech handles CJK, emoji and an oversized single code point', () => {
  const cjk = '\u4e2d'.repeat(200);
  for (const chunk of splitSpeech(cjk, 300)) {
    assert.ok(Buffer.byteLength(cjk.slice(chunk.start, chunk.end)) <= 300);
  }
  const emoji = '😀'.repeat(10);
  const chunks = splitSpeech(emoji, 5);
  assert.equal(chunks.length, 10);
  assert.ok(chunks.every(({ start, end }) => end - start === 2));
  assert.deepEqual(splitSpeech('', 10), []);
});

test('alignSpeechWords maps reported words back to page offsets', () => {
  const text = 'Hello, world. Hello again.';
  const words = [
    word('Hello', 0, 300),
    word('world', 400, 300),
    word('Hello', 800, 300),
    word('again', 1200, 300),
  ];
  const aligned = alignSpeechWords(text, 1000, words);
  assert.deepEqual(
    aligned.map((w) => [text.slice(w.start - 1000, w.end - 1000), w.startMs]),
    [
      ['Hello', 0],
      ['world', 400],
      ['Hello', 800],
      ['again', 1200],
    ],
  );
});

test('alignSpeechWords survives case, typographic punctuation and missing words', () => {
  const text = "DON’T stop: in 1815 the city grew.";
  const words = [
    word("don't", 0, 300),
    word('stop', 400, 300),
    word('in', 800, 200),
    word('eighteen', 1100, 400),
    word('fifteen', 1600, 400),
    word('the', 2100, 200),
    word('city', 2400, 300),
  ];
  const aligned = alignSpeechWords(text, 0, words);
  const byTime = new Map(aligned.map((w) => [w.startMs, text.slice(w.start, w.end)]));
  assert.equal(byTime.get(0), 'DON’T');
  assert.equal(byTime.get(400), 'stop');
  assert.equal(byTime.get(2100), 'the');
  assert.equal(byTime.get(2400), 'city');
  // The normalised number still receives a highlight around its source digits.
  assert.equal(byTime.get(1100), '1815');
  assert.equal(byTime.get(1600), '1815');
});

test('alignSpeechWords handles CJK phrases and empty input', () => {
  // "He said: 'Okay.' Then he left." in Chinese.
  const text = '\u4ed6\u8bf4\uff1a\u300c\u597d\u7684\u3002\u300d\u7136\u540e\u8d70\u4e86\u3002';
  const words = [
    word('\u4ed6', 0, 200),
    word('\u8bf4', 250, 200),
    word('\u597d\u7684', 500, 400),
    word('\u7136\u540e', 1000, 300),
  ];
  const aligned = alignSpeechWords(text, 0, words);
  assert.deepEqual(
    aligned.map((w) => text.slice(w.start, w.end)),
    ['\u4ed6', '\u8bf4', '\u597d\u7684', '\u7136\u540e'],
  );
  assert.deepEqual(alignSpeechWords('', 0, []), []);
});

test('wordIndexAt follows playback time through gaps', () => {
  const words = [
    { startMs: 100, endMs: 300 },
    { startMs: 500, endMs: 700 },
    { startMs: 900, endMs: 1100 },
  ];
  assert.equal(wordIndexAt(words, 0), -1);
  assert.equal(wordIndexAt(words, 100), 0);
  assert.equal(wordIndexAt(words, 400), 0);
  assert.equal(wordIndexAt(words, 700), 1);
  assert.equal(wordIndexAt(words, 5000), 2);
});

test('autoVoice picks a voice from the writing system', () => {
  assert.equal(autoVoice('The quick brown fox'), 'en-US-AriaNeural');
  // "First chapter: he looked up at the rain outside the window."
  assert.equal(
    autoVoice('\u7b2c\u4e00\u7ae0 \u4ed6\u62ac\u8d77\u5934\uff0c\u671b\u7740\u7a97\u5916\u7684\u96e8\u3002'),
    'zh-CN-XiaoxiaoNeural',
  );
  assert.equal(autoVoice('\u3053\u308c\u306f\u30c6\u30b9\u30c8\u3067\u3059\u3002'), 'ja-JP-NanamiNeural');
  assert.equal(autoVoice('\uc774\uac83\uc740 \ud14c\uc2a4\ud2b8\uc785\ub2c8\ub2e4.'), 'ko-KR-SunHiNeural');
});
