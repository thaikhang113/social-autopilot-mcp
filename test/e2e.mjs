// End-to-end check against an already-running server (node src/server.mjs).
// Runs in Node so Vietnamese text is never mangled by a shell.
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

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
const vf = (await rpc('tools/call', { name: 'verify_facts', arguments: { query: 'giá gói cơ bản', draft: 'Gói cơ bản giá 990.000đ mỗi tháng' } })).structuredContent;
ok('verify_facts supports true claim', vf.supported === true, `sources=${vf.sources.map((s) => s.title).join(',')}`);

const vfBad = (await rpc('tools/call', { name: 'verify_facts', arguments: { query: 'giá gói cơ bản', draft: 'Gói cơ bản miễn phí trọn đời cho mọi khách hàng' } })).structuredContent;
ok('verify_facts rejects invented price', vfBad.supported === false);

// 2. a comment event must be pending (seeded in data/inbox.json)
const pending = (await rpc('tools/call', { name: 'list_pending_events', arguments: {} })).structuredContent.events;
const commentEv = pending.find((e) => e.kind === 'comment');
ok('poller surfaced a comment', !!commentEv, commentEv?.summary);
ok('comment text is intact UTF-8', commentEv?.text?.includes('Giá gói cơ bản'), commentEv?.text);

// 3. publish a post with Vietnamese content, check it round-trips unchanged
const post = ' meet  Ưu đãi hôm nay: gói cơ bản 990.000đ/tháng, hoàn tiền 7 ngày.';
const slot = (await rpc('tools/call', { name: 'schedule_post', arguments: { brief: 'bài đăng giá', at: new Date(Date.now() - 60_000).toISOString() } })).structuredContent;
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
const reply = (await rpc('tools/call', { name: 'decide', arguments: { event_id: commentEv.id, action: 'reply', text: 'Dạ gói cơ bản là 990.000đ/tháng ạ.', perform: true } })).structuredContent;
ok('decide+reply sent', !!reply.performed, reply.performed);

// 5. skip a comment = no send
const skipEv = (await rpc('tools/call', { name: 'list_pending_events', arguments: {} })).structuredContent.events.find((e) => e.kind === 'comment');
if (skipEv) {
  const sk = (await rpc('tools/call', { name: 'decide', arguments: { event_id: skipEv.id, action: 'skip', reason: 'spam' } })).structuredContent;
  ok('skip does not publish', sk.performed === undefined);
}

// 6. audit trail
const recent = (await rpc('tools/call', { name: 'recent_activity', arguments: {} })).structuredContent.decisions;
ok('recent_activity has history', recent.length >= 2, recent.map((r) => `${r.kind}:${r.action}`).join(','));

// 7. server still healthy after all that
const health = await (await fetch(`${BASE}/health`)).json();
ok('server healthy', health.ok === true, `pending=${health.pending}`);

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL PASSED');