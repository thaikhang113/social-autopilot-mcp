// Background engine: due scheduled posts -> events, new comments -> events.
// The LLM decides the content; this only decides WHEN there is something to decide.
import { CronExpressionParser } from 'cron-parser';

export const DEFAULT_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// Reject a bad cron/timezone at write time so the config never holds a slot that
// silently never fires. Throws with the parser's own message.
export function validateCron(cron, tz = DEFAULT_TZ) {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron must have exactly 5 fields, got ${fields.length}`);
  try {
    CronExpressionParser.parse(cron, { tz });
  } catch (e) {
    throw new Error(`invalid cron: ${e.message}`);
  }
}

// When is a slot due? Returns the occurrence timestamp (ISO) to raise, or null.
//
// `cron` (5-field) schedules the slot; without it the slot fires once at `at`.
// For cron we return the MOST RECENT occurrence at or before `now`. Missed runs
// collapse into ONE event on purpose: catching up by posting five times after
// five days offline is never what a user wants from a social account.
//
// cron-parser's prev() is exclusive of currentDate, so asking at exactly
// 09:00:00 for "0 9 * * *" returns YESTERDAY. Nudging by 1s makes the boundary
// occurrence count as reached; without it a 09:00 tick would post a day late.
export function dueOccurrence(slot, now = Date.now(), tz = DEFAULT_TZ) {
  const at = new Date(slot.at ?? now).getTime();
  if (!Number.isFinite(at)) return null;

  if (slot.cron) {
    let it;
    try {
      it = CronExpressionParser.parse(slot.cron, { currentDate: new Date(now + 1000), tz });
    } catch {
      return null; // invalid expression: schedule_post validates, so this is stale/edited config
    }
    const prev = it.prev().toISOString();
    return new Date(prev).getTime() >= at ? prev : null; // never before the slot's start
  }

  return at <= now ? new Date(at).toISOString() : null;
}

export function startEngine({ data, cfg, social }) {
  const sec = Math.max(5, Number(cfg.schedule?.pollSeconds ?? 60)) * 1000;
  const tz = cfg.schedule?.timezone ?? DEFAULT_TZ;

  const seedDuePosts = () => {
    const now = Date.now();
    for (const slot of cfg.schedule?.posts ?? []) {
      const occ = dueOccurrence(slot, now, tz);
      if (!occ) continue;
      // Occurrence-scoped dedup: the same window is never raised twice, while
      // later windows still fire. A one-shot slot has one window, so it is spent.
      const done = data.state.history.some((h) => h.slotId === slot.id && h.occurrence === occ);
      const queued = data.state.events.some((e) => e.slotId === slot.id && e.occurrence === occ);
      if (done || queued) continue;
      data.pushEvent({
        id: data.nextId('evt'),
        kind: 'post_due',
        slotId: slot.id,
        occurrence: occ,
        cron: slot.cron ?? null,
        brief: slot.brief ?? 'Write today\'s post.',
        platform: social.cfg.platform ?? 'mock',
        createdAt: new Date().toISOString(),
      });
    }
  };

  const seedComments = async () => {
    let list = [];
    try {
      list = await social.comments(new Date(Date.now() - 7 * 864e5).toISOString());
    } catch (err) {
      data.log({ type: 'poll_error', message: String(err.message) });
      return;
    }
    for (const c of list) {
      const known =
        data.state.inbound.some((x) => x.id === c.id) ||
        data.state.history.some((h) => h.commentId === c.id) ||
        data.state.events.some((e) => e.commentId === c.id);
      if (known) continue;
      data.state.inbound.push({ ...c, handled: false });
      data.pushEvent({ id: data.nextId('evt'), kind: 'comment', commentId: c.id, author: c.author, text: c.text, createdAt: new Date().toISOString() });
    }
  };

  const tick = async () => {
    // Never let one bad poll kill the process: async errors in setInterval are
    // unhandled rejections, which terminate node by default.
    try {
      seedDuePosts();
    } catch (err) {
      data.log({ type: 'engine_error', where: 'posts', message: String(err?.message ?? err) });
    }
    try {
      await seedComments();
    } catch (err) {
      data.log({ type: 'engine_error', where: 'comments', message: String(err?.message ?? err) });
    }
  };
  tick();
  const timer = setInterval(tick, sec);
  timer.unref?.();
  // Exposed so schedule_post can raise a due event immediately instead of
  // waiting up to pollSeconds. Callers must not add a second timer.
  return { timer, tick };
}