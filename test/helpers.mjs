import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SAMPLE_PATH = fileURLToPath(new URL('../sample.txt', import.meta.url));
export const hasSample = existsSync(SAMPLE_PATH);
export const sampleBytes = () => new Uint8Array(readFileSync(SAMPLE_PATH));

// Monospace-ish stand-in for canvas measureText: wide (CJK) characters are 2 units.
export function fakeMeasure(str, kind = 'body') {
  const unit = kind === 'heading' ? 13 : 10;
  let w = 0;
  for (const ch of str) w += (ch.codePointAt(0) >= 0x2e80 ? 2 : 1) * unit;
  return w;
}

export const METRICS = {
  width: 300,
  height: 200,
  lineHeight: 20,
  headingLineHeight: 26,
  paraSpacing: 6,
  headingGap: 16,
  indent: 20,
};
