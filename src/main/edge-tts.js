// Edge TTS client for the main process.
//
// This speaks Microsoft Edge's read-aloud WebSocket protocol directly, the same service
// used by the Python `edge-tts` project, so the app needs neither Python nor an API key.
// A request returns MP3 audio plus word-boundary timings for the highlight.
//
// The service authenticates with a Sec-MS-GEC v2 token: a CS64 checksum and SHA-256 of
// the Edge copyright line followed by Windows file-time ticks rounded down to five
// minutes. The algorithm follows the protocol documented by the MIT-licensed
// msedge-tts project and edge-tts PR #492.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { autoVoice, splitSpeech } from '../core/speech.mjs';
import { WsConnection } from './websocket.js';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_VERSION = '143.0.3650.96';
const SEC_MS_GEC_VERSION = `2-${CHROMIUM_VERSION}`;
const COPYRIGHT = 'Copyright (C) Microsoft Corporation. All rights reserved.';
const HOST = 'speech.platform.bing.com';
const BASE_URL = `https://${HOST}/consumer/speech/synthesize/readaloud`;
const WSS_URL = `wss://${HOST}/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
const VOICES_URL = `${BASE_URL}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const USER_AGENT =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${CHROMIUM_VERSION} Safari/537.36 Edg/${CHROMIUM_VERSION}`;

const CHUNK_BYTES = 2000; // below the service's ~4096-byte SSML limit
const CHUNK_CONCURRENCY = 3;
const CONNECT_TIMEOUT_MS = 15000;
const SYNTH_TIMEOUT_MS = 90000;
const MP3_BYTES_PER_MS = 6; // 48 kbps constant bitrate -> 6000 bytes per second

let clockSkewMs = 0;
let voicesCache = null;
const jobs = new Map();

const swap16 = (value) => ((value << 16) | (value >>> 16)) >>> 0;

function cs64(message, digest) {
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const keyA = (view.getUint32(0, true) | 1) >>> 0;
  const keyB = (view.getUint32(4, true) | 1) >>> 0;
  const padded = Buffer.alloc(Math.ceil(message.length / 8) * 8);
  padded.set(message);
  let swapSum = 0;
  let lastSwap = 0;
  let mix = 0;
  let mixSum = 0;
  const swapTerm = (word, key, mWord, mSum, mProduct) => {
    const sum = (Math.imul(word, key) + Math.imul(swap16(word), mWord)) >>> 0;
    const product = Math.imul(swap16(sum), mSum) >>> 0;
    return (Math.imul(swap16(product), mProduct) + product) >>> 0;
  };
  const mixWord = (value, multipliers) => {
    for (const multiplier of multipliers) value = Math.imul(swap16(value), multiplier) >>> 0;
    return value;
  };
  for (let offset = 0; offset < padded.length; offset += 8) {
    const first = padded.readUInt32LE(offset);
    const second = padded.readUInt32LE(offset + 4);
    const firstSwap = swapTerm(first, keyA, 0xef0569fb, 0x76f50f34, 0xc3efea97);
    lastSwap = swapTerm(second, keyB, 0xc31713db, 0x1881ce3c, 0x35bd1ec9);
    swapSum = (swapSum + firstSwap + lastSwap) >>> 0;
    mix = mixWord(Math.imul(mix + first, keyA) >>> 0, [0xcf98b111, 0x87085b9f, 0x12ceb96d, 0x257e1d83]);
    mixSum = (mixSum + mix) >>> 0;
    mix = mixWord(Math.imul(mix + second, keyB) >>> 0, [0xa27416f5, 0xd38396ff, 0x7c932b89, 0xbfa49f69]);
    mixSum = (mixSum + mix) >>> 0;
  }
  const out = Buffer.alloc(8);
  out.writeUInt32LE((lastSwap ^ mix) >>> 0, 0);
  out.writeUInt32LE((swapSum ^ mixSum) >>> 0, 4);
  return out;
}

// Token for the given time, adjusted by the server's clock when a handshake is rejected.
export function secMsGec(now = Date.now()) {
  const ticks = ((BigInt(Math.round(now)) + 11644473600000n) * 10000n) / 3000000000n * 3000000000n;
  const message = Buffer.from(COPYRIGHT + ticks.toString() + TRUSTED_CLIENT_TOKEN, 'ascii');
  const digest = createHash('sha256').update(message).digest();
  return `${cs64(message, digest).toString('hex')}-${digest.toString('hex')}`.toUpperCase();
}

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const escapeXml = (value) => String(value).replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch]);
const xmlBytes = (ch) => Buffer.byteLength(XML_ESCAPES[ch] ?? ch, 'utf8');
const unescapeXml = (value) =>
  String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

function httpDate() {
  return new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
}

function speechHeaders() {
  return {
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    Origin: ORIGIN,
    'User-Agent': USER_AGENT,
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: `muid=${randomBytes(16).toString('hex').toUpperCase()};`,
  };
}

function voiceHeaders() {
  return {
    'User-Agent': USER_AGENT,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Authority: HOST,
    'Sec-CH-UA': `" Not;A Brand";v="99", "Microsoft Edge";v="${CHROMIUM_VERSION}", "Chromium";v="${CHROMIUM_VERSION}"`,
    'Sec-CH-UA-Mobile': '?0',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
  };
}

function synthUrl() {
  const token = secMsGec(Date.now() + clockSkewMs);
  const connectionId = randomUUID().replaceAll('-', '');
  return `${WSS_URL}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${connectionId}`;
}

function rateValue(value) {
  const number = Number(value);
  const clamped = Number.isFinite(number) ? Math.min(100, Math.max(-90, Math.round(number))) : 0;
  return `${clamped >= 0 ? '+' : ''}${clamped}%`;
}

function validateRequest(request) {
  const text = request?.text;
  if (typeof text !== 'string' || text.trim().length === 0) throw new Error('There is no text to read');
  if (text.length > 100000) throw new Error('The page is too long to read in one request');
  const voice = String(request.voice || autoVoice(text));
  if (!/^[A-Za-z0-9-]{1,80}Neural$/.test(voice)) throw new Error('Invalid voice name');
  return { text, voice, rate: rateValue(request.rate) };
}

function parseHeaders(block) {
  const headers = {};
  for (const line of block.split('\r\n')) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return headers;
}

// One WebSocket request for one chunk. Resolves with MP3 bytes and word timings.
function synthChunk({ text, voice, rate, signal }) {
  return new Promise((resolve, reject) => {
    const connection = new WsConnection(synthUrl(), {
      headers: speechHeaders(),
      timeoutMs: CONNECT_TIMEOUT_MS,
    });
    const audio = [];
    const words = [];
    let settled = false;
    let timer = null;

    const markServerDate = (err) => {
      if (err?.headers?.date) {
        const server = Date.parse(err.headers.date);
        if (Number.isFinite(server)) err.serverDate = server;
      }
      return err;
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) {
        connection.destroy();
        reject(err);
      } else {
        connection.close();
        resolve(value);
      }
    };
    const onAbort = () => {
      const err = new Error('Speech request was cancelled');
      err.name = 'AbortError';
      finish(err);
    };

    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(new Error('The speech service did not respond in time')), SYNTH_TIMEOUT_MS);

    connection.onMessage = (kind, data) => {
      if (kind === 'binary') {
        if (data.length < 2) return;
        // The 16-bit length covers the header text after the two length bytes; the
        // service then sends CRLF before the MP3 frames.
        const headerLength = data.readUInt16BE(0);
        if (headerLength < 2 || headerLength + 2 > data.length) return;
        const header = data.subarray(2, 2 + headerLength).toString('utf8');
        if (!/Path:\s*audio\b/i.test(header)) return;
        audio.push(data.subarray(headerLength + 2));
        return;
      }
      const sep = data.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const headers = parseHeaders(data.slice(0, sep));
      if (headers.path === 'audio.metadata') {
        let payload;
        try {
          payload = JSON.parse(data.slice(sep + 4));
        } catch {
          return;
        }
        for (const item of payload.Metadata ?? []) {
          if (item?.Type !== 'WordBoundary') continue;
          const offset = Number(item.Data?.Offset);
          const duration = Number(item.Data?.Duration);
          if (!Number.isFinite(offset)) continue;
          words.push({
            startMs: Math.max(0, offset / 10000),
            durationMs: Number.isFinite(duration) ? Math.max(0, duration / 10000) : 0,
            text: unescapeXml(item.Data?.text?.Text ?? ''),
          });
        }
      } else if (headers.path === 'turn.end') {
        if (audio.length === 0) finish(new Error('The speech service returned no audio'));
        else finish(null, { audio: Buffer.concat(audio), words });
      }
    };
    connection.onError = (err) => finish(markServerDate(err));
    connection.onClose = () => finish(new Error('The speech connection closed before the page finished'));

    connection
      .open()
      .then(() => {
        connection.sendText(
          `X-Timestamp:${httpDate()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
            '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false",' +
            '"wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n',
        );
        const ssml =
          `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
          `<voice name='${escapeXml(voice)}'><prosody pitch='+0Hz' rate='${rate}' volume='+0%'>` +
          `${escapeXml(text)}</prosody></voice></speak>`;
        connection.sendText(
          `X-RequestId:${randomUUID().replaceAll('-', '')}\r\nContent-Type:application/ssml+xml\r\n` +
            `X-Timestamp:${httpDate()}Z\r\nPath:ssml\r\n\r\n${ssml}`,
        );
      })
      .catch((err) => {
        finish(markServerDate(err));
      });
  });
}

async function synthChunkWithRetry(options) {
  try {
    return await synthChunk(options);
  } catch (err) {
    if (options.signal?.aborted || err?.name === 'AbortError') throw err;
    // A rejected token usually means the system clock differs from the server's.
    if (err?.status === 403 && Number.isFinite(err.serverDate)) {
      clockSkewMs = err.serverDate - Date.now();
    } else if (err?.status && err.status < 500) {
      throw err;
    }
    // The service occasionally stalls or drops a connection; one fresh attempt usually
    // succeeds, and a long page is worth another try rather than an error card.
    return synthChunk(options);
  }
}

// Synthesises a page as a sequence of chunks and stitches the MP3 streams together.
// Chunks are requested concurrently (bounded), so a long page waits for the slowest
// chunk instead of the sum of all of them. Word offsets from later chunks are shifted
// by the decoded duration of earlier audio.
export async function synthesizePage(request) {
  const { text, voice, rate } = validateRequest(request);
  const chunks = splitSpeech(text, CHUNK_BYTES, xmlBytes, request.tailStart);
  const controller = new AbortController();
  const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
  const results = new Array(chunks.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < chunks.length) {
      const index = cursor++;
      const chunk = chunks[index];
      const part = text.slice(chunk.start, chunk.end).trim();
      if (!part) continue;
      results[index] = await synthChunkWithRetry({ text: part, voice, rate, signal });
    }
  };
  try {
    const workers = Array.from({ length: Math.min(CHUNK_CONCURRENCY, chunks.length) }, worker);
    await Promise.all(workers);
  } catch (err) {
    controller.abort();
    throw err;
  }

  const audio = [];
  const words = [];
  let bytes = 0;
  for (const result of results) {
    if (!result) continue;
    const baseMs = bytes / MP3_BYTES_PER_MS;
    for (const word of result.words) {
      words.push({ startMs: baseMs + word.startMs, durationMs: word.durationMs, text: word.text });
    }
    audio.push(result.audio);
    bytes += result.audio.length;
  }
  if (audio.length === 0) throw new Error('There is no text to read');
  return { audio: new Uint8Array(Buffer.concat(audio)), words };
}

// Runs a synthesis with a cancellable job id so the renderer can abandon stale pages.
export async function synthesize(request) {
  const id = String(request?.id ?? '');
  const controller = new AbortController();
  if (id) {
    jobs.get(id)?.abort();
    jobs.set(id, controller);
  }
  try {
    return await synthesizePage({ ...request, signal: controller.signal });
  } finally {
    if (id && jobs.get(id) === controller) jobs.delete(id);
  }
}

export function cancelSynthesis(id) {
  jobs.get(String(id))?.abort();
}

export async function listVoices() {
  if (voicesCache) return voicesCache;
  const response = await fetch(VOICES_URL, {
    headers: voiceHeaders(),
    signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`The voice list request failed (HTTP ${response.status})`);
  const all = await response.json();
  voicesCache = all
    .map((voice) => ({
      name: voice.ShortName,
      locale: voice.Locale,
      language: voice.LocaleName,
      gender: voice.Gender,
    }))
    .filter((voice) => typeof voice.name === 'string' && voice.name.length > 0);
  if (voicesCache.length === 0) throw new Error('The voice list was empty');
  return voicesCache;
}
