import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deepMerge, normalizeConfig } from '../src/config.mjs';
import { assessGrounding } from '../src/grounding.mjs';
import { compactState, emptyState, normalizeState, recoverInflight } from '../src/state-schema.mjs';
import { decideEvent } from '../src/decision.mjs';
import { registerTools } from '../src/tools.mjs';
import { startEngine } from '../src/engine.mjs';
import { acquireLock } from '../src/lock.mjs';

function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n${err.stack}`);
    process.exitCode = 1;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n${err.stack}`);
    process.exitCode = 1;
  }
}

// ---------- config ----------
test('deep merge keeps schedule.posts when local only overrides timezone', () => {
  const merged = deepMerge(
    { schedule: { timezone: 'Asia/Saigon', posts: [{ id: 'slot_1' }], pollSeconds: 60 } },
    { schedule: { timezone: 'UTC' } }
  );
  const cfg = normalizeConfig(merged);
  assert.equal(cfg.schedule.timezone, 'UTC');
  assert.equal(cfg.schedule.posts.length, 1);
  assert.equal(cfg.schedule.pollSeconds, 60);
});

test('arrays are replaced, not concatenated', () => {
  const merged = deepMerge({ schedule: { posts: [{ id: 'slot_1' }] } }, { schedule: { posts: [] } });
  assert.equal(normalizeConfig(merged).schedule.posts.length, 0);
});

test('config defaults are safe and prototype keys are ignored', () => {
  const cfg = normalizeConfig({});
  assert.deepEqual(cfg.schedule.posts, []);
  assert.equal(cfg.token, 'CHANGE_ME');
  const evil = JSON.parse('{"__proto__":{"polluted":true}}');
  const merged = deepMerge({}, evil);
  assert.equal({}.polluted, undefined);
  assert.equal(merged.polluted, undefined);
});

test('invalid port and timezone fail fast', () => {
  assert.throws(() => normalizeConfig({ port: 99999 }), /invalid port/);
  assert.throws(() => normalizeConfig({ schedule: { timezone: 'Not/AZone' } }), /invalid schedule.timezone/);
});

// ---------- grounding ----------
const ANSWER =
  'Dự án Social Autopilot MCP là mã nguồn mở, phát hành miễn phí theo giấy phép MIT.\n' +
  'Dự án không có bảng giá dịch vụ thương mại.';

test('grounding supports a true claim', () => {
  const result = assessGrounding('Dự án là mã nguồn mở miễn phí theo giấy phép MIT', ANSWER);
  assert.equal(result.supported, true, result.reason);
});

test('grounding rejects a negated claim even with high word overlap', () => {
  const result = assessGrounding('Dự án không phải là mã nguồn mở và có bảng giá dịch vụ thương mại', ANSWER);
  assert.equal(result.supported, false, result.reason);
  assert.ok(result.contradictions > 0);
});

test('grounding accepts a negation that matches the source', () => {
  const result = assessGrounding('Dự án không có bảng giá dịch vụ thương mại', ANSWER);
  assert.equal(result.supported, true, result.reason);
});

test('grounding rejects an antonym/price claim', () => {
  const result = assessGrounding('Dự án thu phí bản quyền', ANSWER);
  assert.equal(result.supported, false, result.reason);
});

test('grounding rejects low overlap, empty and punctuation drafts', () => {
  assert.equal(assessGrounding('Dự án có màu xanh và nặng 3kg', ANSWER).supported, false);
  assert.equal(assessGrounding('', ANSWER).supported, false);
  assert.equal(assessGrounding('...', ANSWER).supported, false);
  assert.equal(assessGrounding('Dự án là mã nguồn mở', '').supported, false);
});

// ---------- state schema/compaction/recovery ----------
test('corrupt array fields are reset instead of crashing', () => {
  const warnings = [];
  const state = normalizeState(
    { seq: 'bad', events: {}, history: 'bad', inbound: null, outbox: [{ id: 'o1' }], inflight: [] },
    (message) => warnings.push(message)
  );
  assert.equal(state.seq, 0);
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.history, []);
  assert.deepEqual(state.inbound, []);
  assert.equal(state.outbox.length, 1);
  assert.deepEqual(state.inflight, {});
  assert.ok(warnings.length >= 3);
});

