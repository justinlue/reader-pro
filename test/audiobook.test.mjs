import test from 'node:test';
import assert from 'node:assert/strict';
import { Audiobook } from '../src/renderer/audiobook.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(t, texts = ['Alpha ends. ', 'Next opens. More follows. ', 'Third starts. Last words. '], synthesize, resume) {
  const players = [];
  const sources = [];
  class Context {
    constructor() {
      this.currentTime = 0;
      this.destination = {};
    }
    async resume() { if (resume) await resume(); }
    async decodeAudioData() { return { duration: 10 }; }
    createBufferSource() {
      const source = {
        connect() {}, disconnect() {}, stop() {},
        start: (_when, offset, duration) => {
          source.offset = offset;
          source.duration = duration;
        },
      };
      sources.push(source);
      return source;
    }
  }
  const requests = [];
  const cancelled = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = new Map();
  for (const [key, value] of Object.entries({
    AudioContext: Context,
    window: { api: {
      synthesizeSpeech: async (request) => {
        requests.push(request);
        if (synthesize) return synthesize(request);
        return {
          audio: new Uint8Array([1, 2, 3]),
          words: [...request.text.matchAll(/\S+/g)].map((match, i) => ({
            text: match[0], startMs: 100 + i * 300, durationMs: 200,
          })),
        };
      },
      cancelSpeech: (id) => cancelled.push(id),
    } },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let offset = 0;
  const pages = texts.map((text, i) => {
    const info = { key: `page-${i}`, text, start: offset, end: offset + text.length };
    offset = info.end;
    return info;
  });
  let index = 0;
  let turns = 0;
  const highlights = [];
  const errors = [];
  const book = new Audiobook({
    page: () => pages[index],
    nextPage: (info = pages[index]) => pages[pages.findIndex((page) => page.key === info.key) + 1] ?? null,
    canTurn: () => index < pages.length - 1,
    turn: () => { turns++; return index < pages.length - 1; },
    highlight: (range) => highlights.push(range),
    onError: (message) => errors.push(message),
  });
  t.after(() => {
    book.setEnabled(false);
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return {
    book, pages, requests, cancelled, highlights, errors, sources,
    get players() {
      if (book.audio && !players.some((p) => p.target === book.audio)) {
        const target = book.audio;
        // Observe the real player through the media adapter's clock and events.
        players.push(new Proxy(target, {
          get(object, key) {
            if (key === 'target') return object;
            if (key === 'src') return object.buffer ? 'buffer' : '';
            if (key === 'at') return (ms) => {
              if (object.buffer) object.context.currentTime += ms / 1000 - object.currentTime;
              object.dispatchEvent(new Event('timeupdate'));
            };
            if (key === 'end') return () => object.dispatchEvent(new Event('ended'));
            const value = object[key];
            return typeof value === 'function' ? value.bind(object) : value;
          },
          set(object, key, value) {
            if (key === 'currentTime') object.context.currentTime += value - object.currentTime;
            else object[key] = value;
            return true;
          },
        }));
      }
      return players;
    },
    get turns() { return turns; },
    commit(i = index + 1) { index = i; book.pageChanged(); },
  };
}

test('joint boundary audio pauses for the turn and resumes without repeating the opening', async (t) => {
  const h = setup(t);
  h.book.setEnabled(true);
  await flush();
  assert.equal(h.requests[0].text, 'Alpha ends. Next opens. ');
  assert.equal(h.requests[0].tailStart, 0);
  const audio = h.players[0];
  audio.at(600); // End of the final word, before the MP3's trailing silence/EOF.
  assert.equal(h.turns, 1);
  assert.equal(audio.paused, true);
  assert.equal(h.book.state, 'turning');
  assert.ok(h.requests.some((r) => r.text === 'More follows. Third starts. '));
  h.commit();
  await flush();
  assert.equal(h.players.length, 1);
  assert.equal(audio.paused, false);
  assert.equal(audio.currentTime, 0.7);
  audio.at(700);
  assert.deepEqual(h.highlights.at(-1), { start: 12, end: 16 });
  audio.at(1200);
  await flush();
  assert.equal(h.players.length, 2);
  assert.equal(h.turns, 1);
  h.players[1].at(101);
  assert.deepEqual(h.highlights.at(-1), { start: 24, end: 28 });
});

test('single-sentence pages advance once each and finish without replaying their opening', async (t) => {
  const h = setup(t, ['One ends. ', 'Two ends. ', 'Three ends. ']);
  h.book.setEnabled(true);
  await flush();
  h.players[0].at(600);
  h.commit();
  await flush();
  h.players[0].at(1200);
  assert.equal(h.turns, 2);
  h.players[0].end(); // A late media event must not turn a second time.
  assert.equal(h.turns, 2);
  h.commit();
  await flush();
  h.players[1].at(600);
  assert.equal(h.book.state, 'finished');
  assert.equal(h.turns, 2);
  assert.deepEqual(h.requests.map((r) => r.text), ['One ends. Two ends. ', 'Three ends. ']);
});

test('manual navigation abandons the opening and starts the selected page in full', async (t) => {
  const h = setup(t);
  h.book.setEnabled(true);
  await flush();
  const old = h.players[0];
  h.commit(); // Manual turn before narration reaches the page boundary.
  await flush();
  assert.equal(old.src, '');
  assert.ok(h.requests.some((r) => r.text === 'Next opens. More follows. Third starts. '));
  old.end();
  old.at(5000);
  assert.equal(h.turns, 0);
  h.players.at(-1).at(101);
  assert.deepEqual(h.highlights.at(-1), { start: 12, end: 16 });
});

test('pause and resume retain the opening clock and background timer', async (t) => {
  const h = setup(t);
  h.book.setEnabled(true);
  await flush();
  const audio = h.players[0];
  assert.equal(h.book.togglePause(), true);
  t.mock.timers.tick(10000);
  assert.equal(h.turns, 0);
  assert.equal(h.book.state, 'paused');
  assert.equal(h.book.togglePause(), false);
  await flush();
  // No RAF or timeupdate: the media clock timer must still complete the page.
  audio.currentTime = 0.6;
  t.mock.timers.tick(500);
  assert.equal(h.turns, 1);
  assert.equal(h.book.togglePause(), false); // Preserve existing behavior during a turn.
  h.commit();
  await flush();
  assert.equal(h.book.togglePause(), true);
  assert.equal(audio.currentTime, 0.7);
  t.mock.timers.tick(5000);
  assert.equal(h.players.length, 1);
  h.book.togglePause();
  await flush();
  audio.at(1200);
  await flush();
  assert.equal(h.players.length, 2);
});

test('missing boundary timings fall back to page-only speech and wait for media end', async (t) => {
  const h = setup(t, undefined, async () => ({ audio: new Uint8Array([1]), words: [] }));
  h.book.setEnabled(true);
  await flush();
  assert.equal(h.requests[0].text, 'Alpha ends. Next opens. ');
  assert.equal(h.requests[1].text, 'Alpha ends. ');
  h.players[0].at(10000);
  assert.equal(h.turns, 0);
  h.players[0].end();
  assert.equal(h.turns, 1);
  h.commit();
  await flush();
  assert.equal(h.players.length, 2);
});

test('a word spanning the page boundary falls back without reading the next page', async (t) => {
  const h = setup(t, ['An inter', 'esting word. More words. ']);
  h.book.setEnabled(true);
  await flush();
  assert.equal(h.requests[0].text, 'An interesting word. ');
  assert.equal(h.requests[1].text, 'An inter');
  h.players[0].at(600);
  assert.equal(h.turns, 1);
  h.commit();
  await flush();
  assert.equal(h.requests.at(-1).text, 'esting word. More words. ');
});

test('voice and rate changes during a turn discard the retained player', async (t) => {
  const h = setup(t);
  h.book.setEnabled(true);
  await flush();
  const old = h.players[0];
  old.at(600);
  h.book.setVoice('en-US-GuyNeural');
  h.book.setRate(20);
  h.commit();
  await flush();
  assert.equal(old.src, '');
  const request = h.requests.findLast((r) => r.text === 'Next opens. More follows. Third starts. ');
  assert.equal(request.voice, 'en-US-GuyNeural');
  assert.equal(request.rate, 20);
  assert.equal(h.players.length, 2);
  h.players[1].at(101);
  assert.deepEqual(h.highlights.at(-1), { start: 12, end: 16 });
});

test('a relayout preserving the page keeps audio, while a new range abandons the continuation', async (t) => {
  const h = setup(t);
  h.book.setEnabled(true);
  await flush();
  const old = h.players[0];
  h.book.pageChanged();
  await flush();
  assert.equal(h.players.length, 1);
  old.at(600);
  h.pages[1] = { ...h.pages[1], key: 'new-layout', text: 'Next opens. ', end: 24 };
  h.commit();
  await flush();
  assert.equal(old.src, '');
  assert.equal(h.players.length, 2);
  h.players[1].at(101);
  assert.deepEqual(h.highlights.at(-1), { start: 12, end: 16 });
});

test('disabling during a turn prevents retained speech from resuming', async (t) => {
  const h = setup(t);
  h.book.setEnabled(true);
  await flush();
  const old = h.players[0];
  old.at(600);
  h.book.setEnabled(false);
  h.commit();
  await flush();
  assert.equal(h.book.state, 'off');
  assert.equal(old.src, '');
  assert.equal(h.players.length, 1);
});

test('CJK sentence endings and noncontiguous page offsets keep highlights in the right page', async (t) => {
  const h = setup(t, ['前页。', '后页。再读。']);
  h.pages[1] = { ...h.pages[1], start: 10, end: 16 };
  h.book.setEnabled(true);
  await flush();
  assert.equal(h.requests[0].text, '前页。 后页。');
  h.players[0].at(300);
  h.commit();
  await flush();
  h.players[0].at(400);
  assert.deepEqual(h.highlights.at(-1), { start: 10, end: 13 });
  assert.equal(h.players.length, 1);
});

test('incomplete final-word metadata does not cut off the rest of a page', async (t) => {
  const h = setup(t, undefined, async () => ({
    audio: new Uint8Array([1]), words: [{ text: 'Alpha', startMs: 100, durationMs: 200 }],
  }));
  h.book.setEnabled(true);
  await flush();
  assert.equal(h.requests[1].text, 'Alpha ends. ');
  h.players[0].at(300);
  assert.equal(h.turns, 0);
  h.players[0].end();
  assert.equal(h.turns, 1);
});

test('failed prefetch retries the remainder without replaying its opening', async (t) => {
  let attempts = 0;
  const h = setup(t, undefined, async (request) => {
    if (request.text.startsWith('More follows.') && ++attempts === 1) throw new Error('transient failure');
    return {
      audio: new Uint8Array([1]),
      words: [...request.text.matchAll(/\S+/g)].map((match, i) => ({
        text: match[0], startMs: 100 + i * 300, durationMs: 200,
      })),
    };
  });
  h.book.setEnabled(true);
  await flush();
  h.players[0].at(600);
  h.commit();
  await flush();
  h.players[0].at(1200);
  await flush();
  assert.equal(h.players.length, 2);
  assert.equal(h.errors.length, 0);
  assert.equal(attempts, 2);
  h.players[1].at(101);
  assert.deepEqual(h.highlights.at(-1), { start: 24, end: 28 });
});

test('late synthesis after suspension cannot start the replaced document', async (t) => {
  let resolve;
  const h = setup(t, undefined, () => new Promise((done) => { resolve = done; }));
  h.book.setEnabled(true);
  h.book.suspend();
  resolve({ audio: new Uint8Array([1]), words: [] });
  await flush();
  assert.equal(h.players.length, 0);
  assert.equal(h.cancelled.length, 1);
  assert.equal(h.requests.length, 1); // Cancellation must not launch fallback synthesis.
});

test('queued media events cannot overwrite the turning or finished state', async (t) => {
  const h = setup(t, ['One ends. ', 'Two ends. ', 'Three ends. ']);
  h.book.setEnabled(true);
  await flush();
  h.players[0].at(600);
  h.commit();
  await flush();
  h.players[0].at(1200);
  h.players[0].dispatchEvent(new Event('pause'));
  h.players[0].dispatchEvent(new Event('playing'));
  assert.equal(h.book.state, 'turning');
  assert.equal(h.book.togglePause(), false);
  assert.equal(h.players[0].paused, true);
  h.commit();
  await flush();
  h.players[1].at(600);
  h.players[1].dispatchEvent(new Event('pause'));
  h.players[1].dispatchEvent(new Event('playing'));
  assert.equal(h.book.state, 'finished');
});

test('the audio engine stops at the page boundary even when JS observes it late', async (t) => {
  const h = setup(t);
  h.book.setEnabled(true);
  await flush();
  const audio = h.players[0];
  // BufferSource is given a bounded duration, independently of JS event delivery.
  assert.equal(h.sources[0].offset, 0.1);
  assert.equal(h.sources[0].duration, 0.5);
  audio.at(900); // A throttled timer observes the clock 300 ms after the stop point.
  assert.equal(audio.currentTime, 0.6);
  assert.equal(h.turns, 1);
  h.commit();
  await flush();
  assert.equal(audio.currentTime, 0.7);
  assert.equal(h.sources[1].offset, 0.7);
  assert.equal(h.sources[1].duration, 0.5);
});

test('native audio completion turns the page without RAF or timer delivery', async (t) => {
  const h = setup(t);
  h.book.setEnabled(true);
  await flush();
  const audio = h.players[0];
  h.sources[0].onended();
  assert.equal(h.turns, 1);
  assert.equal(audio.paused, true);
  h.commit();
  await flush();
  assert.equal(h.players.length, 1);
  assert.equal(audio.paused, false);
  assert.equal(audio.currentTime, 0.7);
});

test('Space cancels a pending audio device start or resume', async (t) => {
  let unblock;
  const h = setup(t, undefined, undefined, () => new Promise((done) => { unblock = done; }));
  h.book.setEnabled(true);
  await flush();
  assert.equal(h.book.togglePause(), true);
  unblock();
  await flush();
  assert.equal(h.book.state, 'paused');
  assert.equal(h.sources.length, 0);
  assert.equal(h.book.togglePause(), false);
  assert.equal(h.book.togglePause(), true);
  unblock();
  await flush();
  assert.equal(h.book.state, 'paused');
  assert.equal(h.sources.length, 0);
});
