// Paginates the whole book in the background. Results are sent per segment in
// batches; a newer 'book' or 'layout' message abandons the running job.

import { buildBook } from '../core/book.mjs';
import { paginateSegment } from '../core/layout.mjs';
import { Measurer } from './measure.js';

let book = null;
let job = 0;

const yieldToMessages = () => new Promise((resolve) => setTimeout(resolve, 0));

self.onmessage = async ({ data }) => {
  const mine = ++job;
  if (data.type === 'book') {
    book = buildBook(data.text);
    return;
  }
  if (data.type !== 'layout' || !book) return;

  const { gen, metrics } = data;
  const { measure } = new Measurer(metrics.bodyFont, metrics.headingFont);
  let batch = [];
  let from = 0;
  let last = performance.now();
  for (let s = 0; s < book.segments.length; s++) {
    batch.push(paginateSegment(book, s, metrics, measure));
    if (performance.now() - last > 40) {
      self.postMessage({ type: 'pages', gen, from, list: batch });
      from = s + 1;
      batch = [];
      await yieldToMessages();
      if (job !== mine) return;
      last = performance.now();
    }
  }
  self.postMessage({ type: 'pages', gen, from, list: batch });
  self.postMessage({ type: 'done', gen });
};