test('compaction keeps unhandled comments and bounds handled history', () => {
  const state = emptyState();
  state.history = Array.from({ length: 5 }, (_, index) => ({ id: `h${index}` }));
  state.outbox = Array.from({ length: 5 }, (_, index) => ({ id: `o${index}` }));
  state.inbound = [
    { id: 'unhandled', handled: false },
    { id: 'handled1', handled: true },
    { id: 'handled2', handled: true },
    { id: 'handled3', handled: true },
  ];
  compactState(state, { history: 2, outbox: 2, handledInbound: 1 });
  assert.deepEqual(state.history.map((item) => item.id), ['h3', 'h4']);
  assert.deepEqual(state.outbox.map((item) => item.id), ['o3', 'o4']);
  assert.ok(state.inbound.some((item) => item.id === 'unhandled'));
  assert.ok(state.inbound.some((item) => item.id === 'handled3'));
  assert.ok(!state.inbound.some((item) => item.id === 'handled1'));
});

test('inflight attempts recover as ambiguous instead of disappearing', () => {
  const state = emptyState();
  state.inflight.evt_1 = { event: { id: 'evt_1', kind: 'comment' }, action: 'reply', at: '2026-01-01T00:00:00.000Z' };
  state.inflight.evt_done = { event: { id: 'evt_done', kind: 'comment' }, action: 'reply', at: '2026-01-01T00:00:00.000Z' };
  state.history.push({ id: 'evt_done' });
  const recovered = recoverInflight(state);
  assert.equal(recovered, 1);
  assert.deepEqual(state.inflight, {});
  const event = state.events.find((item) => item.id === 'evt_1');
  assert.equal(event.lastAttempt.ambiguous, true);
  assert.equal(event.lastAttempt.status, 'unknown');
  assert.ok(!state.events.some((item) => item.id === 'evt_done'));
});

test('dedupe maps survive history/inbound compaction', () => {
  const state = emptyState();
  state.history = Array.from({ length: 5 }, (_, index) => ({
    id: `h${index}`,
    slotId: 'slot_1',
    occurrence: '2026-10-23T02:00:00.000Z',
    commentId: `c${index}`,
  }));
  state.inbound = [{ id: 'c_handled', handled: true, at: '2026-10-23T01:00:00.000Z' }];
  state.slotDone = { slot_1: '2026-10-23T02:00:00.000Z' };
  state.commentDone = { c_handled: '2026-10-23T01:00:00.000Z' };
  compactState(state, { history: 0, outbox: 0, handledInbound: 0, commentDone: 1 });
  assert.equal(state.history.length, 0);
  assert.equal(state.inbound.length, 0);
  assert.equal(state.slotDone.slot_1, '2026-10-23T02:00:00.000Z');
  assert.equal(state.commentDone.c_handled, '2026-10-23T01:00:00.000Z');
});

test('malformed event entries are dropped instead of breaking the tool schema', () => {
  const state = normalizeState({
    events: [
      { id: 'ok', kind: 'comment', commentId: 'c1' },
      { id: 'bad-kind', kind: 'other' },
      { kind: 'comment' },
      null,
    ],
  });
  assert.deepEqual(state.events.map((event) => event.id), ['ok']);
});

test('old state rebuilds dedupe maps from history and inbound', () => {
  const state = normalizeState({
    history: [{ id: 'h1', slotId: 'slot_1', occurrence: '2026-10-23T02:00:00.000Z', commentId: 'c1', at: '2026-10-23T02:01:00.000Z' }],
    inbound: [{ id: 'c2', handled: true, at: '2026-10-23T02:02:00.000Z' }],
  });
  assert.equal(state.slotDone.slot_1, '2026-10-23T02:00:00.000Z');
  assert.equal(state.commentDone.c1, '2026-10-23T02:01:00.000Z');
  assert.equal(state.commentDone.c2, '2026-10-23T02:02:00.000Z');
});

