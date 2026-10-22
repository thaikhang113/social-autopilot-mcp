// Tiny JSON-file store: state persists across restarts; log is append-only JSONL.
import fs from 'node:fs';
import path from 'node:path';

const DATA = path.resolve(import.meta.dirname, '..', 'data');
fs.mkdirSync(DATA, { recursive: true });

const STATE_FILE = path.join(DATA, 'state.json');
const LOG_FILE = path.join(DATA, 'log.jsonl');

const empty = () => ({
  seq: 0,
  events: [], // pending decisions for the LLM: {id, kind:'post_due'|'comment', ...}
  history: [], // decided events kept for audit: {id, kind, action, text, at}
  inbound: [], // comments not yet decided
  outbox: [], // what we published/replied (mock platform side)
});

let loadedState = null;
if (fs.existsSync(STATE_FILE)) {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8').trim();
    if (raw) loadedState = JSON.parse(raw);
  } catch (err) {
    console.error('[store] corrupt state.json, recovering with empty state:', err.message);
  }
}
export const state = Object.assign(empty(), loadedState ?? {});

export function save() {
  // OneDrive/AV can hold the target briefly; retry instead of crashing the process.
  for (let i = 0; ; i++) {
    try {
      const tmp = `${STATE_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, STATE_FILE);
      return;
    } catch (err) {
      if (i >= 4) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (i + 1));
    }
  }
}

export function nextId(prefix) {
  state.seq += 1;
  return `${prefix}_${Date.now().toString(36)}${state.seq}`;
}

export function log(entry) {
  fs.appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

export function pushEvent(event) {
  state.events.push(event);
  log({ type: 'event', event });
  save();
  return event;
}

export function takeEvent(id) {
  const i = state.events.findIndex((e) => e.id === id);
  return i < 0 ? null : state.events.splice(i, 1)[0];
}

export function tailLog(n = 20) {
  if (!fs.existsSync(LOG_FILE)) return [];
  const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-n).map((l) => JSON.parse(l));
}
