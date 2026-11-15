// A decoded speech recording with an audio-engine stop point. BufferSource duration
// prevents lookahead speech leaking across a page even when JS timers are throttled.
export class SpeechAudio extends EventTarget {
  constructor(context, buffer) {
    super();
    this.context = context;
    this.buffer = buffer;
    this.stopAt = buffer.duration;
    this.position = 0;
    this.startedAt = 0;
    this.source = null;
    this.paused = true;
    this.ended = false;
    this.version = 0;
  }

  get currentTime() {
    return this.paused || !this.source ? this.position :
      Math.min(this.stopAt, this.position + this.context.currentTime - this.startedAt);
  }

  set currentTime(value) {
    this.pause();
    this.position = Math.max(0, Math.min(this.buffer.duration, value));
    this.ended = false;
  }

  async play() {
    if (!this.paused) return;
    const version = ++this.version;
    // Match media-element semantics: paused reflects playback intent immediately,
    // including while the audio device is waking, so Space can cancel that start.
    this.paused = false;
    try {
      await this.context.resume();
    } catch (err) {
      if (version === this.version) this.paused = true;
      throw err;
    }
    if (version !== this.version) throw new DOMException('Playback cancelled', 'AbortError');
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.context.destination);
    const end = Math.min(this.buffer.duration, this.stopAt);
    source.onended = () => {
      source.disconnect();
      if (this.source !== source) return;
      this.source = null;
      this.position = end;
      this.paused = true;
      this.ended = true;
      this.dispatchEvent(new Event('ended'));
    };
    this.source = source;
    this.startedAt = this.context.currentTime;
    this.paused = false;
    this.ended = false;
    source.start(0, this.position, Math.max(0, end - this.position));
    this.dispatchEvent(new Event('playing'));
  }

  pause() {
    this.version++;
    if (this.paused) return;
    this.position = this.currentTime;
    this.paused = true;
    const source = this.source;
    this.source = null;
    source?.stop();
    source?.disconnect();
    this.dispatchEvent(new Event('pause'));
  }

  dispose() {
    this.pause();
    this.buffer = null;
  }
}
