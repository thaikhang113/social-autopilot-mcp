// Tools = the LLM's hands. Decision lives with the model; this file only exposes
// "what is pending" and "do the thing I decided".
import crypto from 'node:crypto';
import { z } from 'zod';
import { dueOccurrence, validateCron, DEFAULT_TZ } from './engine.mjs';
import { decideEvent } from './decision.mjs';
import { assessGrounding } from './grounding.mjs';

function validateTimezone(tz) {
  if (!tz) return;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new Error(`unknown timezone: ${tz}`);
  }
}

function pendingSummary(event) {
  const base =
    event.kind === 'post_due'
      ? `Post due (slot ${event.slotId}) on ${event.platform}: ${event.brief}`
      : `Comment by ${event.author ?? 'unknown'}: ${event.text ?? ''}`;
  if (!event.lastAttempt?.ambiguous) return base;
  return `${base} [previous ${event.lastAttempt.action ?? 'send'} attempt may have succeeded; verify then pass retry=true]`;
}

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
      await kick?.();
      const events = data.state.events.slice(0, limit).map((event) => ({
        ...event,
        summary: pendingSummary(event),
      }));
      return { structuredContent: { events }, content: [{ type: 'text', text: JSON.stringify({ events }) }] };
    }
  );

  server.registerTool(
    'decide',
    {
      title: 'Record the decision for one event',
      description:
        'Use after reading an event. action must match the event kind: post_due -> publish|skip, ' +
        'comment -> reply|skip. perform=false (default) is a non-destructive preview; the event stays pending. ' +
        'Call again with perform=true to actually send. If the event warns that a previous attempt may have succeeded, ' +
        'check the platform first and pass retry=true.',
      inputSchema: {
        event_id: z.string(),
        action: z.enum(['reply', 'skip', 'publish']),
        text: z.string().optional(),
        reason: z.string().optional(),
        perform: z.boolean().optional(),
        retry: z.boolean().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        decided: z.string(),
        performed: z.string().optional(),
        dryRun: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    },
    async ({ event_id, action, text, reason, perform, retry }) => {
      const out = await decideEvent({ data, social, event_id, action, text, reason, perform, retry });
      return { structuredContent: out, content: [{ type: 'text', text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    'verify_facts',
    {
      title: 'Ground a draft against your documents',
      description:
        'Use BEFORE publishing or replying when the content states facts. Returns the passage from your own ' +
        'knowledge base (NotebookLM bridge or docs folder) plus whether the draft is supported. ' +
        'The check rejects drafts that contradict the source (for example a negated claim or an opposite pricing claim).',
      inputSchema: { query: z.string(), draft: z.string().optional() },
      outputSchema: {
        answer: z.string(),
        sources: z.array(z.object({ title: z.string(), url: z.string().optional() })),
        supported: z.boolean(),
        reason: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async ({ query, draft }) => {
      const result = await knowledge.search(query);
      const grounding = assessGrounding(draft ?? '', result.answer ?? '');
      const out = {
        answer: result.answer ?? '',
        sources: result.sources ?? [],
        supported: grounding.supported,
        reason: grounding.reason,
      };
      return { structuredContent: out, content: [{ type: 'text', text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    'schedule_post',
    {
      title: 'Schedule a posting slot (one-shot or cron)',
      description:
        'Use when the user wants scheduled posting. Pass `cron` for a repeating schedule ' +
        '(5 fields: minute hour day-of-month month day-of-week, e.g. "0 9 * * 1,3,5" = 09:00 Mon/Wed/Fri) ' +
        'or only `at` for a single post at that moment. When a slot is due the engine raises a post_due ' +
        'event and the model writes the content then, so posts never go stale. Identical schedules are deduped.',
      inputSchema: {
        brief: z.string().describe('What this slot should be about / tone / goal'),
        at: z
          .string()
          .optional()
          .describe('ISO date-time. One-shot: when to post. With cron: earliest allowed run (defaults to now)'),
        cron: z
          .string()
          .optional()
          .describe('5-field cron in the schedule timezone. Mutually exclusive with every_days, which is gone'),
        timezone: z.string().optional().describe('IANA zone for cron, e.g. Asia/Saigon. Defaults to schedule.timezone'),
      },
      outputSchema: {
        slotId: z.string(),
        next: z.string(),
        cron: z.string().nullable(),
        deduped: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    },
    async ({ brief, at, cron, timezone }) => {
      if (!brief?.trim()) throw new Error('brief is required');
      if (!at && !cron) throw new Error('provide `at` (one-shot) or `cron` (recurring)');
      if (at && !Number.isFinite(new Date(at).getTime())) throw new Error('at must be an ISO date-time');
      if (!data.cfg.schedule || typeof data.cfg.schedule !== 'object') data.cfg.schedule = { posts: [] };
      if (!Array.isArray(data.cfg.schedule.posts)) data.cfg.schedule.posts = [];
      const tz = timezone ?? data.cfg.schedule.timezone ?? DEFAULT_TZ;
      validateTimezone(tz);
      if (cron) validateCron(cron, tz);

      const start = at ?? new Date().toISOString();
      const existing = data.cfg.schedule.posts.find(
        (slot) =>
          slot &&
          slot.brief === brief &&
          slot.at === start &&
          (slot.cron ?? null) === (cron ?? null) &&
          (slot.timezone ?? data.cfg.schedule.timezone ?? DEFAULT_TZ) === tz
      );
      if (existing) {
        kick?.();
        const next = dueOccurrence(existing, Date.now(), tz) ?? start;
        const out = { slotId: existing.id, next, cron: existing.cron ?? null, deduped: true };
        return { structuredContent: out, content: [{ type: 'text', text: JSON.stringify(out) }] };
      }

      const slotId = `slot_${crypto.randomBytes(4).toString('hex')}`;
      const slot = { id: slotId, brief, at: start, cron: cron ?? null, ...(tz ? { timezone: tz } : {}) };
      data.cfg.schedule.posts.push(slot);
      try {
        data.saveConfig?.();
      } catch (err) {
        const index = data.cfg.schedule.posts.indexOf(slot);
        if (index >= 0) data.cfg.schedule.posts.splice(index, 1);
        throw err;
      }
      // A slot already in the past must surface now, not up to pollSeconds later.
      kick?.();
      const next = dueOccurrence({ at: start, cron: cron ?? null }, Date.now(), tz) ?? start;
      const out = { slotId, next, cron: cron ?? null };
      return { structuredContent: out, content: [{ type: 'text', text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    'cancel_slot',
    {
      title: 'Cancel a posting slot',
      description:
        'Remove a scheduled slot by its slotId. Pending post_due events for that slot are discarded too. ' +
        'A send already in flight cannot be recalled.',
      inputSchema: { slot_id: z.string() },
      outputSchema: { ok: z.boolean(), removed: z.boolean(), pendingRemoved: z.number().int() },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    },
    async ({ slot_id }) => {
      const posts = Array.isArray(data.cfg.schedule?.posts) ? data.cfg.schedule.posts : [];
      const index = posts.findIndex((slot) => slot?.id === slot_id);
      if (index < 0) {
        const out = { ok: true, removed: false, pendingRemoved: 0 };
        return { structuredContent: out, content: [{ type: 'text', text: JSON.stringify(out) }] };
      }
      const slot = posts[index];
      posts.splice(index, 1);
      try {
        data.saveConfig?.();
      } catch (err) {
        posts.splice(index, 0, slot);
        throw err;
      }
      const originalEvents = data.state.events.slice();
      let pendingRemoved = 0;
      data.state.events = data.state.events.filter((event) => {
        if (event.slotId !== slot_id) return true;
        pendingRemoved += 1;
        return false;
      });
      try {
        data.save();
      } catch (err) {
        data.state.events = originalEvents;
        posts.splice(index, 0, slot);
        try {
          data.saveConfig?.();
        } catch {}
        throw err;
      }
      data.log({ type: 'slot_cancelled', slotId: slot_id, pendingRemoved });
      const out = { ok: true, removed: true, pendingRemoved };
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
      const decisions = data.state.history.slice(-limit).map((h) => ({
        kind: h.kind ?? 'unknown',
        action: h.action ?? 'unknown',
        text: h.text ?? '',
        at: h.at ?? '',
      }));
      return { structuredContent: { decisions }, content: [{ type: 'text', text: JSON.stringify({ decisions }) }] };
    }
  );
}
