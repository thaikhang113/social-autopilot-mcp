// End-to-end check against an already-running server (node src/server.mjs).
// Runs in Node so Vietnamese text is never mangled by a shell.
import fs from 'node:fs';
import path from 'node:path';
import { dueOccurrence } from '../src/engine.mjs';
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const TOKEN = process.env.SAM_TOKEN ?? '';
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
const names = tools.map((t) => t.name);
ok('tools/list', ['list_pending_events', 'decide', 'verify_facts', 'schedule_post', 'recent_activity'].every((n) => names.includes(n)), names.join(','));

// 1. grounding
const vf = (await rpc('tools/call', { name: 'verify_facts', arguments: { query: 'giấy phép mã nguồn mở', draft: 'Dự án Social Autopilot MCP hoàn toàn là mã nguồn mở phát hành miễn phí theo giấy phép MIT License' } })).structuredContent;
ok('verify_facts supports true claim', vf.supported === true, `sources=${vf.sources.map((s) => s.title).join(',')}`);

const vfBad = (await rpc('tools/call', { name: 'verify_facts', arguments: { query: 'giấy phép mã nguồn mở', draft: 'Dự án yêu cầu mua bản quyền máy chủ phần cứng chuyên dụng' } })).structuredContent;
ok('verify_facts rejects invented price', vfBad.supported === false);

// 2. ensure a fresh comment is seeded in data/inbox.json
const inboxPath = path.resolve(import.meta.dirname, '..', 'data', 'inbox.json');
const testCommentId = `c_e2e_${Date.now()}`;
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
    ],
    null,
    2
  )
);

const pending = (await rpc('tools/call', { name: 'list_pending_events', arguments: {} })).structuredContent.events;
const commentEv = pending.find((e) => e.kind === 'comment');
ok('poller surfaced a comment', !!commentEv, commentEv?.summary);
ok('comment text is intact UTF-8', commentEv?.text?.includes('mã nguồn mở'), commentEv?.text);

// 3. publish a post with Vietnamese content, check it round-trips unchanged
const post = '🚀 Social Autopilot MCP là dự án mã nguồn mở kết nối AI với mạng xã hội.';
const slot = (await rpc('tools/call', { name: 'schedule_post', arguments: { brief: 'bài đăng giới thiệu mã nguồn mở', at: new Date(Date.now() - 60_000).toISOString() } })).structuredContent;
ok('schedule_post', !!slot.slotId, slot.slotId);

// The engine may surface the due slot on its next tick; poll briefly instead of
// assuming the poll interval already elapsed.
const due = await (async () => {
  for (let i = 0; i < 20; i++) {
    const ev = (await rpc('tools/call', { name: 'list_pending_events', arguments: {} })).structuredContent.events.find((e) => e.kind === 'post_due');
    if (ev) return ev;
    await new Promise((r) => setTimeout(r, 250));
  }
  return undefined;
})();
ok('scheduled slot produced a due event', !!due);
if (!due) process.exit(1);
const pub = (await rpc('tools/call', { name: 'decide', arguments: { event_id: due.id, action: 'publish', text: post, perform: true } })).structuredContent;
ok('decide+publish sent', !!pub.performed, pub.performed);

// 4. reply to the comment with grounded text
const reply = (await rpc('tools/call', { name: 'decide', arguments: { event_id: commentEv.id, action: 'reply', text: 'Dạ vâng, dự án hoàn toàn là mã nguồn mở miễn phí theo giấy phép MIT ạ.', perform: true } })).structuredContent;
ok('decide+reply sent', !!reply.performed, reply.performed);

// 5. skip a comment = no send
const skipEv = (await rpc('tools/call', { name: 'list_pending_events', arguments: {} })).structuredContent.events.find((e) => e.kind === 'comment');
if (skipEv) {
  const sk = (await rpc('tools/call', { name: 'decide', arguments: { event_id: skipEv.id, action: 'skip', reason: 'spam' } })).structuredContent;
  ok('skip does not publish', sk.performed === undefined);
}

// 6. cron recurrence: a daily slot anchored 3 days back fires ONCE for the most
// recent occurrence (missed runs collapse), and publishing it does not raise the
// same occurrence again.
const DAY = 864e5;
const anchor = new Date(Date.now() - 3 * DAY).toISOString();
const rslot = (
  await rpc('tools/call', {
    name: 'schedule_post',
    arguments: { brief: 'bài định kỳ', cron: '0 9 * * *', at: anchor, timezone: 'Asia/Saigon' },
  })
).structuredContent;
const rdue = (await rpc('tools/call', { name: 'list_pending_events', arguments: {} })).structuredContent.events.find(
  (e) => e.slotId === rslot.slotId
);
ok('cron slot fired', !!rdue, rdue?.occurrence);
ok('cron occurrence is the latest run, not the anchor', new Date(rdue.occurrence) > new Date(anchor));
ok(
  'cron occurrence sits at 09:00 Asia/Saigon',
  new Date(rdue.occurrence).toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Saigon' }) === '09:00:00',
  rdue.occurrence
);
ok('missed cron runs collapsed into one event', rdue.occurrence === dueOccurrence({ at: anchor, cron: '0 9 * * *' }, Date.now(), 'Asia/Saigon'));
const occ = rdue.occurrence;
await rpc('tools/call', { name: 'decide', arguments: { event_id: rdue.id, action: 'publish', text: 'Bài định kỳ hôm nay.', perform: true } });
const again = (await rpc('tools/call', { name: 'list_pending_events', arguments: {} })).structuredContent.events.filter(
  (e) => e.slotId === rslot.slotId && e.occurrence === occ
);
ok('same occurrence is not raised twice', again.length === 0);

// 6b. a malformed cron must fail at write time, not silently never fire.
// A thrown tool error surfaces as result.isError, not as a JSON-RPC error.
const toolError = async (args) => {
  const r = await rpc('tools/call', { name: 'schedule_post', arguments: args });
  return r.isError ? r.content.map((c) => c.text).join(' ') : null;
};
const badCron = await toolError({ brief: 'x', cron: '0 25 * * *', at: new Date().toISOString() });
ok('invalid cron rejected', !!badCron, badCron?.slice(0, 60));

// 6c. six-field cron (seconds) is rejected: this server is minute-granular.
const sixField = await toolError({ brief: 'x', cron: '30 9 * * * *', at: new Date().toISOString() });
ok('6-field cron rejected', !!sixField, sixField?.slice(0, 60));

// 7. audit trail
const recent = (await rpc('tools/call', { name: 'recent_activity', arguments: {} })).structuredContent.decisions;
ok('recent_activity has history', recent.length >= 2, recent.map((r) => `${r.kind}:${r.action}`).join(','));

// 7. auth: when a token is configured, /mcp must reject a bare request.
if (TOKEN) {
  const bare = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/list' }),
  });
  ok('auth rejects request without token', bare.status === 401, `status=${bare.status}`);
}

// 7b. CORS & OPTIONS preflight check
const opt = await fetch(`${BASE}/mcp`, { method: 'OPTIONS' });
ok('CORS OPTIONS returns 204', opt.status === 204, `status=${opt.status}`);
ok('CORS Allow-Origin header present', opt.headers.get('access-control-allow-origin') === '*', `origin=${opt.headers.get('access-control-allow-origin')}`);

// 8. server still healthy after all that
const health = await (await fetch(`${BASE}/health`)).json();
ok('server healthy', health.ok === true, `pending=${health.pending}`);

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL PASSED');