// Pure state helpers. Kept separate from store.mjs so regression tests can
// exercise corrupt/oversized state without touching the real data directory.
export const STATE_LIMITS = {
  history: 5000,
  outbox: 2000,
  handledInbound: 5000,
  commentDone: 20000,
};

export function emptyState() {
  return {
    seq: 0,
    events: [],
    history: [],
    inbound: [],
    outbox: [],
    inflight: {},
    slotDone: {},
    commentDone: {},
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function copyMap(value) {
  const out = {};
  if (!isObject(value)) return out;
  for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (typeof item === 'string') out[key] = item;
  }
  return out;
}

function objectArray(value, name, warn) {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item));
  }
  if (value !== undefined) warn(`state.${name} is not an array; resetting to []`);
  return [];
}

export function normalizeState(raw, warn = () => {}) {
  if (raw === null || raw === undefined) return emptyState();
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`state.json is not an object; resetting to empty state`);
    return emptyState();
  }

  const state = emptyState();
  state.seq = Number.isInteger(raw.seq) && raw.seq >= 0 ? raw.seq : 0;
  const events = objectArray(raw.events, 'events', warn);
  state.events = events.filter(
    (event) => typeof event.id === 'string' && (event.kind === 'post_due' || event.kind === 'comment')
  );
  if (state.events.length !== events.length) warn('state.events contains malformed entries; dropped them');
  const history = objectArray(raw.history, 'history', warn);
  state.history = history.filter((entry) => typeof entry.id === 'string');
  if (state.history.length !== history.length) warn('state.history contains malformed entries; dropped them');
  const inbound = objectArray(raw.inbound, 'inbound', warn);
  state.inbound = inbound.filter((comment) => typeof comment.id === 'string');
  if (state.inbound.length !== inbound.length) warn('state.inbound contains malformed entries; dropped them');
  state.outbox = objectArray(raw.outbox, 'outbox', warn);

  if (raw.inflight && typeof raw.inflight === 'object' && !Array.isArray(raw.inflight)) {
    for (const [id, attempt] of Object.entries(raw.inflight)) {
      if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue;
      if (attempt && typeof attempt === 'object' && attempt.event) state.inflight[id] = attempt;
    }
  } else if (raw.inflight !== undefined) {
    warn('state.inflight is not an object; resetting to {}');
  }

  // Dedupe maps survive history/inbound compaction. Rebuild missing entries
  // from old state so an upgrade does not re-raise old occurrences/comments.
  state.slotDone = copyMap(raw.slotDone);
  state.commentDone = copyMap(raw.commentDone);
  for (const entry of state.history) {
    if (entry.slotId && entry.occurrence) {
      const previous = state.slotDone[entry.slotId];
      const previousMs = Date.parse(previous);
      if (!previous || !Number.isFinite(previousMs) || Date.parse(entry.occurrence) > previousMs) {
        state.slotDone[entry.slotId] = entry.occurrence;
      }
    }
    if (entry.commentId && !state.commentDone[entry.commentId]) {
      state.commentDone[entry.commentId] = entry.at ?? new Date().toISOString();
    }
  }
  for (const comment of state.inbound) {
    if (comment.handled && comment.id && !state.commentDone[comment.id]) {
      state.commentDone[comment.id] = comment.at ?? new Date().toISOString();
    }
  }
  return state;
}

export function compactState(state, limits = STATE_LIMITS) {
  const tail = (list, limit) => (limit > 0 ? list.slice(-limit) : []);
  if (state.history.length > limits.history) state.history = tail(state.history, limits.history);
  if (state.outbox.length > limits.outbox) state.outbox = tail(state.outbox, limits.outbox);

  // Keep every unhandled comment: it may still need a reply. Old handled
  // comments only serve dedupe, so cap them.
  if (state.inbound.length > limits.handledInbound) {
    const keep = new Set();
    for (const comment of state.inbound) if (!comment.handled) keep.add(comment.id);
    const handled = tail(state.inbound.filter((comment) => comment.handled), limits.handledInbound);
    for (const comment of handled) keep.add(comment.id);
    state.inbound = state.inbound.filter((comment) => keep.has(comment.id));
  }

  // Keep a bounded id-only dedupe map. It outlives history/inbound trimming, so
  // a cron occurrence or comment cannot be raised again just because audit
  // records were compacted.
  const doneEntries = Object.entries(state.commentDone ?? {});
  const commentLimit = limits.commentDone ?? STATE_LIMITS.commentDone;
  if (doneEntries.length > commentLimit) {
    doneEntries.sort((a, b) => (Date.parse(a[1]) || 0) - (Date.parse(b[1]) || 0));
    state.commentDone = Object.fromEntries(doneEntries.slice(-commentLimit));
  }
  return state;
}

// A process may die after the platform accepted a send but before the success
// was saved. Re-raise that event with an explicit "unknown" marker instead of
// silently losing it or blindly sending a duplicate.
export function recoverInflight(state) {
  let recovered = 0;
  for (const [id, attempt] of Object.entries(state.inflight)) {
    if (attempt?.event && !state.history.some((entry) => entry.id === id) && !state.events.some((event) => event.id === id)) {
      state.events.unshift({
        ...attempt.event,
        lastAttempt: {
          action: attempt.action,
          at: attempt.at,
          status: 'unknown',
          ambiguous: true,
          recoveredAt: new Date().toISOString(),
        },
      });
      recovered += 1;
    }
    delete state.inflight[id];
  }
  return recovered;
}
