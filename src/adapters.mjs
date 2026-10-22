// Adapters are the ONLY place that talks to a real platform / knowledge base.
// Swap `kind` in config.json: "mock" (local demo) or "http" (your own bridge).
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

async function post(url, body, token) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function fb(endpoint, token, opts = {}) {
  const version = opts.version ?? 'v21.0';
  const url = `https://graph.facebook.com/${version}/${endpoint}`;
  const isPost = opts.method === 'POST';
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(isPost ? { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' } : {}),
    },
    ...(isPost && opts.body ? { body: new URLSearchParams(opts.body).toString() } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Facebook API ${endpoint} -> ${res.status}: ${data.error?.message ?? JSON.stringify(data)}`);
  return data;
}

// ---------- social adapter ----------
// Contract for kind:"http": POST {op, ...} to SOCIAL_URL
//   {op:'publish', text, media?}      -> {id}
//   {op:'reply', comment_id, text}    -> {id}
//   {op:'comments', since?}           -> {comments:[{id, author, text, post_id, at}]}
export class Social {
  constructor(data, cfg) {
    this.data = data;
    this.cfg = { ...(cfg.social ?? { kind: 'mock' }) };
    if (this.cfg.kind === 'mock' && (process.env.FB_PAGE_ACCESS_TOKEN || process.env.FB_PAGE_ID)) {
      this.cfg.kind = 'facebook';
    }
  }

  async publish(text, media = []) {
    if (this.cfg.kind === 'http') return post(this.cfg.url, { op: 'publish', text, media }, this.cfg.token);
    if (this.cfg.kind === 'facebook') {
      const pageId = this.cfg.pageId ?? process.env.FB_PAGE_ID;
      const token = this.cfg.pageAccessToken ?? this.cfg.token ?? process.env.FB_PAGE_ACCESS_TOKEN;
      if (!pageId || !token) throw new Error('Facebook adapter requires pageId and pageAccessToken (or FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN)');
      // ponytail: text-only posts; upgrade to multi-media attachments or /photos endpoint when media[] is passed
      const r = await fb(`${pageId}/feed`, token, { method: 'POST', body: { message: text }, version: this.cfg.apiVersion });
      return { id: r.id };
    }
    const item = { id: `post_${Date.now()}`, text, media, at: new Date().toISOString(), platform: this.cfg.platform ?? 'mock' };
    this.data.state.outbox.push({ type: 'publish', ...item });
    this.data.save();
    return { id: item.id };
  }

  async reply(commentId, text) {
    if (this.cfg.kind === 'http') return post(this.cfg.url, { op: 'reply', comment_id: commentId, text }, this.cfg.token);
    if (this.cfg.kind === 'facebook') {
      const token = this.cfg.pageAccessToken ?? this.cfg.token ?? process.env.FB_PAGE_ACCESS_TOKEN;
      if (!token) throw new Error('Facebook adapter requires pageAccessToken (or FB_PAGE_ACCESS_TOKEN)');
      const r = await fb(`${commentId}/comments`, token, { method: 'POST', body: { message: text }, version: this.cfg.apiVersion });
      return { id: r.id };
    }
    const item = { id: `reply_${Date.now()}`, comment_id: commentId, text, at: new Date().toISOString() };
    this.data.state.outbox.push({ type: 'reply', ...item });
    this.data.save();
    return { id: item.id };
  }

  async comments(since) {
    if (this.cfg.kind === 'http') {
      const r = await post(this.cfg.url, { op: 'comments', since }, this.cfg.token);
      return r.comments ?? [];
    }
    if (this.cfg.kind === 'facebook') {
      const pageId = this.cfg.pageId ?? process.env.FB_PAGE_ID;
      const token = this.cfg.pageAccessToken ?? this.cfg.token ?? process.env.FB_PAGE_ACCESS_TOKEN;
      if (!pageId || !token) return [];
      // ponytail: polls first page of feed comments & nested replies; upgrade to Meta Webhooks for real-time push
      const sinceParam = since ? `&since=${Math.floor(new Date(since).getTime() / 1000)}` : '';
      const r = await fb(
        `${pageId}/feed?fields=comments{id,from,message,created_time,comments{id,from,message,created_time}}${sinceParam}`,
        token,
        { version: this.cfg.apiVersion }
      );
      const out = [];
      const collect = (list, postId) => {
        for (const c of list ?? []) {
          if (pageId && c.from?.id === pageId) continue;
          out.push({
            id: c.id,
            author: c.from?.name ?? 'Facebook User',
            text: c.message || '[Sticker/Hình ảnh]',
            post_id: postId,
            at: c.created_time,
          });
          if (c.comments?.data) collect(c.comments.data, postId);
        }
      };
      for (const p of r.data ?? []) {
        collect(p.comments?.data, p.id);
      }
      return out;
    }
    // mock: the "platform" pushes new comments into data/inbox.json (this is the
    // stand-in for a real webhook/inbox API). Append to it to simulate traffic.
    const inbox = path.join(ROOT, 'data', 'inbox.json');
    let file = [];
    try {
      file = fs.existsSync(inbox) ? JSON.parse(fs.readFileSync(inbox, 'utf8')) : [];
    } catch {
      file = []; // half-written by an external writer: retry next tick
    }
    const seen = new Set(this.data.state.inbound.map((c) => c.id));
    return [...file.filter((c) => !seen.has(c.id)), ...this.data.state.inbound.filter((c) => !c.handled)];
  }
}

// ---------- knowledge adapter (NotebookLM / your docs) ----------
// Contract for kind:"http": POST KNOWLEDGE_URL {query} -> {answer, sources:[{title,url?}]}
export class Knowledge {
  constructor(cfg) {
    this.cfg = cfg.knowledge ?? { kind: 'file', dir: 'docs' };
  }

  async search(query) {
    if (this.cfg.kind === 'http') return post(this.cfg.url, { query }, this.cfg.token);
    // file kind: naive grounding over docs/*.md so replies stop hallucinating
    const dir = path.resolve(ROOT, this.cfg.dir ?? 'docs');
    if (!fs.existsSync(dir)) return { answer: '', sources: [] };
    const terms = String(query).toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const hits = [];
    for (const f of fs.readdirSync(dir).filter((f) => /\.(md|txt|json)$/i.test(f))) {
      const body = fs.readFileSync(path.join(dir, f), 'utf8');
      const lines = body.split('\n');
      for (const line of lines) {
        const low = line.toLowerCase();
        const score = terms.reduce((n, t) => n + (low.includes(t) ? 1 : 0), 0);
        if (score > 0) hits.push({ score, text: line.trim(), source: f });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, 8);
    return {
      answer: top.map((h) => h.text).join('\n'),
      sources: [...new Set(top.map((h) => h.source))].map((title) => ({ title })),
      matched: top.length,
    };
  }
}
