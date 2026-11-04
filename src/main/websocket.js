// Minimal RFC 6455 client over TLS for the Edge speech service.
//
// Node's built-in WebSocket cannot attach the browser headers the service expects, and
// the app should not gain a native dependency just for one WebSocket. This client
// implements the handshake, masking, fragmentation and control frames that endpoint uses.

import { createHash, randomBytes } from 'node:crypto';
import { connect } from 'node:tls';
import { BINARY, CLOSE, CONTINUATION, FrameDecoder, PING, PONG, TEXT, encodeFrame } from './ws-frame.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_HEADER_BYTES = 64 * 1024;

export class WsConnection {
  constructor(url, { headers = {}, timeoutMs = 15000 } = {}) {
    this.url = new URL(url);
    if (this.url.protocol !== 'wss:') throw new Error('Only wss:// connections are supported');
    this.headers = headers;
    this.timeoutMs = timeoutMs;
    this.onMessage = null;
    this.onClose = null;
    this.onError = null;
    this.socket = null;
    this.decoder = new FrameDecoder();
    this.buffer = Buffer.alloc(0);
    this.key = randomBytes(16).toString('base64');
    this.upgraded = false;
    this.finished = false;
    this.fragments = null;
    this.fragmentOpcode = 0;
    this.openPromise = null;
  }

  open() {
    if (this.openPromise) return this.openPromise;
    this.openPromise = new Promise((resolve, reject) => {
      const host = this.url.hostname;
      const port = Number(this.url.port) || 443;
      const timer = setTimeout(() => {
        this.fail(new Error(`Timed out connecting to ${host}`));
        reject(new Error(`Timed out connecting to ${host}`));
      }, this.timeoutMs);
      this.openReject = (err) => {
        clearTimeout(timer);
        reject(err);
      };
      this.openResolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.socket = connect({ host, port, servername: host });
      this.socket.setNoDelay(true);
      this.socket.on('secureConnect', () => this.sendHandshake(host, port));
      this.socket.on('data', (data) => this.receive(data));
      this.socket.on('error', (err) => this.fail(err));
      this.socket.on('close', () => this.socketClosed());
    });
    return this.openPromise;
  }

  sendHandshake(host, port) {
    const path = `${this.url.pathname}${this.url.search}`;
    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}${port === 443 ? '' : `:${port}`}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${this.key}`,
      'Sec-WebSocket-Version: 13',
    ];
    for (const [name, value] of Object.entries(this.headers)) lines.push(`${name}: ${value}`);
    this.socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  }

  receive(data) {
    if (this.finished) return;
    this.buffer = this.buffer.length === 0 ? Buffer.from(data) : Buffer.concat([this.buffer, data]);
    if (!this.upgraded) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (this.buffer.length > MAX_HEADER_BYTES) this.fail(new Error('WebSocket handshake header is too large'));
        return;
      }
      const head = this.buffer.subarray(0, end).toString('utf8');
      const rest = this.buffer.subarray(end + 4);
      this.buffer = Buffer.alloc(0);
      const response = parseResponse(head);
      if (response.status !== 101) {
        const err = new Error(`WebSocket handshake failed with HTTP ${response.status}`);
        err.status = response.status;
        err.headers = response.headers;
        this.fail(err);
        return;
      }
      const expected = createHash('sha1').update(this.key + GUID).digest('base64');
      if (response.headers['sec-websocket-accept'] !== expected) {
        this.fail(new Error('WebSocket handshake returned an invalid accept key'));
        return;
      }
      this.upgraded = true;
      this.openResolve?.({ headers: response.headers });
      this.openResolve = null;
      this.openReject = null;
      if (rest.length > 0) this.parseFrames(rest);
      return;
    }
    this.parseFrames(this.buffer);
    this.buffer = Buffer.alloc(0);
  }

  parseFrames(data) {
    try {
      this.decoder.push(data, (frame) => this.handleFrame(frame));
    } catch (err) {
      this.fail(err);
    }
  }

  handleFrame({ fin, opcode, payload }) {
    if (opcode === PING) {
      this.writeFrame(PONG, payload);
      return;
    }
    if (opcode === PONG) return;
    if (opcode === CLOSE) {
      this.writeFrame(CLOSE, payload.subarray(0, 125));
      this.finished = true;
      this.socket?.end();
      this.onClose?.();
      return;
    }
    if (opcode === CONTINUATION) {
      if (!this.fragments) {
        this.fail(new Error('Unexpected WebSocket continuation frame'));
        return;
      }
      this.fragments.push(payload);
      if (!fin) return;
      const whole = Buffer.concat(this.fragments);
      const first = this.fragmentOpcode;
      this.fragments = null;
      this.fragmentOpcode = 0;
      this.dispatch(first, whole);
      return;
    }
    if (opcode !== TEXT && opcode !== BINARY) return;
    if (this.fragments) {
      this.fail(new Error('Unexpected WebSocket data frame during fragmentation'));
      return;
    }
    if (!fin) {
      this.fragments = [payload];
      this.fragmentOpcode = opcode;
      return;
    }
    this.dispatch(opcode, payload);
  }

  dispatch(opcode, payload) {
    if (opcode === TEXT) this.onMessage?.('text', payload.toString('utf8'));
    else this.onMessage?.('binary', payload);
  }

  writeFrame(opcode, payload) {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(encodeFrame(opcode, payload));
  }

  sendText(text) {
    if (!this.upgraded) throw new Error('WebSocket is not open');
    this.writeFrame(TEXT, Buffer.from(text, 'utf8'));
  }

  close() {
    if (this.finished) return;
    this.finished = true;
    try {
      this.writeFrame(CLOSE, Buffer.alloc(0));
    } catch {
      // The socket may already be gone; closing is best effort.
    }
    this.socket?.end();
    this.onClose?.();
  }

  destroy() {
    if (this.finished) {
      this.socket?.destroy();
      return;
    }
    this.finished = true;
    this.socket?.destroy();
    this.onClose?.();
  }

  fail(err) {
    if (this.finished) return;
    this.finished = true;
    this.socket?.destroy();
    this.openReject?.(err);
    this.openReject = null;
    this.openResolve = null;
    this.onError?.(err);
    this.onClose?.();
  }

  socketClosed() {
    if (this.finished) return;
    this.finished = true;
    this.openReject?.(new Error('WebSocket closed before the handshake completed'));
    this.openReject = null;
    this.openResolve = null;
    this.onClose?.();
  }
}

function parseResponse(head) {
  const lines = head.split('\r\n');
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines[0])?.[1]);
  const headers = {};
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return { status, headers };
}
