import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_TURN_SPEEDS, AutoTurn, autoTurnSeconds } from '../src/core/autoturn.mjs';

class FakeClock {
  constructor() {
    this.now = 0;
    this.lastId = 0;
    this.timers = new Map();
  }

  setTimeout(fn, ms) {
    const id = ++this.lastId;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  }

  clearTimeout(id) {
    this.timers.delete(id);
  }

  get pending() {
    return this.timers.size;
  }

  advance(ms) {
    const end = this.now + ms;
    for (;;) {
      let due = null;
      for (const [id, timer] of this.timers) {
        if (timer.at <= end && (!due || timer.at < due.timer.at)) due = { id, timer };
      }
      if (!due) break;
      this.timers.delete(due.id);
      this.now = due.timer.at;
      due.timer.fn();
    }
    this.now = end;
  }
}

// A reader with one page per turn; turn() simulates the commit that re-arms the clock.
function reader({ canTurn = true } = {}) {
  const clock = new FakeClock();
  const pages = { turns: 0, canTurn, changes: 0 };
  const auto = new AutoTurn(
    {
      turn() {
        if (!pages.canTurn) return false;
        pages.turns++;
        auto.restart();
        return true;
      },
      canTurn: () => pages.canTurn,
      onChange: () => pages.changes++,
    },
    clock,
  );
  return { clock, pages, auto };
}

test('turns one page per interval and keeps counting', () => {
  const { clock, pages, auto } = reader();
  auto.setSeconds(30);
  assert.ok(auto.enabled);
  assert.equal(clock.pending, 1);
  clock.advance(29_999);
  assert.equal(pages.turns, 0);
  clock.advance(1);
  assert.equal(pages.turns, 1);
  assert.equal(clock.pending, 1);
  clock.advance(30_000);
  assert.equal(pages.turns, 2);
});

test('a manual page change starts a fresh interval', () => {
  const { clock, pages, auto } = reader();
  auto.setSeconds(60);
  clock.advance(45_000);
  auto.restart();
  clock.advance(59_999);
  assert.equal(pages.turns, 0);
  clock.advance(1);
  assert.equal(pages.turns, 1);
});

test('Space pauses and resumes the countdown', () => {
  const { clock, pages, auto } = reader();
  auto.setSeconds(30);
  clock.advance(10_000);
  assert.equal(auto.togglePause(), true);
  assert.equal(auto.paused, true);
  assert.equal(clock.pending, 0);
  clock.advance(120_000);
  assert.equal(pages.turns, 0);
  assert.equal(auto.togglePause(), false);
  assert.equal(auto.paused, false);
  clock.advance(29_999);
  assert.equal(pages.turns, 0);
  clock.advance(1);
  assert.equal(pages.turns, 1);
});

test('a manual page change while paused does not resume', () => {
  const { clock, pages, auto } = reader();
  auto.setSeconds(30);
  auto.togglePause();
  auto.restart();
  clock.advance(120_000);
  assert.equal(pages.turns, 0);
  assert.equal(auto.paused, true);
});

test('only the three offered speeds are accepted', () => {
  assert.deepEqual(AUTO_TURN_SPEEDS, [30, 60, 90]);
  assert.equal(autoTurnSeconds('60'), 60);
  assert.equal(autoTurnSeconds(45), 0);
  const { clock, auto } = reader();
  auto.setSeconds(45);
  assert.equal(auto.enabled, false);
  assert.equal(clock.pending, 0);
});

test('changing the speed arms the new interval', () => {
  const { clock, pages, auto } = reader();
  auto.setSeconds(30);
  clock.advance(20_000);
  auto.setSeconds(90);
  clock.advance(89_999);
  assert.equal(pages.turns, 0);
  clock.advance(1);
  assert.equal(pages.turns, 1);
});

test('no timer runs without a next page, and a page change re-arms it', () => {
  const { clock, pages, auto } = reader({ canTurn: false });
  auto.setSeconds(30);
  assert.equal(clock.pending, 0);
  clock.advance(120_000);
  assert.equal(pages.turns, 0);
  pages.canTurn = true;
  auto.restart();
  clock.advance(30_000);
  assert.equal(pages.turns, 1);
});

test('turning the feature off stops the countdown and clears the pause', () => {
  const { clock, pages, auto } = reader();
  auto.setSeconds(30);
  auto.togglePause();
  auto.setSeconds(0);
  assert.equal(auto.enabled, false);
  assert.equal(auto.paused, false);
  assert.equal(clock.pending, 0);
  clock.advance(120_000);
  assert.equal(pages.turns, 0);
  assert.equal(auto.togglePause(), false); // off: Space is not a pause control
});

test('state changes notify the settings UI', () => {
  const { pages, auto } = reader();
  auto.setSeconds(30);
  assert.equal(pages.changes, 1);
  auto.togglePause();
  assert.equal(pages.changes, 2);
  auto.setSeconds(0);
  assert.equal(pages.changes, 3);
});
