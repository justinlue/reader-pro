# CLAUDE.md

Reader: an Electron desktop app for reading `.txt` books on Windows 11, with paginated
layout, themes/font settings, and a Bézier page-curl turn.

## Commands

- `npm start` or `run.bat [file.txt]` — run the app (run.bat installs deps on first use).
- `npm test` — core tests (Node's built-in runner, `test/*.test.mjs`). Tests that read
  `sample.txt` (an English *Les Misérables*, gitignored) skip when it is absent.
- Electron's postinstall download can fail silently on slow networks; if
  `node_modules/electron/dist` is missing, run `node node_modules/electron/install.js`.
- `READER_USER_DATA=<dir>` points the app's state at a scratch dir instead of
  `%APPDATA%\Reader` (use for test runs; the single-instance lock is per data dir).

## Layout

- `src/core/` — pure ES modules, no DOM/Electron, all unit-tested:
  - `encoding.mjs` — BOM → BOM-less UTF-16 heuristic → strict UTF-8 → GB18030 fallback.
  - `book.mjs` — paragraphs (trimmed non-blank lines), heading detection
    (CHAPTER/BOOK/VOLUME and their Chinese equivalents), and **segments**.
  - `layout.mjs` — tokenizer with CJK line-break rules, greedy line breaking,
    `layoutPage`, `paginateSegment`, `placeLine` (justification).
  - `curl-geometry.mjs` — the page-curl control points (see header comment).
  - `autoturn.mjs` — the auto page-turn countdown (speeds, pause, restart on page change).
- `src/main/` — Electron main process (ESM). Serves `src/` over the privileged
  `app://reader/` scheme; state file `state.json` in userData; fonts via PowerShell.
- `src/renderer/` — UI. `app.js` controller, `paginator.js` (sync + worker pagination),
  `worker.js`, `painter.js` (one page → canvas), `turner.js` (drag/animation/curl drawing).

## Invariants worth knowing

- Every segment starts on a new page, so a segment can be paginated alone. Segments
  break at headings (consecutive headings share one) and every ~100k chars.
- Layout is memoryless across lines: a page laid out from its start offset reproduces
  the paginated page exactly. A pagination is just page start offsets per segment.
- The reading position is a character offset (`anchor`), changed only by navigation,
  never by relayout — so font/window changes never drift the position.
- Auto page turning is a countdown, not a navigation action: every page change restarts
  it, so a manual turn gets a full interval on the new page. It only turns forward and
  stops at the last page until the next page change. Space pauses and resumes it without
  changing the configured speed (30/60/90 seconds, off by default).
- Page widths come from canvas `measureText` in both the worker and the page; both use
  `Measurer` with the same font strings, so they agree.
- `window.__reader` is a debug handle (turner, paginator, autoTurn, goTo, state, cur)
  used for scripted checks over DevTools.
