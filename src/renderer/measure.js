// Canvas text measurement with a per-font width cache. Works in the page and in the
// pagination worker, so both lay out text with identical widths.

export class Measurer {
  constructor(bodyFont, headingFont) {
    this.ctx = new OffscreenCanvas(1, 1).getContext('2d');
    this.fonts = { body: bodyFont, heading: headingFont };
    this.cache = { body: new Map(), heading: new Map() };
    this.active = null;
    this.measure = this.measure.bind(this);
  }

  measure(str, kind = 'body') {
    const cache = this.cache[kind];
    let w = cache.get(str);
    if (w === undefined) {
      if (this.active !== kind) {
        this.ctx.font = this.fonts[kind];
        this.active = kind;
      }
      w = this.ctx.measureText(str).width;
      cache.set(str, w);
    }
    return w;
  }
}
