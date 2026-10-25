// Reader settings, theme presets, and the derived layout metrics.

export const THEMES = {
  paper: { label: 'Paper', bg: '#f6f1e7', fg: '#2e2a25' },
  sepia: { label: 'Sepia', bg: '#ecdcbc', fg: '#5a4632' },
  green: { label: 'Eye-care', bg: '#cde4c8', fg: '#22381f' },
  night: { label: 'Night', bg: '#1d1f23', fg: '#b4b8bf' },
};

export const DEFAULT_SETTINGS = {
  fontFamily: '', // '' = Georgia with Microsoft YaHei for CJK
  fontSize: 20,
  lineSpacing: 1.6,
  paraSpacing: 0.4, // em
  margin: 48, // px, left and right
  theme: 'paper',
  bg: THEMES.paper.bg,
  fg: THEMES.paper.fg,
  animation: 'curl', // 'curl' | 'slide' | 'none'
  autoTurn: 0, // seconds between automatic page turns; 0 = off
};

export const UI_FONT = '"Segoe UI", "Microsoft YaHei", sans-serif';

export function fontStack(family, cjk = false) {
  const chosen = family ? `"${family.replace(/["\\]/g, '')}", ` : '';
  const base = cjk ? '"Microsoft YaHei", Georgia' : 'Georgia, "Microsoft YaHei"';
  return `${chosen}${base}, "Segoe UI Symbol", serif`;
}

// Page geometry for a W×H page. The text area sits inside the side margins and
// between the running header and footer bands.
export function makeMetrics(s, W, H, cjk = false) {
  const fs = s.fontSize;
  const stack = fontStack(s.fontFamily, cjk);
  const headingSize = Math.round(fs * 1.3);
  const band = Math.max(40, Math.round(s.margin * 0.8));
  const padX = Math.min(s.margin, Math.max(8, (W - 120) / 2));
  return {
    W,
    H,
    padX,
    padTop: band,
    padBottom: band,
    width: Math.max(60, W - 2 * padX),
    height: Math.max(fs * s.lineSpacing, H - 2 * band),
    fontSize: fs,
    lineHeight: fs * s.lineSpacing,
    headingLineHeight: headingSize * Math.max(1.3, s.lineSpacing * 0.9),
    paraSpacing: fs * s.paraSpacing,
    headingGap: fs * s.lineSpacing,
    indent: 2 * fs,
    bodyFont: `${fs}px ${stack}`,
    headingFont: `bold ${headingSize}px ${stack}`,
  };
}

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mix(hexA, hexB, t) {
  const a = rgb(hexA);
  const b = rgb(hexB);
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${c.join(',')})`;
}

export function isDark(hex) {
  const [r, g, b] = rgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}
