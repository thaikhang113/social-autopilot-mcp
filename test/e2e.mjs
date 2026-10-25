// End-to-end check. With no BASE it starts its own server on a random port
// with an isolated temp config/data dir, so `npm test` never touches your real
// state and never leaves scheduled slots behind.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { dueOccurrence } from '../src/engine.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const TOKEN = process.env.SAM_TOKEN && process.env.SAM_TOKEN !== 'CHANGE_ME' ? process.env.SAM_TOKEN : '';
const EXPLICIT_BASE = process.env.BASE;
let BASE = EXPLICIT_BASE;
let dataDir = process.env.SAM_DATA_DIR ? path.resolve(process.env.SAM_DATA_DIR) : path.join(ROOT, 'data');
let tmpDir = null;
let childServer = null;
let serverLog = '';

function cleanup() {
  try {
    childServer?.kill();
  } catch {}
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}
process.on('exit', cleanup);

async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function health() {
  try {
    return await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(800) });
  } catch {
    return null;
  }
}

if (!EXPLICIT_BASE) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-e2e-'));
  dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const port = await freePort();
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  cfg.port = port;
  cfg.token = 'CHANGE_ME'; // env SAM_TOKEN below is the only auth override
  // Never inherit a real adapter from the developer's config: e2e needs the
  // mock outbox/inbox and the local docs corpus.
  cfg.social = { kind: 'mock', platform: 'mock', url: '', token: '' };
  cfg.knowledge = { kind: 'file', dir: 'docs', url: '', token: '' };
  cfg.schedule = { timezone: 'UTC', posts: [], pollSeconds: 5 };
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  BASE = `http://127.0.0.1:${port}`;
  childServer = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SAM_DATA_DIR: dataDir,
      SAM_CONFIG_FILE: cfgPath,
      SAM_PORT: String(port),
      ...(TOKEN ? { SAM_TOKEN: TOKEN } : {}),
    },
  });
  childServer.stdout.on('data', (chunk) => {
    serverLog += chunk;
  });
  childServer.stderr.on('data', (chunk) => {
    serverLog += chunk;
  });
}

// Wait for a server, whether it is the one we just spawned or an external BASE.
let up = false;
for (let i = 0; i < 50; i += 1) {
  const res = await health();
  if (res?.ok) {
    up = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!up) {
  console.error(`Server at ${BASE} did not become healthy.`);
  if (serverLog) console.error(serverLog.slice(-2000));
  process.exit(1);
}

const headers = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
};

let id = 0;
async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const text = await res.text();
  const json = text.trim().startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('data: ')[1]);
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

// JSON-RPC notification: no id, no response body.
async function notify(method, params) {
  await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method, params }),
  });
}

async function callTool(name, args) {
  return await rpc('tools/call', { name, arguments: args });
}

async function toolError(name, args) {
  const result = await callTool(name, args);
  return result.isError ? result.content.map((part) => part.text).join(' ') : null;
}

async function waitForEvent(predicate, tries = 30) {
  for (let i = 0; i < tries; i += 1) {
    const pending = (await callTool('list_pending_events', {})).structuredContent.events;
    const event = pending.find(predicate);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

const ok = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
};

await rpc('initialize', {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'e2e', version: '0.0.1' },
});
await notify('notifications/initialized');

const { tools } = await rpc('tools/list');
const names = tools.map((tool) => tool.name);
ok(
  'tools/list',
  ['list_pending_events', 'decide', 'verify_facts', 'schedule_post', 'cancel_slot', 'recent_activity'].every((name) => names.includes(name)),
  names.join(',')
);

// 1. grounding
const vf = (
  await callTool('verify_facts', {
    query: 'giấy phép mã nguồn mở',
    draft: 'Dự án Social Autopilot MCP hoàn toàn là mã nguồn mở phát hành miễn phí theo giấy phép MIT License',
  })
).structuredContent;
ok('verify_facts supports true claim', vf.supported === true, `sources=${vf.sources.map((s) => s.title).join(',')}`);

const vfBad = (
  await callTool('verify_facts', {
    query: 'giấy phép mã nguồn mở',
    draft: 'Dự án yêu cầu mua bản quyền máy chủ phần cứng chuyên dụng',
  })
).structuredContent;
ok('verify_facts rejects invented price', vfBad.supported === false);

