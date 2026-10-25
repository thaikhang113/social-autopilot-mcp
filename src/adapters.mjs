// Adapters are the ONLY place that talks to a real platform / knowledge base.
// Swap `kind` in config.json: "mock" (local demo) or "http" (your own bridge).
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = process.env.SAM_DATA_DIR
  ? path.resolve(process.env.SAM_DATA_DIR)
  : path.join(ROOT, 'data');

function httpTimeout() {
  const value = Number(process.env.SAM_HTTP_TIMEOUT_MS ?? 15_000);
  return Number.isFinite(value) && value > 0 ? value : 15_000;
}

async function post(url, body, token, options = {}) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    accept: 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(httpTimeout()),
  });
  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (res.ok) throw new Error(`${url} -> invalid JSON response: ${text.slice(0, 120)}`);
    }
  }
  if (!res.ok) {
    const err = new Error(`${url} -> ${res.status} ${text.slice(0, 300)}`);
    err.status = res.status;
    err.definitive = res.status >= 400 && res.status < 500;
    throw err;
  }
  if (data?.error) {
    const message = data.error.message ?? JSON.stringify(data.error);
    const err = new Error(`${url} -> API error: ${message}`);
    err.definitive = false;
    throw err;
  }
  return data;
}

async function fb(endpoint, token, opts = {}) {
  const version = opts.version ?? 'v21.0';
  const url = /^https?:\/\//i.test(endpoint) ? endpoint : `https://graph.facebook.com/${version}/${endpoint}`;
  const isPost = opts.method === 'POST';
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(isPost ? { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' } : {}),
    },
    ...(isPost && opts.body ? { body: new URLSearchParams(opts.body).toString() } : {}),
    signal: AbortSignal.timeout(httpTimeout()),
  });
  const data = await res.json().catch(() => ({}));
  // Graph API can return HTTP 200 with {error:{...}}; treating that as success
  // produced ids of undefined and lost the post.
  if (!res.ok || data?.error) {
    const message = data?.error?.message ?? JSON.stringify(data);
    const err = new Error(`Facebook API ${endpoint} -> ${res.status}: ${message}`);
    err.status = res.status;
    err.definitive = !data?.error && res.status >= 400 && res.status < 500;
    throw err;
  }
  return data;
}

// ---------- social adapter ----------
// Contract for kind:"http": POST {op, ...} to SOCIAL_URL
//   {op:'publish', text, media?, idempotency_key?}  -> {id}
//   {op:'reply', comment_id, text, idempotency_key?} -> {id}
//   {op:'comments', since?}                         -> {comments:[{id, author, text, post_id, at}]}
export class Social {
  constructor(data, cfg) {
    this.data = data;
    this.cfg = { ...(cfg.social ?? { kind: 'mock' }) };
    if (this.cfg.kind === 'mock' && (process.env.FB_PAGE_ACCESS_TOKEN || process.env.FB_PAGE_ID)) {
      this.cfg.kind = 'facebook';
    }
  }

  async publish(text, media = [], options = {}) {
    if (this.cfg.kind === 'http') {
      return post(
        this.cfg.url,
        { op: 'publish', text, media, ...(options.idempotencyKey ? { idempotency_key: options.idempotencyKey } : {}) },
        this.cfg.token,
        options
      );
    }
    if (this.cfg.kind === 'facebook') {
      const pageId = this.cfg.pageId ?? process.env.FB_PAGE_ID;
      const token = this.cfg.pageAccessToken ?? this.cfg.token ?? process.env.FB_PAGE_ACCESS_TOKEN;
      if (!pageId || !token) throw new Error('Facebook adapter requires pageId and pageAccessToken (or FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN)');
      if (Array.isArray(media) && media.length > 0) {
        throw new Error('Facebook adapter is text-only; media[] is not supported yet');
      }
      const result = await fb(`${pageId}/feed`, token, {
        method: 'POST',
        body: { message: text },
        version: this.cfg.apiVersion,
      });
      if (!result.id) {
        const err = new Error('Facebook publish returned no id');
        err.definitive = false;
        throw err;
      }
      return { id: result.id };
    }
    if (options.idempotencyKey) {
      const existing = this.data.state.outbox.find((item) => item.idempotency_key === options.idempotencyKey);
      if (existing) return { id: existing.id, deduped: true };
    }
    const item = {
      id: `post_${Date.now()}`,
      text,
      media,
      at: new Date().toISOString(),
      platform: this.cfg.platform ?? 'mock',
      ...(options.idempotencyKey ? { idempotency_key: options.idempotencyKey } : {}),
    };
    this.data.state.outbox.push({ type: 'publish', ...item });
    this.data.save();
    return { id: item.id };
  }

