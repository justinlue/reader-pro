// Audiobook playback: reads the visible page through Edge TTS, highlights the word being
// spoken, and turns to the next page at its last timed word (or audio end).
//
// The host owns the reader state:
//   page()          -> page info for the visible page, or null
//   nextPage(info)  -> page info after info, or null (used to prefetch)
//   canTurn()       -> whether a following page exists
//   turn()          -> turn one page forward, which commits and calls pageChanged()
//   highlight(range)-> show or clear { start, end } book offsets
//   onState(state, detail) -> update the settings status text
//   onError(message)       -> surface a recoverable failure
//
// Page info is { key, text, start, end }. `text` is the speakable page slice and
// `start` is its book offset.

import { alignSpeechWords, autoVoice, wordIndexAt } from '../core/speech.mjs';
import { SpeechAudio } from './speech-audio.js';

const CACHE_LIMIT = 4;
const sentences = new Intl.Segmenter(undefined, { granularity: 'sentence' });

function openingText(text) {
  return sentences.segment(text)[Symbol.iterator]().next().value?.segment ?? '';
}

function finalSentenceStart(text) {
  let start = 0;
  for (const part of sentences.segment(text)) {
    if (part.segment.trim()) start = part.index;
  }
  return start;
}

export class Audiobook {
  constructor(host) {
    this.host = host;
    this.enabled = false;
    this.voice = '';
    this.rate = 0;
    this.state = 'off';
    this.detail = '';
    this.gen = 0;
    this.currentKey = null;
    this.cache = new Map(); // cache key -> { audio, words }
    this.pending = new Map(); // cache key -> Promise<entry>
    this.requestIds = new Map(); // cache key -> IPC request id
    this.requestSeq = 0;
    this.audio = null;
    this.context = null;
    this.words = [];
    this.wordIndex = -1;
    this.raf = 0;
    this.timer = 0;
    this.playback = null;
    this.waitingFor = null;
  }

  get active() {
    return this.enabled;
  }

  setEnabled(on) {
    on = Boolean(on);
    if (on === this.enabled) return;
    this.enabled = on;
    this.gen++;
    this.stopPlayback();
    if (!on) {
      this.cancelPending();
      this.setState('off');
      return;
    }
    this.startPage();
  }

  setVoice(voice) {
    voice = String(voice ?? '');
    if (voice === this.voice) return;
    this.voice = voice;
    if (this.enabled) this.restart();
  }

  setRate(rate) {
    const value = Number(rate) || 0;
    if (value === this.rate) return;
    this.rate = value;
    if (this.enabled) this.restart();
  }

  // The visible page changed (a turn, a jump, or a relayout). Identical page ranges are
  // left alone so resizing the window does not restart the audio.
  pageChanged() {
    if (!this.enabled) {
      this.gen++;
      this.stopPlayback();
      this.setState('off');
      return;
    }
    const info = this.host.page();
    if (this.waitingFor && info?.key === this.waitingFor.key) {
      this.resumeOpening(info);
      return;
    }
    if (info?.key && info.key === this.currentKey) return;
    this.startPage();
  }

  restart() {
    this.gen++;
    this.stopPlayback();
    this.cancelPending();
    this.startPage();
  }

  // Stops playback and abandons in-flight requests without changing the enabled setting.
  // Used while a new document replaces the old one.
  suspend() {
    this.gen++;
    this.stopPlayback();
    this.cancelPending();
  }

  startPage(start) {
    const gen = ++this.gen;
    this.stopPlayback();
    const info = this.host.page();
    this.currentKey = info?.key ?? null;
    if (!this.enabled) {
      this.setState('off');
      return;
    }
    if (!info || !info.text.trim()) {
      this.setState('idle');
      return;
    }
    this.setState('loading');
    this.entryFor(info, start).then(
      (entry) => {
        if (gen !== this.gen) return;
        this.play(entry, info, gen);
      },
      (err) => {
        if (gen !== this.gen || err?.name === 'AbortError') return;
        this.fail(err);
      },
    );
  }

