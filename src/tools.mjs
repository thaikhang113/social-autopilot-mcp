// Tools = the LLM's hands. Decision lives with the model; this file only exposes
// "what is pending" and "do the thing I decided".
import crypto from 'node:crypto';
import { z } from 'zod';

export function registerTools(server, { data, cfg, social, knowledge, kick }) {
  // Auth is enforced once, at the HTTP layer (server.mjs). Per-tool `token` args
  // are gone: an MCP client like ChatGPT sends credentials as an Authorization
  // header, never inside tool arguments, so a token param could only ever fail.
  server.registerTool(
    'list_pending_events',
    {
      title: 'List pending events',
      description:
        'Use this to see what needs a decision right now: scheduled posts whose time arrived, and new comments. ' +
        'Call it first, then decide per event: reply, skip, or write the post.',
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
      outputSchema: {
        events: z.array(
          z.object({
            id: z.string(),
            kind: z.enum(['post_due', 'comment']),
            summary: z.string(),
          })
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async ({ limit = 20 }) => {
      const events = data.state.events.slice(0, limit).map((e) => ({
        id: e.id,
        kind: e.kind,
        summary:
          e.kind === 'post_due'
            ? `Post due (slot ${e.slotId}) on ${e.platform}: ${e.brief}`
            : `Comment by ${e.author ?? 'unknown'}: ${e.text ?? ''}`,
        ...e,
      }));
      return { structuredContent: { events }, content: [{ type: 'text', text: JSON.stringify({ events }) }] };
    }
  );

  server.registerTool(
    'decide',
    {
      title: 'Record the decision for one event',
      description:
        'Use after reading an event. action=skip drops it (say why), action=reply needs text, ' +
        'action=publish needs text. Nothing is published here unless you pass perform=true.',
      inputSchema: {
        event_id: z.string(),
        action: z.enum(['reply', 'skip', 'publish']),
        text: z.string().optional(),
        reason: z.string().optional(),
        perform: z.boolean().optional(),
      },
      outputSchema: { ok: z.boolean(), decided: z.string(), performed: z.string().optional() },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    },
    async ({ event_id, action, text, reason, perform }) => {
      const ev = data.takeEvent(event_id);
      if (!ev) throw new Error(`unknown or already-decided event: ${event_id}`);
      if ((action === 'reply' || action === 'publish') && !text?.trim()) throw new Error(`${action} needs text`);

      const entry = { ...ev, action, text: text ?? '', reason: reason ?? '', at: new Date().toISOString() };
      let performed;
      if (perform) {
        if (ev.kind === 'post_due' && action === 'publish') performed = (await social.publish(text)).id;
        else if (ev.kind === 'comment' && action === 'reply') performed = (await social.reply(ev.commentId, text)).id;
        else performed = 'noop';
        entry.performed = performed;
      }
      data.state.history.push(entry);
      if (ev.commentId) {
        const c = data.state.inbound.find((x) => x.id === ev.commentId);
        if (c) c.handled = true;
      }
      data.log({ type: 'decision', entry });
      data.save();
      const out = { ok: true, decided: action, ...(performed ? { performed } : {}) };
      return { structuredContent: out, content: [{ type: 'text', text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    'verify_facts',
    {
      title: 'Ground a draft against your documents',
      description:
        'Use BEFORE publishing or replying when the content states facts. Returns the passage from your own ' +
        'knowledge base (NotebookLM bridge or docs folder) plus whether the draft is supported.',
      inputSchema: { query: z.string(), draft: z.string().optional() },
      outputSchema: { answer: z.string(), sources: z.array(z.object({ title: z.string(), url: z.string().optional() })), supported: z.boolean() },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async ({ query, draft }) => {
      const r = await knowledge.search(query);
      const words = (draft ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 4);
      const bag = `${r.answer}`.toLowerCase();
      const hit = words.filter((w) => bag.includes(w)).length;
      const supported = words.length === 0 ? r.answer.length > 0 : hit / words.length >= 0.35;
      const out = { answer: r.answer ?? '', sources: r.sources ?? [], supported };
      return { structuredContent: out, content: [{ type: 'text', text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    'schedule_post',
    {
      title: 'Schedule a recurring posting slot',
      description:
        'Use when the user wants periodic posting. Creates a slot; when its time arrives the engine raises a ' +
        'post_due event and the model writes the content then (so posts stay fresh).',
      inputSchema: {
        brief: z.string().describe('What this slot should be about / tone / goal'),
        at: z.string().describe('ISO date-time of the next occurrence'),
        every_days: z.number().int().min(1).max(365).optional(),
      },
      outputSchema: { slotId: z.string(), next: z.string() },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    },
    async ({ brief, at, every_days }) => {
      if (!Number.isFinite(new Date(at).getTime())) throw new Error('at must be an ISO date-time');
      const slotId = `slot_${crypto.randomBytes(4).toString('hex')}`;
      data.cfg.schedule = data.cfg.schedule ?? { posts: [] };
      data.cfg.schedule.posts.push({ id: slotId, brief, at, everyDays: every_days ?? null });
      data.saveConfig?.();
      // A slot already in the past must surface now, not up to pollSeconds later.
      kick?.();
      const out = { slotId, next: at };
      return { structuredContent: out, content: [{ type: 'text', text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    'recent_activity',
    {
      title: 'Recent activity',
      description: 'Use to check what was already posted/replied so the model does not repeat itself.',
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
      outputSchema: { decisions: z.array(z.object({ kind: z.string(), action: z.string(), text: z.string(), at: z.string() })) },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async ({ limit = 20 }) => {
      const decisions = data.state.history.slice(-limit).map((h) => ({ kind: h.kind, action: h.action, text: h.text ?? '', at: h.at }));
      return { structuredContent: { decisions }, content: [{ type: 'text', text: JSON.stringify({ decisions }) }] };
    }
  );
}
