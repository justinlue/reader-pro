import { buildBook, chapterAt } from '../core/book.mjs';
import { decodeText, ENCODINGS, ENCODING_LABELS } from '../core/encoding.mjs';
import { Paginator } from './paginator.js';
import { paintMessage, paintPage } from './painter.js';
import { DEFAULT_SETTINGS, THEMES, isDark, makeMetrics, mix } from './settings.js';
import { Turner } from './turner.js';

const api = window.api;
const $ = (id) => document.getElementById(id);
const RECENT_LIMIT = 12;
const IMAGE_CACHE_LIMIT = 6;

// Persisted (see saveSoon). books: lower-cased path -> { offset, encoding }.
const state = { settings: { ...DEFAULT_SETTINGS }, books: {}, recent: [], lastBook: null };

let doc = null; // { path, key, name, book, encoding, detected, empty }
let cur = null; // { seg, idx } of the current page
let anchor = 0; // text offset the reader is at; survives relayouts
let W = 1;
let H = 1;
let dpr = 1;
let metrics = null;
let colors = null;
let look = null;
let images = new Map();
let clock = '';

const canvas = $('page');
const paginator = new Paginator(onPaginationUpdate);
const turner = new Turner(canvas, {
  image: pageImage,
  has: (dir) => neighbor(dir) !== null,
  commit: (dir) => {
    cur = neighbor(dir);
    anchor = paginator.page(cur).start;
    afterMove();
  },
  mode: () => state.settings.animation,
  look: () => look,
  onTap,
});

// ---- pages ---------------------------------------------------------------

function neighbor(dir) {
  if (!cur) return null;
  return dir === 'next' ? paginator.next(cur) : paginator.prev(cur);
}

function newImage() {
  const c = new OffscreenCanvas(Math.round(W * dpr), Math.round(H * dpr));
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  return { c, ctx };
}

function pageImage(which) {
  const pos = which === 'cur' ? cur : neighbor(which);
  const key = pos ? `${pos.seg}:${pos.idx}` : `msg:${doc?.empty ? 'empty' : 'none'}`;
  if (which !== 'cur' && !pos) return null;
  let img = images.get(key);
  if (img) return img;
  const { c, ctx } = newImage();
  if (pos) {
    const page = paginator.page(pos);
    paintPage(ctx, metrics, colors, page, doc.book.text, paginator.measurer.measure, pageInfo(pos, page));
  } else if (doc?.empty) {
    paintMessage(ctx, W, H, colors, ['This file has no text', doc.name]);
  } else {
    paintMessage(ctx, W, H, colors, ['Open a .txt file', 'Ctrl+O, or drop a file onto this window']);
  }
  if (images.size >= IMAGE_CACHE_LIMIT) images.delete(images.keys().next().value);
  images.set(key, c);
  return c;
}

function pageInfo(pos, page) {
  const { book, name } = doc;
  const ch = chapterAt(book, page.start);
  const opensChapter = ch >= 0 && book.chapters[ch].offset === page.start;
  const header = ch >= 0 && !opensChapter ? book.chapters[ch].title : name;
  const n = paginator.pageNumber(pos);
  const footerLeft = n
    ? `${n.toLocaleString()} / ${paginator.total.toLocaleString()}`
    : `Counting pages… ${Math.floor(paginator.progress * 100)}%`;
  const pct = ((page.end / book.text.length) * 100).toFixed(1);
  return { header, footerLeft, footerRight: `${pct}%   ${clock}` };
}

function repaint() {
  images = new Map();
  if (!turner.busy) turner.paint();
}

function onPaginationUpdate() {
  // Only the footers changed; redraw when the reader isn't mid-turn.
  if (!turner.busy) repaint();
  updateChrome();
}

function relayout() {
  const rect = $('stage').getBoundingClientRect();
  W = Math.max(1, Math.round(rect.width));
  H = Math.max(1, Math.round(rect.height));
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  turner.setSize(W, H, dpr);
  cur = null;
  if (doc && !doc.empty) {
    metrics = makeMetrics(state.settings, W, H, doc.book.cjk);
    paginator.setLayout(metrics);
    cur = paginator.locate(anchor);
  }
  repaint();
  updateChrome();
}

let relayoutTimer = 0;
function relayoutSoon(ms = 120) {
  clearTimeout(relayoutTimer);
  relayoutTimer = setTimeout(relayout, ms);
}

function afterMove() {
  if (doc) {
    state.books[doc.key] = { ...state.books[doc.key], offset: anchor };
    saveSoon();
  }
  updateChrome();
}