// ---------- decision transaction ----------
function fakeData(events, inbound = []) {
  const state = {
    ...emptyState(),
    events: structuredClone(events),
    inbound: structuredClone(inbound),
  };
  return {
    state,
    takeEvent(id) {
      const index = state.events.findIndex((event) => event.id === id);
      return index < 0 ? null : state.events.splice(index, 1)[0];
    },
    restoreEvent(event) {
      if (!state.events.some((item) => item.id === event.id)) state.events.unshift(event);
    },
    beginAttempt(event, meta) {
      state.inflight[event.id] = { event, ...meta, at: new Date().toISOString(), status: 'sending' };
    },
    finishAttempt(id) {
      delete state.inflight[id];
    },
    failAttempt(id, { error, ambiguous }) {
      const attempt = state.inflight[id];
      if (!attempt) return null;
      delete state.inflight[id];
      const event = {
        ...attempt.event,
        lastAttempt: { action: attempt.action, at: attempt.at, ambiguous, error },
      };
      state.events.unshift(event);
      return event;
    },
    log() {},
    save() {},
  };
}

const commentEvent = { id: 'evt_1', kind: 'comment', commentId: 'c_1', text: 'hello' };
const commentInbound = { id: 'c_1', text: 'hello', handled: false };

function toolHandlers(data) {
  const handlers = {};
  const server = {
    registerTool(name, _definition, handler) {
      handlers[name] = handler;
    },
  };
  registerTools(server, { data, cfg: data.cfg, social: {}, knowledge: {}, kick: () => {} });
  return handlers;
}

await testAsync('schedule_post rolls back the in-memory slot when config write fails', async () => {
  const cfg = { schedule: { timezone: 'UTC', posts: [] } };
  const data = {
    cfg,
    state: emptyState(),
    saveConfig() { throw new Error('read-only config'); },
    save() {},
    log() {},
  };
  const handlers = toolHandlers(data);
  await assert.rejects(
    handlers.schedule_post({ brief: 'future', at: new Date(Date.now() + 3600_000).toISOString() }),
    /read-only config/
  );
  assert.equal(cfg.schedule.posts.length, 0);
});

await testAsync('cancel_slot restores slot and events when state save fails', async () => {
  const slot = { id: 'slot_1', brief: 'x', at: new Date(Date.now() + 3600_000).toISOString(), cron: null, timezone: 'UTC' };
  const event = { id: 'evt_due', kind: 'post_due', slotId: 'slot_1', occurrence: slot.at };
  const cfg = { schedule: { timezone: 'UTC', posts: [slot] } };
  let configWrites = 0;
  const data = {
    cfg,
    state: { ...emptyState(), events: [event] },
    saveConfig() { configWrites += 1; },
    save() { throw new Error('disk full'); },
    log() {},
  };
  const handlers = toolHandlers(data);
  await assert.rejects(handlers.cancel_slot({ slot_id: 'slot_1' }), /disk full/);
  assert.equal(cfg.schedule.posts.length, 1);
  assert.equal(cfg.schedule.posts[0].id, 'slot_1');
  assert.equal(data.state.events.length, 1);
  assert.equal(data.state.events[0].id, 'evt_due');
  assert.equal(configWrites, 2);
});

await testAsync('dry-run does not consume the event or call the platform', async () => {
  const data = fakeData([commentEvent], [commentInbound]);
  let calls = 0;
  const social = { async reply() { calls += 1; return { id: 'r1' }; } };
  const out = await decideEvent({ data, social, event_id: 'evt_1', action: 'reply', text: 'hi', perform: false });
  assert.equal(out.dryRun, true);
  assert.equal(calls, 0);
  assert.equal(data.state.events.length, 1);
  assert.equal(data.state.history.length, 0);
  assert.equal(data.state.inbound[0].handled, false);
});

await testAsync('wrong kind/action is rejected before taking the event', async () => {
  const data = fakeData([commentEvent], [commentInbound]);
  await assert.rejects(
    decideEvent({ data, social: {}, event_id: 'evt_1', action: 'publish', text: 'x', perform: true }),
    /does not match comment event/
  );
  assert.equal(data.state.events.length, 1);
  assert.equal(data.state.inbound[0].handled, false);
});

await testAsync('a failed beginAttempt leaves no phantom inflight claim', async () => {
  const data = fakeData([commentEvent], [commentInbound]);
  data.beginAttempt = (event, meta) => {
    data.state.inflight[event.id] = { event, ...meta, at: new Date().toISOString(), status: 'sending' };
    throw new Error('disk full');
  };
  let calls = 0;
  const social = { async reply() { calls += 1; return { id: 'r1' }; } };
  await assert.rejects(
    decideEvent({ data, social, event_id: 'evt_1', action: 'reply', text: 'hi', perform: true }),
    /disk full/
  );
  assert.equal(calls, 0);
  assert.deepEqual(data.state.inflight, {});
  assert.equal(data.state.events.length, 1);
  assert.equal(data.state.events[0].id, 'evt_1');
  assert.equal(data.state.inbound[0].handled, false);
});

