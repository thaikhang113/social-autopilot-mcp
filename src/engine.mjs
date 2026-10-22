// Background engine: due scheduled posts -> events, new comments -> events.
// The LLM decides the content; this only decides WHEN there is something to decide.
const DAY = 864e5;

// When is a slot due? Returns the occurrence timestamp (ISO) to raise, or null.
// A one-shot slot (no everyDays) yields its `at` once. A recurring slot yields the
// most recent occurrence at or before `now` — missed runs collapse into ONE event
// on purpose: posting five times at boot to "catch up" is never what a user wants.
export function dueOccurrence(slot, now = Date.now()) {
  const at = new Date(slot.at).getTime();
  if (!Number.isFinite(at)) return null;
  const every = Number(slot.everyDays) || 0;
  if (every <= 0) return at <= now ? new Date(at).toISOString() : null;
  const step = every * DAY;
  if (at > now) return null;
  return new Date(at + Math.floor((now - at) / step) * step).toISOString();
}

export function startEngine({ data, cfg, social }) {
  const sec = Math.max(5, Number(cfg.schedule?.pollSeconds ?? 60)) * 1000;

  const seedDuePosts = () => {
    const now = Date.now();
    for (const slot of cfg.schedule?.posts ?? []) {
      const occ = dueOccurrence(slot, now);
      if (!occ) continue;
      const recurring = Number(slot.everyDays) > 0;
      // One-shot slots are spent forever once published; recurring slots only for
      // the occurrence at hand.
      const done = recurring
        ? data.state.history.some((h) => h.slotId === slot.id && h.action === 'publish' && h.occurrence === occ)
        : data.state.history.some((h) => h.slotId === slot.id && h.action === 'publish');
      const queued = data.state.events.some((e) => e.slotId === slot.id && (!recurring || e.occurrence === occ));
      if (done || queued) continue;
      data.pushEvent({
        id: data.nextId('evt'),
        kind: 'post_due',
        slotId: slot.id,
        occurrence: occ,
        everyDays: slot.everyDays ?? null,
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