function goTo(offset) {
  if (!doc || doc.empty) return;
  turner.finish();
  cur = paginator.locate(offset);
  anchor = paginator.page(cur).start;
  afterMove();
  turner.paint();
}

// ---- files ---------------------------------------------------------------

const baseName = (path) => path.split(/[\\/]/).pop();

async function openPath(path, encodingChoice) {
  let bytes;
  try {
    bytes = await api.readFile(path);
  } catch (err) {
    toast(`Couldn't open ${baseName(path)}: ${String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
    state.recent = state.recent.filter((r) => r.path !== path);
    if (state.lastBook === path) state.lastBook = null;
    saveSoon();
    renderRecent();
    return;
  }
  const key = path.toLowerCase();
  const rec = (state.books[key] ??= { offset: 0, encoding: null });
  let ratio = null;
  if (encodingChoice !== undefined) {
    rec.encoding = encodingChoice;
    if (doc?.key === key) ratio = anchor / Math.max(1, doc.book.text.length);
  }
  const decoded = decodeText(bytes, rec.encoding ?? null);
  const book = buildBook(decoded.text);
  turner.finish();
  doc = {
    path,
    key,
    name: baseName(path),
    book,
    encoding: decoded.encoding,
    detected: decoded.detected,
    empty: book.segments.length === 0,
  };
  anchor = ratio !== null ? Math.round(ratio * book.text.length) : Math.min(rec.offset ?? 0, book.text.length);
  if (!doc.empty) paginator.setBook(book);

  state.lastBook = path;
  state.recent = [{ path, name: doc.name }, ...state.recent.filter((r) => r.path.toLowerCase() !== key)].slice(
    0,
    RECENT_LIMIT,
  );
  document.title = `Reader — ${doc.name}`;
  $('doc-title').textContent = doc.name;
  renderToc();
  renderRecent();
  syncEncoding();
  relayout();
  saveSoon();
}

async function openDialog() {
  const path = await api.openDialog();
  if (path) {
    closePanels();
    setControls(false);
    openPath(path);
  }
}

// ---- persistence ---------------------------------------------------------

let saveTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}
function saveNow() {
  clearTimeout(saveTimer);
  api.saveState(state);
}

// ---- look & settings -----------------------------------------------------

function applyLook() {
  const s = state.settings;
  colors = { bg: s.bg, fg: s.fg, muted: mix(s.fg, s.bg, 0.45) };
  look = { back: mix(s.bg, s.fg, 0.06), shadow: isDark(s.bg) ? 1.8 : 1 };
  document.documentElement.style.setProperty('--page-bg', s.bg);
  for (const btn of $('themes').children) btn.classList.toggle('active', btn.dataset.theme === s.theme);
  $('bg-color').value = s.bg;
  $('fg-color').value = s.fg;
}

const RANGES = [
  { id: 'font-size', key: 'fontSize', fmt: (v) => `${v}px` },
  { id: 'line-spacing', key: 'lineSpacing', fmt: (v) => v.toFixed(2) },
  { id: 'para-spacing', key: 'paraSpacing', fmt: (v) => `${v.toFixed(1)} em` },
  { id: 'margin', key: 'margin', fmt: (v) => `${v}px` },
];

function syncSettingsUI() {
  const s = state.settings;
  for (const r of RANGES) {
    $(r.id).value = s[r.key];
    $(`${r.id}-val`).textContent = r.fmt(s[r.key]);
  }
  $('animation').value = s.animation;
  ensureFontOption(s.fontFamily);
  $('font-family').value = s.fontFamily;
  applyLook();
}

function ensureFontOption(name) {
  const select = $('font-family');
  if (name && ![...select.options].some((o) => o.value === name)) select.add(new Option(name, name));
}

function bindSettings() {
  for (const [id, theme] of Object.entries(THEMES)) {
    const btn = document.createElement('button');
    btn.dataset.theme = id;
    btn.textContent = theme.label;
    btn.style.background = theme.bg;
    btn.style.color = theme.fg;
    btn.addEventListener('click', () => {
      Object.assign(state.settings, { theme: id, bg: theme.bg, fg: theme.fg });
      applyLook();
      repaint();
      saveSoon();
    });
    $('themes').append(btn);
  }
  for (const [id, key] of [['bg-color', 'bg'], ['fg-color', 'fg']]) {
    $(id).addEventListener('input', (e) => {
      state.settings[key] = e.target.value;
      state.settings.theme = 'custom';
      applyLook();
      repaint();
      saveSoon();
    });
  }
  for (const r of RANGES) {
    $(r.id).addEventListener('input', (e) => {
      const v = Number(e.target.value);
      state.settings[r.key] = v;
      $(`${r.id}-val`).textContent = r.fmt(v);
      relayoutSoon();
      saveSoon();
    });
  }
  $('font-family').addEventListener('change', (e) => {
    state.settings.fontFamily = e.target.value;
    relayoutSoon(0);
    saveSoon();
  });
  $('animation').addEventListener('change', (e) => {
    state.settings.animation = e.target.value;
    saveSoon();
  });
  $('encoding').addEventListener('change', (e) => {
    if (doc) openPath(doc.path, e.target.value === 'auto' ? null : e.target.value);
  });
  $('btn-reset').addEventListener('click', () => {
    state.settings = { ...DEFAULT_SETTINGS };
    syncSettingsUI();
    relayout();
    saveSoon();
  });
}

function syncEncoding() {
  const select = $('encoding');
  select.replaceChildren();
  const auto = doc?.detected ? `Auto (detected ${ENCODING_LABELS[doc.encoding]})` : 'Auto-detect';
  select.add(new Option(auto, 'auto'));
  for (const enc of ENCODINGS) select.add(new Option(ENCODING_LABELS[enc], enc));
  select.value = doc && !doc.detected ? doc.encoding : 'auto';
  select.disabled = !doc;
}

// ---- chrome: bars, contents, recent ---------------------------------------

// Hidden buttons and sliders must not keep focus, or Space/arrows would act on them.
function blurHidden() {
  const el = document.activeElement;
  if (el && el !== document.body && !el.closest('.panel.open, body.controls .bar')) el.blur();
}

function setControls(show) {
  document.body.classList.toggle('controls', show);
  if (!show) $('recent-menu').hidden = true;
  if (show) updateChrome();
  else blurHidden();
}

const controlsShown = () => document.body.classList.contains('controls');
const panelOpen = () => document.querySelector('.panel.open') !== null;

function openPanel(id) {
  const wasOpen = $(id).classList.contains('open');
  closePanels();
  if (wasOpen) return;
  $(id).classList.add('open');
  if (id === 'toc') $('toc-list').querySelector('.current')?.scrollIntoView({ block: 'center' });
}

function closePanels() {
  for (const p of document.querySelectorAll('.panel.open')) p.classList.remove('open');
  $('recent-menu').hidden = true;
  blurHidden();
}

function renderToc() {
  const list = $('toc-list');
  list.replaceChildren();
  const chapters = doc?.book.chapters ?? [];
  if (chapters.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = doc ? 'No chapters detected in this file.' : 'No book open.';
    list.append(li);
    return;
  }
  chapters.forEach((ch, i) => {
    const li = document.createElement('li');
    li.className = `lvl-${ch.level}`;
    li.dataset.index = i;
    const btn = document.createElement('button');
    btn.textContent = ch.title;
    btn.title = ch.title;
    btn.addEventListener('click', () => {
      goTo(ch.offset);
      closePanels();
      setControls(false);
    });
    li.append(btn);
    list.append(li);
  });
}

function renderRecent() {
  const menu = $('recent-menu');
  menu.replaceChildren();
  if (state.recent.length === 0) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = 'No recent files';
    menu.append(div);
    return;
  }
  for (const r of state.recent) {
    const btn = document.createElement('button');
    btn.textContent = r.name;
    const small = document.createElement('small');
    small.textContent = r.path;
    btn.append(small);
    btn.addEventListener('click', () => {
      menu.hidden = true;
      setControls(false);
      openPath(r.path);
    });
    menu.append(btn);
  }
}

let sliderHeld = false;

function chapterTitleAt(offset) {
  const ch = chapterAt(doc.book, offset);
  return ch >= 0 ? doc.book.chapters[ch].title : doc.name;
}

function updateChrome() {
  const slider = $('progress');
  slider.disabled = !doc || doc.empty;
  if (!doc || doc.empty) {
    $('progress-label').textContent = '';
    return;
  }
  const len = Math.max(1, doc.book.text.length);
  if (!sliderHeld) slider.value = Math.round((anchor / len) * 1000);
  if (!sliderHeld) {
    const n = cur && paginator.pageNumber(cur);
    const where = n ? `Page ${n.toLocaleString()} of ${paginator.total.toLocaleString()} · ` : '';
    $('progress-label').textContent = `${where}${((anchor / len) * 100).toFixed(1)}% · ${chapterTitleAt(anchor)}`;
  }
  const ch = chapterAt(doc.book, anchor);
  for (const li of $('toc-list').querySelectorAll('.current')) li.classList.remove('current');
  if (ch >= 0) $('toc-list').querySelector(`[data-index="${ch}"]`)?.classList.add('current');
}

function bindChrome() {
  $('btn-open').addEventListener('click', openDialog);
  $('btn-toc').addEventListener('click', () => openPanel('toc'));
  $('btn-settings').addEventListener('click', () => openPanel('settings'));
  $('btn-recent').addEventListener('click', (e) => {
    e.stopPropagation();
    $('recent-menu').hidden = !$('recent-menu').hidden;
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.dropdown')) $('recent-menu').hidden = true;
  });

  const slider = $('progress');
  const sliderOffset = () => Math.round((Number(slider.value) / 1000) * doc.book.text.length);
  slider.addEventListener('input', () => {
    sliderHeld = true;
    const off = sliderOffset();
    $('progress-label').textContent = `${(slider.value / 10).toFixed(1)}% · ${chapterTitleAt(off)}`;
  });
  slider.addEventListener('change', () => {
    sliderHeld = false;
    goTo(Math.min(sliderOffset(), doc.book.text.length - 1));
  });
}

// ---- input ---------------------------------------------------------------

function onTap(zone) {
  if (panelOpen()) return closePanels();
  if (controlsShown()) return setControls(false);
  if (zone === 'left') turner.turn('prev');
  else if (zone === 'right') turner.turn('next');
  else setControls(true);
}

function bindInput() {
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (panelOpen()) return closePanels();
    canvas.setPointerCapture(e.pointerId);
    turner.down(...local(e));
  });
  canvas.addEventListener('pointermove', (e) => turner.move(...local(e)));
  canvas.addEventListener('pointerup', (e) => turner.up(...local(e)));
  canvas.addEventListener('pointercancel', () => turner.cancelPress());

  let wheelSum = 0;
  let wheelQuietUntil = 0;
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (performance.now() < wheelQuietUntil) return;
      wheelSum += e.deltaY;
      if (Math.abs(wheelSum) >= 40) {
        turner.turn(wheelSum > 0 ? 'next' : 'prev');
        wheelSum = 0;
        wheelQuietUntil = performance.now() + 220;
      }
    },
    { passive: false },
  );

  const NEXT = new Set(['ArrowRight', 'ArrowDown', 'PageDown']);
  const PREV = new Set(['ArrowLeft', 'ArrowUp', 'PageUp']);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F11') {
      e.preventDefault();
      api.toggleFullscreen();
      return;
    }
    if (e.key === 'F12') return api.toggleDevTools();
    if (e.ctrlKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      openDialog();
      return;
    }
    if (e.key === 'Escape') {
      if (panelOpen()) closePanels();
      else setControls(!controlsShown());
      return;
    }
    if (e.target.closest('input, select, textarea')) return;
    let dir = null;
    if (NEXT.has(e.key) || (e.key === ' ' && !e.shiftKey)) dir = 'next';
    else if (PREV.has(e.key) || (e.key === ' ' && e.shiftKey)) dir = 'prev';
    else if (e.key === 'Home') goTo(0);
    else if (e.key === 'End' && doc) goTo(doc.book.text.length - 1);
    if (dir) {
      e.preventDefault();
      turner.turn(dir);
    }
  });

  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      document.body.classList.remove('dragging');
    }
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const path = api.pathForFile(file);
    if (path) {
      closePanels();
      setControls(false);
      openPath(path);
    }
  });
}

let toastTimer = 0;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

// ---- startup -------------------------------------------------------------

function tickClock() {
  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (now !== clock) {
    clock = now;
    if (doc && !turner.busy) repaint();
  }
}

async function start() {
  const saved = await api.loadState();
  Object.assign(state, saved);
  state.settings = { ...DEFAULT_SETTINGS, ...saved.settings };
  state.books ??= {};
  state.recent ??= [];

  bindSettings();
  bindChrome();
  bindInput();
  syncSettingsUI();
  syncEncoding();
  renderToc();
  renderRecent();
  tickClock();
  setInterval(tickClock, 5000);

  new ResizeObserver(() => relayoutSoon(80)).observe($('stage'));
  relayout();

  api.onOpenFile((path) => openPath(path));
  window.addEventListener('beforeunload', saveNow);

  api.listFonts().then((fonts) => {
    const select = $('font-family');
    for (const name of fonts) if (name !== state.settings.fontFamily) select.add(new Option(name, name));
    select.value = state.settings.fontFamily;
  });

  const initial = (await api.initialFile()) ?? state.lastBook;
  if (initial) await openPath(initial);
  if (!doc) setControls(true);

  // Debug handle for DevTools and scripted UI checks.
  window.__reader = { turner, paginator, goTo, state, get cur() { return cur; } };
}

start();