await testAsync('successful reply records history and marks the comment handled', async () => {
  const data = fakeData([commentEvent], [commentInbound]);
  let idempotencyKey;
  const social = {
    async reply(commentId, text, options) {
      assert.equal(commentId, 'c_1');
      assert.equal(text, 'hi');
      idempotencyKey = options.idempotencyKey;
      return { id: 'r1' };
    },
  };
  const out = await decideEvent({ data, social, event_id: 'evt_1', action: 'reply', text: 'hi', perform: true });
  assert.equal(out.performed, 'r1');
  assert.equal(idempotencyKey, 'evt_1');
  assert.equal(data.state.events.length, 0);
  assert.equal(data.state.history[0].performed, 'r1');
  assert.equal(data.state.inbound[0].handled, true);
  assert.deepEqual(data.state.inflight, {});
});

await testAsync('a definitive failure restores the same event and keeps it retryable', async () => {
  const data = fakeData([commentEvent], [commentInbound]);
  const failing = {
    async reply() {
      const err = new Error('bad request');
      err.definitive = true;
      throw err;
    },
  };
  await assert.rejects(
    decideEvent({ data, social: failing, event_id: 'evt_1', action: 'reply', text: 'hi', perform: true }),
    /Event evt_1 was kept/
  );
  assert.equal(data.state.events.length, 1);
  assert.equal(data.state.events[0].id, 'evt_1');
  assert.equal(data.state.events[0].lastAttempt.ambiguous, false);
  assert.equal(data.state.inbound[0].handled, false);
  assert.equal(data.state.history.length, 0);

  const succeeding = { async reply() { return { id: 'r2' }; } };
  const out = await decideEvent({ data, social: succeeding, event_id: 'evt_1', action: 'reply', text: 'hi', perform: true });
  assert.equal(out.performed, 'r2');
});

await testAsync('an ambiguous failure requires explicit retry=true', async () => {
  const data = fakeData([commentEvent], [commentInbound]);
  const failing = { async reply() { throw new Error('timeout'); } };
  await assert.rejects(
    decideEvent({ data, social: failing, event_id: 'evt_1', action: 'reply', text: 'hi', perform: true }),
    /may have succeeded/
  );
  assert.equal(data.state.events[0].lastAttempt.ambiguous, true);

  const succeeding = { async reply() { return { id: 'r3' }; } };
  await assert.rejects(
    decideEvent({ data, social: succeeding, event_id: 'evt_1', action: 'reply', text: 'hi', perform: true }),
    /ambiguous previous reply attempt/
  );
  assert.equal(data.state.events.length, 1);

  const out = await decideEvent({
    data,
    social: succeeding,
    event_id: 'evt_1',
    action: 'reply',
    text: 'hi',
    perform: true,
    retry: true,
  });
  assert.equal(out.performed, 'r3');
});

await testAsync('skip consumes the event without a send', async () => {
  const data = fakeData([commentEvent], [commentInbound]);
  let calls = 0;
  const social = { async reply() { calls += 1; return { id: 'nope' }; } };
  const out = await decideEvent({ data, social, event_id: 'evt_1', action: 'skip', reason: 'spam' });
  assert.equal(out.decided, 'skip');
  assert.equal(calls, 0);
  assert.equal(data.state.events.length, 0);
  assert.equal(data.state.history[0].action, 'skip');
  assert.equal(data.state.inbound[0].handled, true);
});

// ---------- engine re-raise ----------
function engineData(inbound) {
  const state = { ...emptyState(), inbound: structuredClone(inbound) };
  return {
    state,
    pushEvent(event) {
      state.events.push(event);
      return event;
    },
    nextId(prefix) {
      state.seq += 1;
      return `${prefix}_${state.seq}`;
    },
    log() {},
    save() {},
  };
}

