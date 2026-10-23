// Persistent app state in %APPDATA%\Reader\state.json. The renderer owns everything
// except `window`, which the main process tracks itself.

import { app } from 'electron';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const file = () => join(app.getPath('userData'), 'state.json');

let state = null;
let timer = null;

export function loadState() {
  if (state) return state;
  try {
    state = JSON.parse(readFileSync(file(), 'utf8'));
  } catch {
    state = {};
  }
  return state;
}

export function updateState(patch) {
  Object.assign(loadState(), patch);
  clearTimeout(timer);
  timer = setTimeout(flushState, 250);
}

export function flushState() {
  clearTimeout(timer);
  timer = null;
  if (!state) return;
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, file());
}
