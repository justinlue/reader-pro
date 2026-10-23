// Owns the pagination of the open book under the current layout.
//
// Positions are { seg, idx }: page idx of segment seg. Any segment can be paginated
// synchronously on demand (they are bounded in size), so the reader can show and turn
// pages immediately while the worker paginates the whole book for page numbers.

import { segmentAt } from '../core/book.mjs';
import { layoutPage, pageIndexAt, paginateSegment } from '../core/layout.mjs';
import { Measurer } from './measure.js';

const PAGE_CACHE_LIMIT = 40;

export class Paginator {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.book = null;
    this.gen = 0;
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => this.receive(data);
  }

  setBook(book) {
    this.book = book;
    this.worker.postMessage({ type: 'book', text: book.text });
  }

  setLayout(metrics) {
    this.gen++;
    this.metrics = metrics;
    this.measurer = new Measurer(metrics.bodyFont, metrics.headingFont);
    this.starts = new Array(this.book.segments.length);
    this.received = 0;
    this.prefix = null;
    this.pages = new Map();
    this.worker.postMessage({ type: 'layout', gen: this.gen, metrics });
  }

  receive(data) {
    if (data.gen !== this.gen) return;
    if (data.type === 'pages') {
      data.list.forEach((starts, i) => {
        this.starts[data.from + i] ??= starts;
      });
      this.received = data.from + data.list.length;
    } else if (data.type === 'done') {
      this.prefix = [0];
      for (const s of this.starts) this.prefix.push(this.prefix.at(-1) + s.length);
    }
    this.onUpdate();
  }

  get ready() {
    return this.book !== null && this.book.segments.length > 0;
  }

  // Fraction of segments the background job has finished, 1 once page numbers exist.
  get progress() {
    return this.prefix ? 1 : this.received / Math.max(1, this.starts.length);
  }

  get total() {
    return this.prefix ? this.prefix.at(-1) : null;
  }

  pageNumber(pos) {
    return this.prefix ? this.prefix[pos.seg] + pos.idx + 1 : null;
  }

  segStarts(seg) {
    this.starts[seg] ??= paginateSegment(this.book, seg, this.metrics, this.measurer.measure);
    return this.starts[seg];
  }

  locate(offset) {
    const seg = segmentAt(this.book, offset);
    return { seg, idx: pageIndexAt(this.segStarts(seg), offset) };
  }

  page(pos) {
    const key = `${pos.seg}:${pos.idx}`;
    let page = this.pages.get(key);
    if (!page) {
      page = layoutPage(this.book, pos.seg, this.segStarts(pos.seg)[pos.idx], this.metrics, this.measurer.measure);
      if (this.pages.size >= PAGE_CACHE_LIMIT) this.pages.delete(this.pages.keys().next().value);
      this.pages.set(key, page);
    }
    return page;
  }

  next(pos) {
    if (pos.idx + 1 < this.segStarts(pos.seg).length) return { seg: pos.seg, idx: pos.idx + 1 };
    if (pos.seg + 1 < this.book.segments.length) return { seg: pos.seg + 1, idx: 0 };
    return null;
  }

  prev(pos) {
    if (pos.idx > 0) return { seg: pos.seg, idx: pos.idx - 1 };
    if (pos.seg > 0) return { seg: pos.seg - 1, idx: this.segStarts(pos.seg - 1).length - 1 };
    return null;
  }
}
