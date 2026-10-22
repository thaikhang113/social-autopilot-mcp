// Background engine: due scheduled posts -> events, new comments -> events.
// The LLM decides the content; this only decides WHEN there is something to decide.
import { Social } from './adapters.mjs';

export function startEngine({ data, cfg, social }) {
  const sec = Math.max(5, Number(cfg.schedule?.pollSeconds ?? 60)) * 1000;

  const seedDuePosts = () => {
    const now = Date.now();
    for (const slot of cfg.schedule?.posts ?? []) {
      const at = new Date(slot.at).getTime();
      if (!Number.isFinite(at) || at > now) continue;
      const done = data.state.history.some((h) => h.slotId === slot.id && h.action === 'publish');
      const queued = data.state.events.some((e) => e.slotId === slot.id);
      if (done || queued) continue;
      data.pushEvent({
        id: data.nextId('evt'),
        kind: 'post_due',
        slotId: slot.id,
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
