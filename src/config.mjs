// Config is JSON, but a partial local override (for example only the timezone)
// must not wipe the rest of schedule.posts. Deep-merge objects, replace arrays.
export const DEFAULT_CONFIG = {
  port: 8787,
  token: 'CHANGE_ME',
  social: { kind: 'mock', platform: 'mock', url: '', token: '' },
  knowledge: { kind: 'file', dir: 'docs', url: '', token: '' },
  schedule: { timezone: 'Asia/Saigon', posts: [], pollSeconds: 60 },
};

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (!BLOCKED_KEYS.has(key)) out[key] = clone(item);
    }
    return out;
  }
  return value;
}

export function deepMerge(base, override) {
  const out = isPlainObject(base) ? clone(base) : {};
  if (!isPlainObject(override)) return out;
  for (const [key, value] of Object.entries(override)) {
    if (BLOCKED_KEYS.has(key)) continue;
    if (isPlainObject(value)) out[key] = deepMerge(isPlainObject(out[key]) ? out[key] : {}, value);
    else if (Array.isArray(value)) out[key] = clone(value);
    else out[key] = value;
  }
  return out;
}

// Normalize the merged config once so every consumer can trust the shape.
export function normalizeConfig(input = {}) {
  const cfg = deepMerge(DEFAULT_CONFIG, input);
  cfg.port = Number(cfg.port);
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    const err = new Error(`invalid port: ${JSON.stringify(cfg.port)} (expected 1-65535)`);
    err.code = 'EBADPORT';
    throw err;
  }
  const schedule = isPlainObject(cfg.schedule) ? cfg.schedule : {};
  cfg.schedule = { ...DEFAULT_CONFIG.schedule, ...schedule };
  cfg.schedule.posts = Array.isArray(schedule.posts)
    ? schedule.posts.filter((slot) => isPlainObject(slot) && typeof slot.id === 'string')
    : [];
  const poll = Number(cfg.schedule.pollSeconds);
  cfg.schedule.pollSeconds = Number.isFinite(poll) ? Math.max(5, poll) : DEFAULT_CONFIG.schedule.pollSeconds;
  if (!cfg.schedule.timezone) cfg.schedule.timezone = DEFAULT_CONFIG.schedule.timezone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: cfg.schedule.timezone });
  } catch {
    const err = new Error(`invalid schedule.timezone: ${JSON.stringify(cfg.schedule.timezone)}`);
    err.code = 'EBADTZ';
    throw err;
  }
  cfg.social = { ...DEFAULT_CONFIG.social, ...(isPlainObject(cfg.social) ? cfg.social : {}) };
  cfg.knowledge = { ...DEFAULT_CONFIG.knowledge, ...(isPlainObject(cfg.knowledge) ? cfg.knowledge : {}) };
  if (typeof cfg.token !== 'string' || cfg.token.length === 0) cfg.token = DEFAULT_CONFIG.token;
  return cfg;
}
