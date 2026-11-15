# Audiobook Boundary Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Reduce page-boundary audio silence with a retained, cached continuation.

**Architecture:** Append the next page's opening sentence to each remaining-page
request. Pause at the timed page boundary and reuse the player after navigation
commits. Prepare the unconsumed remainder concurrently.

**Tech Stack:** JavaScript ES modules, Electron media APIs, Node test runner.

**Spec:** ../specs/2026-11-15-audiobook-boundary-design.md

## Global Constraints

- Keep existing page-turn animation and navigation logic unchanged.
- Preserve book offsets for highlighting and bounded speech caching.
- No new dependencies; commit to the current branch.

## Review Focus

- Single-sentence pages must turn exactly once without repeating their opening.
- Missing or unusable boundary timings must use ordinary page audio.
- Manual navigation and relayout must abandon incompatible continuations.
- Pause/resume and background timers must not advance paused speech.
- Voice/rate changes and stale requests must not reuse incompatible audio.

### Task 1: Joint recording and retained playback

**Files:** Modify src/renderer/audiobook.js, src/renderer/app.js,
src/core/speech.mjs, src/main/edge-tts.js; create src/renderer/speech-audio.js
and test/audiobook.test.mjs; extend test/speech.test.mjs.

**Interfaces:** Existing public Audiobook methods and page/nextPage/turn/highlight
host callbacks. Speech IPC and Audio remain external adapters.

- [x] Write a regression at the approved public interface: expect synthesis text
  to include the next opening and a turn at the current last word rather than EOF.
- [x] Run `node --test test/audiobook.test.mjs`; confirm expected failure.
- [x] Implement contextual requests, boundary scheduling, and retained continuation.
- [x] Run the focused tests and `node --check src/renderer/audiobook.js`.
- [x] Add and run tests for each Review Focus case and remainder prefetch.

Ruling: use bounded Web Audio BufferSources rather than media-element timers to
enforce playback stops; late JavaScript callbacks must not emit lookahead words.
Ruling: forward a protected tail start to the existing chunker so the sentence pair
shares actual synthesis context when it fits the existing service byte limit.
Review found and tests reproduced canceled fallback requests, queued media events,
and pause during a pending audio-device resume; all now have passing regressions.

### Task 2: Review and delivery

- [x] Run `npm test` and `git diff --check` (71 tests passed; no skips).
- [x] Review standards and approved spec with independent reviewers; fix findings.
- [x] Update audiobook invariants in AGENTS.md; prepare the completed change for commit.

Live Edge synthesis returned MP3 bytes and four word timings for the two-sentence
fixture. Perceived audio quality and Chromium MP3/timing alignment have not been
verified by listening; deterministic tests cover the playback scheduling contract.
