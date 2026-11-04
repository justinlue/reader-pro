// Live check for the Edge TTS client. Requires an internet connection.
// Usage: node scripts/tts-smoke.mjs [text|@file.txt] [voice] [rate] [out.mp3]

import { readFileSync, writeFileSync } from 'node:fs';
import { synthesizePage } from '../src/main/edge-tts.js';

const source = process.argv[2];
const text =
  (source?.startsWith('@') ? readFileSync(source.slice(1), 'utf8') : source) ??
  'The quick brown fox jumps over the lazy dog. This is a check of the audiobook speech client.';
const voice = process.argv[3] ?? 'en-US-AriaNeural';
const rate = Number(process.argv[4] ?? 0);
const out = process.argv[5];

const started = Date.now();
const result = await synthesizePage({ text, voice, rate });
console.log(`audio: ${result.audio.length} bytes`);
console.log(`words: ${result.words.length}`);
console.log(`first: ${JSON.stringify(result.words[0])}`);
console.log(`last: ${JSON.stringify(result.words.at(-1))}`);
console.log(`elapsed: ${Date.now() - started} ms`);
if (out) {
  writeFileSync(out, result.audio);
  console.log(`saved ${out}`);
}