await testAsync('an unhandled inbound comment is re-raised after a lost event', async () => {
  const data = engineData([{ id: 'c_lost', text: 'hello', handled: false }]);
  const social = {
    cfg: { platform: 'mock' },
    async comments() {
      return [{ id: 'c_lost', text: 'hello' }];
    },
  };
  const engine = startEngine({
    data,
    cfg: { schedule: { timezone: 'UTC', posts: [], pollSeconds: 60 } },
    social,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  clearInterval(engine.timer);
  assert.equal(data.state.events.filter((event) => event.commentId === 'c_lost').length, 1);
});

await testAsync('a handled inbound comment is not re-raised', async () => {
  const data = engineData([{ id: 'c_done', text: 'old', handled: true }]);
  const social = {
    cfg: { platform: 'mock' },
    async comments() {
      return [{ id: 'c_done', text: 'old' }];
    },
  };
  const engine = startEngine({
    data,
    cfg: { schedule: { timezone: 'UTC', posts: [], pollSeconds: 60 } },
    social,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  clearInterval(engine.timer);
  assert.equal(data.state.events.length, 0);
});

await testAsync('commentDone blocks a comment even after inbound was compacted', async () => {
  const data = engineData([]);
  data.state.commentDone.c_done = '2026-10-23T01:00:00.000Z';
  const social = {
    cfg: { platform: 'mock' },
    async comments() {
      return [{ id: 'c_done', text: 'old' }];
    },
  };
  const engine = startEngine({
    data,
    cfg: { schedule: { timezone: 'UTC', posts: [], pollSeconds: 60 } },
    social,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  clearInterval(engine.timer);
  assert.equal(data.state.events.length, 0);
});

await testAsync('slotDone blocks a cron occurrence even after history was compacted', async () => {
  const data = engineData([]);
  data.state.slotDone.slot_1 = '2999-01-01T00:00:00.000Z';
  const social = {
    cfg: { platform: 'mock' },
    async comments() {
      return [];
    },
  };
  const engine = startEngine({
    data,
    cfg: {
      schedule: {
        timezone: 'UTC',
        pollSeconds: 60,
        posts: [{ id: 'slot_1', brief: 'x', at: '2020-01-01T00:00:00.000Z', cron: '0 9 * * *' }],
      },
    },
    social,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  clearInterval(engine.timer);
  assert.equal(data.state.events.length, 0);
});

await testAsync('engine honors a per-slot timezone even when the global timezone differs', async () => {
  const data = engineData([]);
  const slot = {
    id: 'slot_tz',
    brief: 'x',
    at: '2020-01-01T00:00:00.000Z',
    cron: '0 9 * * *',
    timezone: 'Asia/Saigon',
  };
  const social = {
    cfg: { platform: 'mock' },
    async comments() {
      return [];
    },
  };
  const engine = startEngine({
    data,
    cfg: { schedule: { timezone: 'UTC', pollSeconds: 60, posts: [slot] } },
    social,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  clearInterval(engine.timer);
  const event = data.state.events.find((item) => item.slotId === 'slot_tz');
  assert.ok(event, 'due event exists');
  assert.equal(
    new Date(event.occurrence).toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Saigon' }),
    '09:00:00'
  );
});

// ---------- log rotation ----------
await testAsync('oversized log rotates to log.jsonl.1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-log-'));
  const oldData = process.env.SAM_DATA_DIR;
  const oldMax = process.env.SAM_LOG_MAX_BYTES;
  process.env.SAM_DATA_DIR = dir;
  process.env.SAM_LOG_MAX_BYTES = '200';
  try {
    const store = await import('../src/store.mjs');
    store.log({ type: 'test', message: 'x'.repeat(300) });
    store.log({ type: 'test', message: 'y'.repeat(300) });
    assert.ok(fs.existsSync(path.join(dir, 'log.jsonl.1')));
  } finally {
    if (oldData === undefined) delete process.env.SAM_DATA_DIR;
    else process.env.SAM_DATA_DIR = oldData;
    if (oldMax === undefined) delete process.env.SAM_LOG_MAX_BYTES;
    else process.env.SAM_LOG_MAX_BYTES = oldMax;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- lock ----------
test('single-instance lock rejects a second owner and can be released', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-lock-'));
  try {
    const release = acquireLock(dir);
    assert.throws(() => acquireLock(dir), /already running/);
    release();
    const releaseAgain = acquireLock(dir);
    releaseAgain();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(process.exitCode ? '\nSOME RELIABILITY TESTS FAILED' : '\nALL RELIABILITY TESTS PASSED');
