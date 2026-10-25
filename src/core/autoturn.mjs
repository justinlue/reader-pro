// Auto page turning: a countdown that advances one page at a fixed interval.
//
// The reader restarts the countdown whenever it shows a new page, so a manual turn gets
// a full interval on the page it lands on. The host supplies the page side effects:
//
// host: {
//   turn()      turn one page forward; committing that page calls restart() again
//   canTurn()   whether a page to turn to exists (no timer is armed otherwise)
//   onChange()  the speed or paused state changed, so the UI can follow
// }
//
// `clock` defaults to the global timer functions; tests pass their own.

export const AUTO_TURN_SPEEDS = [30, 60, 90];

// Saved state may hold a speed this build no longer offers; treat anything else as off.
export function autoTurnSeconds(value) {
  const seconds = Number(value);
  return AUTO_TURN_SPEEDS.includes(seconds) ? seconds : 0;
}

export class AutoTurn {
  constructor(host, clock = globalThis) {
    this.host = host;
    this.clock = clock;
    this.seconds = 0; // 0 = off
    this.paused = false;
    this.timer = null;
  }

  get enabled() {
    return this.seconds > 0;
  }

  get running() {
    return this.enabled && !this.paused;
  }

  // Selects a speed, or turns the feature off with 0. The countdown starts over.
  setSeconds(value) {
    const seconds = autoTurnSeconds(value);
    if (seconds === this.seconds) return;
    this.seconds = seconds;
    if (!this.enabled) this.paused = false;
    this.restart();
    this.host.onChange?.();
  }

  // Space pauses and resumes without touching the configured speed.
  togglePause() {
    if (!this.enabled) return false;
    this.paused = !this.paused;
    this.restart();
    this.host.onChange?.();
    return this.paused;
  }

  // A new page is on screen: the next turn is a whole interval away. This also covers
  // the turn the countdown itself makes, once its page commits.
  restart() {
    this.stop();
    if (this.running && this.host.canTurn()) {
      this.timer = this.clock.setTimeout(() => this.fire(), this.seconds * 1000);
    }
  }

  stop() {
    if (this.timer === null) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  fire() {
    this.timer = null;
    if (!this.running || !this.host.canTurn()) return;
    this.host.turn();
    this.restart();
  }
}