  async reply(commentId, text, options = {}) {
    if (this.cfg.kind === 'http') {
      return post(
        this.cfg.url,
        { op: 'reply', comment_id: commentId, text, ...(options.idempotencyKey ? { idempotency_key: options.idempotencyKey } : {}) },
        this.cfg.token,
        options
      );
    }
    if (this.cfg.kind === 'facebook') {
      const token = this.cfg.pageAccessToken ?? this.cfg.token ?? process.env.FB_PAGE_ACCESS_TOKEN;
      if (!token) throw new Error('Facebook adapter requires pageAccessToken (or FB_PAGE_ACCESS_TOKEN)');
      const result = await fb(`${commentId}/comments`, token, {
        method: 'POST',
        body: { message: text },
        version: this.cfg.apiVersion,
      });
      if (!result.id) {
        const err = new Error('Facebook reply returned no id');
        err.definitive = false;
        throw err;
      }
      return { id: result.id };
    }
    if (options.idempotencyKey) {
      const existing = this.data.state.outbox.find((item) => item.idempotency_key === options.idempotencyKey && item.type === 'reply');
      if (existing) return { id: existing.id, deduped: true };
    }
    const item = {
      id: `reply_${Date.now()}`,
      comment_id: commentId,
      text,
      at: new Date().toISOString(),
      ...(options.idempotencyKey ? { idempotency_key: options.idempotencyKey } : {}),
    };
    this.data.state.outbox.push({ type: 'reply', ...item });
    this.data.save();
    return { id: item.id };
  }

  async comments(since) {
    if (this.cfg.kind === 'http') {
      const result = await post(this.cfg.url, { op: 'comments', since }, this.cfg.token);
      const fromApi = result.comments ?? [];
      return this.#withUnhandled(fromApi);
    }
    if (this.cfg.kind === 'facebook') {
      const pageId = this.cfg.pageId ?? process.env.FB_PAGE_ID;
      const token = this.cfg.pageAccessToken ?? this.cfg.token ?? process.env.FB_PAGE_ACCESS_TOKEN;
      if (!pageId || !token) return this.#withUnhandled([]);
      const sinceMs = since ? Date.parse(since) : 0;
      const maxPages = Math.max(1, Number(this.cfg.maxFeedPages ?? 5));
      const out = [];
      const collect = (list, postId) => {
        for (const comment of list ?? []) {
          if (pageId && comment.from?.id === pageId) continue;
          if (Number.isFinite(sinceMs) && sinceMs > 0 && comment.created_time) {
            const created = Date.parse(comment.created_time);
            if (Number.isFinite(created) && created < sinceMs) continue;
          }
          out.push({
            id: comment.id,
            author: comment.from?.name ?? 'Facebook User',
            text: comment.message || '[Sticker/Hình ảnh]',
            post_id: postId,
            at: comment.created_time,
          });
          if (comment.comments?.data) collect(comment.comments.data, postId);
        }
      };
      let next = `${pageId}/feed?fields=comments.limit(100){id,from,message,created_time,comments.limit(100){id,from,message,created_time}}&limit=100`;
      for (let page = 0; next && page < maxPages; page += 1) {
        const result = await fb(next, token, { version: this.cfg.apiVersion });
        for (const post of result.data ?? []) collect(post.comments?.data, post.id);
        next = result.paging?.next;
      }
      return this.#withUnhandled(out);
    }
    // mock: the "platform" pushes new comments into data/inbox.json (this is the
    // stand-in for a real webhook/inbox API). Append to it to simulate traffic.
    const inbox = path.join(DATA_DIR, 'inbox.json');
    let file = [];
    try {
      file = fs.existsSync(inbox) ? JSON.parse(fs.readFileSync(inbox, 'utf8')) : [];
    } catch {
      file = []; // half-written by an external writer: retry next tick
    }
    const seen = new Set(this.data.state.inbound.map((comment) => comment.id));
    return [...file.filter((comment) => !seen.has(comment.id)), ...this.data.state.inbound.filter((comment) => !comment.handled)];
  }

  #withUnhandled(fromApi) {
    const seen = new Set((fromApi ?? []).map((comment) => comment.id));
    const pending = (this.data.state.inbound ?? []).filter((comment) => !comment.handled && !seen.has(comment.id));
    return [...(fromApi ?? []), ...pending];
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
    const terms = String(query).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((word) => word.length >= 2);
    const hits = [];
    for (const file of fs.readdirSync(dir).filter((name) => /\.(md|txt|json)$/i.test(name))) {
      const body = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const line of body.split('\n')) {
        const low = line.toLowerCase();
        const score = terms.reduce((count, term) => count + (low.includes(term) ? 1 : 0), 0);
        if (score > 0) hits.push({ score, text: line.trim(), source: file });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, 8);
    return {
      answer: top.map((hit) => hit.text).join('\n'),
      sources: [...new Set(top.map((hit) => hit.source))].map((title) => ({ title })),
      matched: top.length,
    };
  }
}
