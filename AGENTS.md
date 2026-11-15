# AGENTS.md

Reader: an Electron desktop app for reading `.txt` books on Windows 11, with paginated
layout, themes/font settings, and a Bézier page-curl turn.

## Commands

- `npm start` or `run.bat [file.txt]` — run the app (run.bat installs deps on first use).
- `npm test` — core tests (Node's built-in runner, `test/*.test.mjs`). Tests that read
  `sample.txt` (an English *Les Misérables*, gitignored) skip when it is absent.
- `npm run tts:check -- [text|@file.txt] [voice] [rate] [out.mp3]` — live Edge TTS
  check; needs internet and writes the MP3 when an output path is given.
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
  - `speech.mjs` — speakable page text, byte-bounded TTS chunks, automatic voice
    selection, and mapping Edge word-boundary timings back to book offsets.
- `src/main/` — Electron main process (ESM). Serves `src/` over the privileged
  `app://reader/` scheme; state file `state.json` in userData; fonts via PowerShell.
  - `edge-tts.js` — Edge TTS protocol client: Sec-MS-GEC v2 token, audio/metadata
    collection, bounded-concurrency chunking, voice list, retry and cancellation.
  - `websocket.js` / `ws-frame.js` — minimal RFC 6455 client. Node's built-in
    WebSocket cannot send the browser headers the speech endpoint requires.
- `src/renderer/` — UI. `app.js` controller, `paginator.js` (sync + worker pagination),
  `worker.js`, `painter.js` (one page → canvas, plus the highlight overlay),
  `turner.js` (drag/animation/curl drawing), `audiobook.js` (page-by-page playback,
  prefetch, highlight timing, and the turn when a page finishes), `speech-audio.js`
  (decoded speech playback with audio-engine stop points).

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
- The audiobook reads only the visible page (body and headings, not the running
  header/footer), highlights the word range reported by Edge TTS, and turns forward
  after the page's last timed word (audio end when timings are incomplete). Its
  highlight offsets are book offsets, like page layout.
- Speech recordings include the next page's first sentence when boundary timings
  allow it. Web Audio stops at the page boundary independently of JS timers; after
  the unchanged turn, the same recording resumes at the next opening. The prefetched
  remainder starts after that opening. Final sentence pairs stay in one service
  chunk when they fit its byte limit; missing timings use page-only synthesis.
- Highlight rectangles are painted on a transparent overlay above the cached page
  image, so following a word does not repaint or invalidate the page.
- The audiobook is off by default. Turning it on pauses auto page turning without
  changing its configured speed; turning it off re-arms the countdown. Space pauses
  and resumes the audiobook while it is enabled.
- Speech requests stay in the main process: the renderer receives MP3 bytes and word
  timings only. The feature needs internet access; it uses the Edge read-aloud service
  directly, with no Python package or API key. Chunks are requested with bounded
  concurrency and one retry covers transient service stalls.
- A page turn finishes even when Chromium throttles animation frames in a hidden
  window (the turner has a timer fallback), so reading keeps advancing in the
  background. A relayout that keeps the same page range does not restart the audio.
- `window.__reader` is a debug handle (turner, paginator, autoTurn, audiobook, goTo,
  state, cur, highlight) used for scripted checks over DevTools.