const vfNegated = (
  await callTool('verify_facts', {
    query: 'giấy phép mã nguồn mở bảng giá',
    draft: 'Dự án không phải là mã nguồn mở và có bảng giá dịch vụ thương mại',
  })
).structuredContent;
ok('verify_facts rejects negated claim', vfNegated.supported === false, vfNegated.reason);

// 2. seed two comments: one reply, one skip. This also exercises the skip
// branch on a fresh run instead of skipping the test when no event exists.
const inboxPath = path.join(dataDir, 'inbox.json');
const stamp = Date.now();
const testCommentId = `c_e2e_reply_${stamp}`;
const skipCommentId = `c_e2e_skip_${stamp}`;
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  inboxPath,
  JSON.stringify(
    [
      {
        id: testCommentId,
        author: 'Lập trình viên',
        text: 'Dự án Social Autopilot MCP là mã nguồn mở phải không?',
        at: new Date().toISOString(),
      },
      {
        id: skipCommentId,
        author: 'Spam Bot',
        text: 'Mua follow giá rẻ tại đây!',
        at: new Date().toISOString(),
      },
    ],
    null,
    2
  )
);

const commentEv = await waitForEvent((event) => event.commentId === testCommentId);
ok('poller surfaced a comment', !!commentEv, commentEv?.summary);
ok('comment text is intact UTF-8', commentEv?.text?.includes('mã nguồn mở'), commentEv?.text);

// 3. schedule a due post, preview it (must stay pending), then publish it.
const post = '🚀 Social Autopilot MCP là dự án mã nguồn mở kết nối AI với mạng xã hội.';
const slot = (
  await callTool('schedule_post', {
    brief: 'bài đăng giới thiệu mã nguồn mở',
    at: new Date(Date.now() - 60_000).toISOString(),
  })
).structuredContent;
ok('schedule_post', !!slot.slotId, slot.slotId);

const due = await waitForEvent((event) => event.kind === 'post_due' && event.slotId === slot.slotId);
ok('scheduled slot produced a due event', !!due);
if (!due) process.exit(1);

const preview = (
  await callTool('decide', {
    event_id: due.id,
    action: 'publish',
    text: post,
    perform: false,
  })
).structuredContent;
ok('decide perform=false is a dry run', preview.dryRun === true && preview.performed === undefined);
const stillPending = (await callTool('list_pending_events', {})).structuredContent.events.some((event) => event.id === due.id);
ok('dry run keeps the event pending', stillPending);

const pub = (
  await callTool('decide', { event_id: due.id, action: 'publish', text: post, perform: true })
).structuredContent;
ok('decide+publish sent', !!pub.performed, pub.performed);

// 4. wrong action for a comment must be rejected without consuming the event.
const wrongKind = await toolError('decide', {
  event_id: commentEv.id,
  action: 'publish',
  text: 'not a post',
  perform: true,
});
ok('wrong kind/action rejected', !!wrongKind, wrongKind?.slice(0, 80));
const commentStillPending = (await callTool('list_pending_events', {})).structuredContent.events.some(
  (event) => event.id === commentEv.id
);
ok('wrong kind does not consume the comment', commentStillPending);

// 5. reply to the comment with grounded text
const reply = (
  await callTool('decide', {
    event_id: commentEv.id,
    action: 'reply',
    text: 'Dạ vâng, dự án hoàn toàn là mã nguồn mở miễn phí theo giấy phép MIT ạ.',
    perform: true,
  })
).structuredContent;
ok('decide+reply sent', !!reply.performed, reply.performed);

// 6. skip the second comment = no send, always exercised.
const skipEv = await waitForEvent((event) => event.commentId === skipCommentId);
ok('poller surfaced the skip comment', !!skipEv);
if (skipEv) {
  const skipped = (
    await callTool('decide', { event_id: skipEv.id, action: 'skip', reason: 'spam' })
  ).structuredContent;
  ok('skip does not publish', skipped.performed === undefined);
}

