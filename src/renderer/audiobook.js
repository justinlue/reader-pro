// Audiobook playback: reads the visible page through Edge TTS, highlights the word being
// spoken, and turns to the next page when the audio ends.
//
// The host owns the reader state:
//   page()          -> page info for the visible page, or null
//   nextPage()      -> page info after it, or null (used to prefetch)
//   canTurn()       -> whether a following page exists
//   turn()          -> turn one page forward, which commits and calls pageChanged()
//   highlight(range)-> show or clear { start, end } book offsets
//   onState(state, detail) -> update the settings status text
//   onError(message)       -> surface a recoverable failure
//
// Page info is { key, text, start, end }. `text` is the speakable page slice and
// `start` is its book offset.

import { alignSpeechWords, autoVoice, wordIndexAt } from '../core/speech.mjs';

const CACHE_LIMIT = 4;

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
    this.url = null;
    this.words = [];
    this.wordIndex = -1;
    this.raf = 0;
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
    if (info?.key && info.key === this.currentKey) return;
    this.startPage();
  }

  restart() {
    this.gen++;
    this.stopPlayback();
    this.startPage();
  }

  // Stops playback and abandons in-flight requests without changing the enabled setting.
  // Used while a new document replaces the old one.
  suspend() {
    this.gen++;
    this.stopPlayback();
    this.cancelPending();
  }

  startPage() {
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
    this.entryFor(info).then(
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

  entryFor(info) {
    const key = this.cacheKey(info);
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);
    let pending = this.pending.get(key);
    if (pending) return pending;
    const id = `speech-${++this.requestSeq}`;
    this.requestIds.set(key, id);
    pending = window.api
      .synthesizeSpeech({
        id,
        text: info.text,
        voice: this.voice || autoVoice(info.text),
        rate: this.rate,
      })
      .then((result) => {
        const entry = {
          audio: result.audio,
          words: alignSpeechWords(info.text, info.start, result.words ?? []),
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

  play(entry, info, gen) {
    if (gen !== this.gen) return;
    const blob = new Blob([entry.audio], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    this.audio = audio;
    this.url = url;
    this.words = entry.words;
    this.wordIndex = -1;
    this.currentKey = info.key;

    const tick = () => {
      if (gen !== this.gen || this.audio !== audio) return;
      this.follow(audio.currentTime * 1000);
    };
    audio.addEventListener('timeupdate', tick);
    audio.addEventListener('playing', () => {
      if (gen === this.gen) this.setState('playing');
    });
    audio.addEventListener('pause', () => {
      if (gen === this.gen && this.audio === audio && !audio.ended) this.setState('paused');
    });
    audio.addEventListener('ended', () => this.finished(gen, audio));
    audio.addEventListener('error', () => {
      if (gen !== this.gen || this.audio !== audio) return;
      this.fail(new Error('Audio playback failed'));
    });
    this.startTicker(audio, gen);
    audio
      .play()
      .then(() => {
        if (gen !== this.gen || this.audio !== audio) return;
        this.setState('playing');
        this.prefetch();
      })
      .catch((err) => {
        if (gen !== this.gen || err?.name === 'AbortError') return;
        this.fail(err);
      });
  }

  // A requestAnimationFrame loop follows the word clock smoothly; timeupdate keeps the
  // highlight alive when Chromium throttles animation frames in the background.
  startTicker(audio, gen) {
    cancelAnimationFrame(this.raf);
    const frame = () => {
      if (gen !== this.gen || this.audio !== audio) return;
      this.follow(audio.currentTime * 1000);
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
    const info = this.host.nextPage();
    if (!info || !info.text.trim()) return;
    const key = this.cacheKey(info);
    if (this.cache.has(key) || this.pending.has(key)) return;
    this.entryFor(info).catch(() => {
      // A prefetch failure is not worth interrupting the page that is playing.
    });
  }

  togglePause() {
    if (this.state === 'turning') return false;
    if (!this.audio || this.audio.ended) {
      if (this.enabled && this.state !== 'loading') this.startPage();
      return false;
    }
    if (this.audio.paused) {
      this.setState('playing');
      this.startTicker(this.audio, this.gen);
      this.audio.play().catch((err) => this.fail(err));
      return false;
    }
    this.audio.pause();
    this.setState('paused');
    return true;
  }

  stopPlayback() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    const audio = this.audio;
    this.audio = null;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
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
