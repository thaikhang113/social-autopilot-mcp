// Tiny JSON-file store: state persists across restarts; log is append-only JSONL.
// The data directory can be isolated with SAM_DATA_DIR (used by the e2e suite).
import fs from 'node:fs';
import path from 'node:path';
import { compactState, normalizeState, recoverInflight } from './state-schema.mjs';

export const DATA_DIR = process.env.SAM_DATA_DIR
  ? path.resolve(process.env.SAM_DATA_DIR)
  : path.resolve(import.meta.dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LOG_FILE = path.join(DATA_DIR, 'log.jsonl');
const LOG_MAX_BYTES = Number(process.env.SAM_LOG_MAX_BYTES ?? 5 * 1024 * 1024);

function warn(message) {
  console.error(`[store] ${message}`);
}

let loadedState = null;
if (fs.existsSync(STATE_FILE)) {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8').trim();
    if (raw) loadedState = JSON.parse(raw);
  } catch (err) {
    warn(`corrupt state.json, recovering with empty state: ${err.message}`);
  }
}
export const state = normalizeState(loadedState, warn);

export function save() {
  compactState(state);
  // OneDrive/AV can hold the target briefly; retry instead of crashing the process.
  for (let i = 0; ; i += 1) {
    let tmp = null;
    try {
      tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
      fs.renameSync(tmp, STATE_FILE);
      return;
    } catch (err) {
      if (tmp) {
        try {
          fs.unlinkSync(tmp);
        } catch {}
      }
      if (i >= 4) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (i + 1));
    }
  }
}

export function nextId(prefix) {
  state.seq += 1;
  return `${prefix}_${Date.now().toString(36)}${state.seq}`;
}

function rotateLog() {
  if (!(LOG_MAX_BYTES > 0)) return;
  let size = 0;
  try {
    size = fs.statSync(LOG_FILE).size;
  } catch {
    return;
  }
  if (size < LOG_MAX_BYTES) return;
  try {
    fs.rmSync(`${LOG_FILE}.3`, { force: true });
    if (fs.existsSync(`${LOG_FILE}.2`)) fs.renameSync(`${LOG_FILE}.2`, `${LOG_FILE}.3`);
    if (fs.existsSync(`${LOG_FILE}.1`)) fs.renameSync(`${LOG_FILE}.1`, `${LOG_FILE}.2`);
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch (err) {
    warn(`could not rotate log.jsonl: ${err.message}`);
  }
}

export function log(entry) {
  // Logging is best-effort: a full disk must not block a decision.
  try {
    rotateLog();
    fs.appendFileSync(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch (err) {
    warn(`log append failed: ${err.message}`);
  }
}

export function pushEvent(event) {
  state.events.push(event);
  log({ type: 'event', event });
  save();
  return event;
}

export function takeEvent(id) {
  const index = state.events.findIndex((event) => event.id === id);
  return index < 0 ? null : state.events.splice(index, 1)[0];
}

export function restoreEvent(event) {
  if (!state.events.some((item) => item.id === event.id)) state.events.unshift(event);
}

// Persist the claim BEFORE the side effect. If the process dies mid-send, the
// next startup can recover the event as "attempt may have succeeded".
export function beginAttempt(event, { action, text, reason }) {
  state.inflight[event.id] = {
    event,
    action,
    text,
    reason,
    at: new Date().toISOString(),
    status: 'sending',
  };
  try {
    save();
  } catch (err) {
    // The event was already claimed from memory. Leave the claim map clean so
    // the caller can restore it without a phantom in-flight attempt.
    delete state.inflight[event.id];
    throw err;
  }
}

export function finishAttempt(id) {
  delete state.inflight[id];
}

export function failAttempt(id, { error, ambiguous }) {
  const attempt = state.inflight[id];
  if (!attempt) return null;
  delete state.inflight[id];
  const event = {
    ...attempt.event,
    lastAttempt: {
      action: attempt.action,
      at: attempt.at,
      status: ambiguous ? 'unknown' : 'failed',
      ambiguous: Boolean(ambiguous),
      error: String(error ?? '').slice(0, 500),
    },
  };
  restoreEvent(event);
  return event;
}

// Call after acquiring the single-instance lock, before the engine starts.
export function recoverAttempts() {
  const hadInflight = Object.keys(state.inflight).length > 0;
  const recovered = recoverInflight(state);
  if (hadInflight) save();
  return recovered;
}

export function tailLog(n = 20) {
  if (!fs.existsSync(LOG_FILE)) return [];
  const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-n).map((line) => JSON.parse(line));
}