// 7. cron recurrence: a daily slot anchored 3 days back fires ONCE for the most
// recent occurrence (missed runs collapse), and publishing it does not raise the
// same occurrence again.
const DAY = 864e5;
const anchor = new Date(Date.now() - 3 * DAY).toISOString();
const rslot = (
  await callTool('schedule_post', {
    brief: 'bài định kỳ',
    cron: '0 9 * * *',
    at: anchor,
    timezone: 'Asia/Saigon',
  })
).structuredContent;
const rdue = await waitForEvent((event) => event.slotId === rslot.slotId);
ok('cron slot fired', !!rdue, rdue?.occurrence);
if (rdue) {
  ok('cron occurrence is the latest run, not the anchor', new Date(rdue.occurrence) > new Date(anchor));
  ok(
    'cron occurrence sits at 09:00 Asia/Saigon',
    new Date(rdue.occurrence).toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Saigon' }) === '09:00:00',
    rdue.occurrence
  );
  ok(
    'missed cron runs collapsed into one event',
    rdue.occurrence === dueOccurrence({ at: anchor, cron: '0 9 * * *' }, Date.now(), 'Asia/Saigon')
  );
  const occ = rdue.occurrence;
  await callTool('decide', { event_id: rdue.id, action: 'publish', text: 'Bài định kỳ hôm nay.', perform: true });
  const again = (await callTool('list_pending_events', {})).structuredContent.events.filter(
    (event) => event.slotId === rslot.slotId && event.occurrence === occ
  );
  ok('same occurrence is not raised twice', again.length === 0);
}

// 8. malformed cron/timezone must fail at write time, not silently never fire.
const badCron = await toolError('schedule_post', {
  brief: 'x',
  cron: '0 25 * * *',
  at: new Date().toISOString(),
});
ok('invalid cron rejected', !!badCron, badCron?.slice(0, 60));

const sixField = await toolError('schedule_post', {
  brief: 'x',
  cron: '30 9 * * * *',
  at: new Date().toISOString(),
});
ok('6-field cron rejected', !!sixField, sixField?.slice(0, 60));

const badTz = await toolError('schedule_post', {
  brief: 'x',
  cron: '0 9 * * *',
  timezone: 'Not/AZone',
});
ok('invalid timezone rejected', !!badTz, badTz?.slice(0, 60));

// 9. duplicate schedule dedupe + cancel.
const futureAt = new Date(Date.now() + 3600_000).toISOString();
const future = (
  await callTool('schedule_post', { brief: 'slot sẽ huỷ', at: futureAt, timezone: 'Asia/Saigon' })
).structuredContent;
const duplicate = (
  await callTool('schedule_post', { brief: 'slot sẽ huỷ', at: futureAt, timezone: 'Asia/Saigon' })
).structuredContent;
ok('identical schedule is deduped', duplicate.deduped === true && duplicate.slotId === future.slotId);
const cancelled = (await callTool('cancel_slot', { slot_id: future.slotId })).structuredContent;
ok('cancel_slot removes the slot', cancelled.removed === true);

const pendingSlot = (
  await callTool('schedule_post', { brief: 'slot đang chờ', at: new Date(Date.now() - 60_000).toISOString() })
).structuredContent;
const pendingDue = await waitForEvent((event) => event.slotId === pendingSlot.slotId);
const cancelledPending = (await callTool('cancel_slot', { slot_id: pendingSlot.slotId })).structuredContent;
ok(
  'cancel_slot removes its pending due event',
  !!pendingDue && cancelledPending.pendingRemoved === 1
);

// 10. audit trail
const recent = (await callTool('recent_activity', {})).structuredContent.decisions;
ok('recent_activity has history', recent.length >= 2, recent.map((entry) => `${entry.kind}:${entry.action}`).join(','));

// 11. auth behavior is tested on every run, including the auth-disabled case.
const bare = await fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/list' }),
});
if (TOKEN) {
  ok('auth rejects request without token', bare.status === 401, `status=${bare.status}`);
} else {
  ok('auth disabled accepts a bare request', bare.status !== 401, `status=${bare.status}`);
}

// 12. CORS & OPTIONS preflight check
const opt = await fetch(`${BASE}/mcp`, { method: 'OPTIONS' });
ok('CORS OPTIONS returns 204', opt.status === 204, `status=${opt.status}`);
ok(
  'CORS Allow-Origin header present',
  opt.headers.get('access-control-allow-origin') === '*',
  `origin=${opt.headers.get('access-control-allow-origin')}`
);

// 13. server still healthy after all that
const healthBody = await (await fetch(`${BASE}/health`)).json();
ok('server healthy', healthBody.ok === true, `pending=${healthBody.pending ?? 'hidden'}`);

cleanup();
console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL PASSED');
