// Paints one page (text, running header, footer) onto a 2D context.

import { placeLine } from '../core/layout.mjs';
import { UI_FONT } from './settings.js';

function elide(ctx, str, maxWidth) {
  if (ctx.measureText(str).width <= maxWidth) return str;
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(str.slice(0, mid) + '…').width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return str.slice(0, lo) + '…';
}

// info: { header, footerLeft, footerRight }
export function paintPage(ctx, m, colors, page, text, measure, info) {
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, m.W, m.H);
  ctx.textBaseline = 'middle';

  ctx.fillStyle = colors.fg;
  for (const line of page.lines) {
    ctx.font = line.kind === 'heading' ? m.headingFont : m.bodyFont;
    const lh = line.kind === 'heading' ? m.headingLineHeight : m.lineHeight;
    const y = m.padTop + line.y + lh / 2;
    for (const piece of placeLine(text, line, m.width, measure)) {
      ctx.fillText(piece.str, m.padX + piece.x, y);
    }
  }

  ctx.font = `13px ${UI_FONT}`;
  ctx.fillStyle = colors.muted;
  const bandX = m.padX;
  const bandW = m.W - 2 * m.padX;
  ctx.textAlign = 'left';
  ctx.fillText(elide(ctx, info.header, bandW), bandX, m.padTop / 2);
  ctx.fillText(info.footerLeft, bandX, m.H - m.padBottom / 2);
  ctx.textAlign = 'right';
  ctx.fillText(info.footerRight, bandX + bandW, m.H - m.padBottom / 2);
  ctx.textAlign = 'left';
}

export function paintMessage(ctx, W, H, colors, lines) {
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = colors.muted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((str, i) => {
    ctx.font = i === 0 ? `22px ${UI_FONT}` : `14px ${UI_FONT}`;
    ctx.fillText(str, W / 2, H / 2 + (i - (lines.length - 1) / 2) * 34);
  });
  ctx.textAlign = 'left';
}