  entryFor(info, start = info.start, includeNext = true) {
    const text = info.text.slice(start - info.start);
    const voice = this.voice || autoVoice(info.text);
    let next = includeNext ? this.host.nextPage(info) : null;
    if (!next?.text.trim() || (!this.voice && autoVoice(next.text) !== voice)) next = null;
    const opening = next ? openingText(next.text) : '';
    // Preserve contiguous book text, including words split across a page. A service
    // word spanning the boundary cannot be paused safely and uses the fallback below.
    const separator = next && info.end !== next.start ? ' ' : '';
    const boundary = text.length + separator.length;
    const spoken = text + separator + opening;
    const key = `${this.cacheKey(info)}|${start}|${next?.key ?? ''}|${opening.length}`;
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);
    let pending = this.pending.get(key);
    if (pending) return pending;
    const id = `speech-${++this.requestSeq}`;
    this.requestIds.set(key, id);
    pending = window.api
      .synthesizeSpeech({
        id,
        text: spoken,
        tailStart: next ? finalSentenceStart(text) : undefined,
        voice,
        rate: this.rate,
      })
      .then((result) => {
        if (this.requestIds.get(key) !== id) throw new DOMException('Speech request cancelled', 'AbortError');
        const aligned = alignSpeechWords(spoken, 0, result.words ?? []);
        const pageWords = aligned.filter((word) => word.end <= text.length);
        const openingWords = aligned.filter((word) => word.start >= boundary);
        const last = pageWords.at(-1);
        const first = openingWords[0];
        const tail = openingWords.at(-1);
        const hasSpeech = (value) => /[\p{L}\p{N}]/u.test(value);
        if (next && (!last || !first || !tail || last.endMs > first.startMs ||
          hasSpeech(text.slice(last.end)) || hasSpeech(opening.slice(0, first.start - boundary)) ||
          hasSpeech(opening.slice(tail.end - boundary)) ||
          aligned.some((word) => word.start < boundary && word.end > text.length))) {
          // Without a precise boundary, never let appended text leak onto this page.
          return this.entryFor(info, start, false);
        }
        const entry = {
          audio: result.audio,
          endMs: last && !hasSpeech(text.slice(last.end)) ? last.endMs : null,
          words: pageWords.map((word) => ({ ...word, start: start + word.start, end: start + word.end })),
          next: next ? {
            info: next,
            end: next.start + opening.length,
            words: openingWords.map((word) => ({
              ...word, start: next.start + word.start - boundary, end: next.start + word.end - boundary,
            })),
          } : null,
        };
        this.cache.set(key, entry);
        if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
        return entry;
      })
      .finally(() => {
        if (this.pending.get(key) === pending) this.pending.delete(key);
        if (this.requestIds.get(key) === id) this.requestIds.delete(key);
      });
    this.pending.set(key, pending);
    return pending;
  }

  cacheKey(info) {
    return `${info.key}|${this.voice || 'auto'}|${this.rate}`;
  }

  async play(entry, info, gen) {
    if (gen !== this.gen) return;
    try {
      this.context ??= new AudioContext();
      entry.buffer ??= await this.context.decodeAudioData(new Uint8Array(entry.audio).buffer);
    } catch (err) {
      if (gen === this.gen) this.fail(err);
      return;
    }
    if (gen !== this.gen) return;
    const audio = new SpeechAudio(this.context, entry.buffer);
    this.audio = audio;
    this.words = entry.words;
    this.playback = { entry, info, opening: false };
    this.wordIndex = -1;
    this.currentKey = info.key;

    const tick = () => {
      if (gen !== this.gen || this.audio !== audio) return;
      this.checkClock();
    };
    audio.addEventListener('timeupdate', tick);
    audio.addEventListener('playing', () => {
      if (gen !== this.gen || this.audio !== audio || this.waitingFor || !this.playback || audio.paused) return;
      this.setState('playing');
      this.startTicker(audio, gen);
      this.armClock();
    });
    audio.addEventListener('pause', () => {
      if (gen === this.gen && this.audio === audio && !audio.ended && !this.waitingFor && this.playback) {
        clearTimeout(this.timer);
        this.setState('paused');
      }
    });
    audio.addEventListener('ended', () => {
      if (gen === this.gen && this.audio === audio && !this.waitingFor) this.partFinished();
    });
    audio.addEventListener('error', () => {
      if (gen !== this.gen || this.audio !== audio) return;
      this.fail(new Error('Audio playback failed'));
    });
    // Metadata word times omit the encoder's leading silence.
    if (this.words.length) audio.currentTime = this.words[0].startMs / 1000;
    audio.stopAt = entry.endMs === null ? entry.buffer.duration : entry.endMs / 1000;
    this.playCurrent();
  }

  playCurrent() {
    const { audio, gen } = this;
    audio
      .play()
      .then(() => {
        if (gen !== this.gen || this.audio !== audio || audio.paused || this.waitingFor) return;
        this.setState('playing');
        this.prefetch();
      })
      .catch((err) => {
        if (gen !== this.gen || this.audio !== audio || err?.name === 'AbortError') return;
        this.fail(err);
      });
  }

  // A requestAnimationFrame loop follows the word clock smoothly; timeupdate keeps the
  // highlight alive when Chromium throttles animation frames in the background.
  startTicker(audio, gen) {
    cancelAnimationFrame(this.raf);
    const frame = () => {
      if (gen !== this.gen || this.audio !== audio) return;
      this.checkClock();
      if (!audio.paused && !audio.ended) this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  follow(ms) {
    const index = wordIndexAt(this.words, ms);
    if (index === this.wordIndex) return;
    this.wordIndex = index;
    const word = index >= 0 ? this.words[index] : null;
    this.host.highlight(word ? { start: word.start, end: word.end } : null);
  }

  // Both a media-clock timer and timeupdate run without animation frames. Recheck
  // currentTime on wake so buffering and user pauses cannot cause an early turn.
  armClock() {
    clearTimeout(this.timer);
    const endMs = this.partEndMs();
    if (!this.audio || this.audio.paused || this.audio.ended || this.waitingFor || endMs === null) return;
    this.timer = setTimeout(() => {
      this.checkClock();
      this.armClock();
    }, Math.max(10, endMs - this.audio.currentTime * 1000));
  }

  partEndMs() {
    if (!this.playback) return null;
    return this.playback.opening ? this.words.at(-1)?.endMs ?? null : this.playback.entry.endMs;
  }

  checkClock() {
    if (!this.audio || this.audio.paused || this.waitingFor) return;
    const ms = this.audio.currentTime * 1000;
    const endMs = this.partEndMs();
    if (endMs !== null && ms >= endMs) {
      this.partFinished();
      return;
    }
    this.follow(ms);
  }

  partFinished() {
    const part = this.playback;
    if (!part || this.waitingFor) return;
    clearTimeout(this.timer);
    if (!part.opening && part.entry.next) {
      this.waitingFor = part.entry.next.info;
      this.audio.pause();
      this.host.highlight(null);
      this.setState('turning');
      if (!this.host.turn()) {
        this.waitingFor = null;
        this.stopPlayback();
        this.setState('finished');
      }
      return;
    }
    if (part.opening && part.info.text.slice(part.entry.next.end - part.info.start).trim()) {
      this.startPage(part.entry.next.end);
      return;
    }
    this.playback = null;
    this.audio.pause();
    this.finished(this.gen, this.audio);
  }

  resumeOpening(info) {
    const part = this.playback;
    this.waitingFor = null;
    part.info = info;
    part.opening = true;
    this.currentKey = info.key;
    this.words = part.entry.next.words;
    this.wordIndex = -1;
    this.audio.currentTime = this.words[0].startMs / 1000;
    this.audio.stopAt = this.words.at(-1).endMs / 1000;
    this.playCurrent();
  }

  finished(gen, audio) {
    if (gen !== this.gen || this.audio !== audio) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.host.highlight(null);
    this.words = [];
    this.wordIndex = -1;
    if (!this.enabled) return;
    if (!this.host.canTurn()) {
      this.setState('finished');
      return;
    }
    this.setState('turning');
    if (!this.host.turn()) this.setState('finished');
  }

  prefetch() {
    if (!this.enabled) return;
    const next = this.playback?.entry.next;
    const info = next?.info ?? this.host.nextPage(this.playback?.info);
    if (!info || !info.text.trim()) return;
    const start = next?.end ?? info.start;
    if (!info.text.slice(start - info.start).trim()) {
      const following = this.host.nextPage(info);
      if (following?.text.trim()) this.entryFor(following).catch(() => {});
      return;
    }
    this.entryFor(info, start).catch(() => {
      // A prefetch failure is not worth interrupting the page that is playing.
    });
  }

  togglePause() {
    if (this.state === 'turning') return false;
    if (!this.audio || this.audio.ended || this.state === 'finished') {
      if (this.enabled && this.state !== 'loading') this.startPage();
      return false;
    }
    if (this.audio.paused) {
      this.setState('playing');
      this.playCurrent();
      return false;
    }
    this.audio.pause();
    this.setState('paused');
    return true;
  }

  stopPlayback() {
    clearTimeout(this.timer);
    this.timer = 0;
    this.playback = null;
    this.waitingFor = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    const audio = this.audio;
    this.audio = null;
    if (audio) {
      audio.pause();
      audio.dispose();
    }
    this.words = [];
    this.wordIndex = -1;
    this.host.highlight(null);
  }

  cancelPending() {
    for (const id of this.requestIds.values()) window.api.cancelSpeech(id);
    this.requestIds.clear();
    this.pending.clear();
  }

  setState(state, detail = '') {
    this.state = state;
    this.detail = detail;
    this.host.onState?.(state, detail);
  }

  fail(err) {
    if (err?.name === 'AbortError') return;
    this.gen++;
    this.stopPlayback();
    const raw = String(err?.message ?? err);
    let detail = raw;
    if (/fetch failed|ENOTFOUND|ECONN|network/i.test(raw)) {
      detail = 'Could not reach the speech service. Check your internet connection.';
    } else if (/timed out|did not respond/i.test(raw)) {
      detail = 'The speech service did not respond. Try again in a moment.';
    } else if (/403|rejected/i.test(raw)) {
      detail = 'The speech service rejected the request. Check your system clock and try again.';
    }
    this.setState('error', detail);
    this.host.onError?.(detail);
  }
}
