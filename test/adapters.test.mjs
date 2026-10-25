import assert from 'node:assert/strict';
import { Social } from '../src/adapters.mjs';

// runnable assert-based check for facebook adapter
const calls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  calls.push({ url, opts });
  if (url.includes('/feed?fields=')) {
    return {
      ok: true,
      text: async () => '',
      json: async () => ({
        data: [
          {
            id: 'post_1',
            comments: {
              data: [
                { id: 'c_1', from: { id: 'user_1', name: 'Alice' }, message: 'Hello bot', created_time: '2026-10-22T08:00:00Z' },
                { id: 'c_page', from: { id: 'page_999', name: 'My Page' }, message: 'Page reply', created_time: '2026-10-22T08:01:00Z' },
                {
                  id: 'c_2',
                  from: { id: 'user_2', name: 'Bob' },
                  message: '',
                  created_time: '2026-10-22T08:02:00Z',
                  comments: {
                    data: [{ id: 'c_sub', from: { id: 'user_3', name: 'Charlie' }, message: 'Sub reply', created_time: '2026-10-22T08:03:00Z' }],
                  },
                },
              ],
            },
          },
        ],
      }),
    };
  }
  return {
    ok: true,
    text: async () => '',
    json: async () => ({ id: 'fb_123' }),
  };
};

try {
  const dummyData = { state: { outbox: [], inbound: [] }, save: () => {} };
  const fbSocial = new Social(dummyData, {
    social: { kind: 'facebook', pageId: 'page_999', pageAccessToken: 'token_abc' },
  });

  // 1. publish
  const pub = await fbSocial.publish('Test post');
  assert.equal(pub.id, 'fb_123');
  assert.equal(calls[0].url, 'https://graph.facebook.com/v21.0/page_999/feed');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer token_abc');

  // 2. reply
  const rep = await fbSocial.reply('comment_555', 'Test reply');
  assert.equal(rep.id, 'fb_123');
  assert.equal(calls[1].url, 'https://graph.facebook.com/v21.0/comment_555/comments');

  // 3. comments (must skip comment from page itself, support nested replies & sticker fallback)
  const cmts = await fbSocial.comments();
  assert.equal(cmts.length, 3);
  assert.equal(cmts[0].id, 'c_1');
  assert.equal(cmts[0].author, 'Alice');
  assert.equal(cmts[0].text, 'Hello bot');

  assert.equal(cmts[1].id, 'c_2');
  assert.equal(cmts[1].text, '[Sticker/Hình ảnh]');

  assert.equal(cmts[2].id, 'c_sub');
  assert.equal(cmts[2].author, 'Charlie');
  assert.equal(cmts[2].text, 'Sub reply');

  console.log('✅ adapters.test.mjs passed: Facebook adapter verified');
} finally {
  globalThis.fetch = originalFetch;
}

// ---------- regression: Facebook HTTP 200 errors, pagination, since filter, media ----------
const originalFetch2 = globalThis.fetch;
globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.includes('page_err/feed')) {
    return { ok: true, status: 200, json: async () => ({ error: { message: 'permission denied' } }) };
  }
  if (target.includes('page_pag/feed')) {
    if (!target.includes('after=abc')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: 'post_p1',
              comments: {
                data: [
                  { id: 'c_old', from: { id: 'u1', name: 'Old' }, message: 'old', created_time: '2020-01-01T00:00:00Z' },
                  { id: 'c_new', from: { id: 'u2', name: 'New' }, message: 'new', created_time: new Date().toISOString() },
                ],
              },
            },
          ],
          paging: { next: 'https://graph.facebook.com/v21.0/page_pag/feed?after=abc' },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            id: 'post_p2',
            comments: {
              data: [{ id: 'c_second', from: { id: 'u3', name: 'Second' }, message: 'second', created_time: new Date().toISOString() }],
            },
          },
        ],
      }),
    };
  }
  return { ok: true, status: 200, json: async () => ({ id: 'unexpected' }) };
};

try {
  const dummyData = { state: { outbox: [], inbound: [] }, save: () => {} };

  const errorSocial = new Social(dummyData, {
    social: { kind: 'facebook', pageId: 'page_err', pageAccessToken: 'token_abc' },
  });
  await assert.rejects(errorSocial.publish('will fail'), /permission denied/);

  const mediaSocial = new Social(dummyData, {
    social: { kind: 'facebook', pageId: 'page_pag', pageAccessToken: 'token_abc' },
  });
  await assert.rejects(mediaSocial.publish('with media', [{ type: 'image' }]), /text-only/);

  const pageSocial = new Social(dummyData, {
    social: { kind: 'facebook', pageId: 'page_pag', pageAccessToken: 'token_abc' },
  });
  const comments = await pageSocial.comments(new Date(Date.now() - 864e5).toISOString());
  assert.deepEqual(comments.map((comment) => comment.id), ['c_new', 'c_second']);
  assert.equal(comments[0].text, 'new');

  console.log('✅ adapters regression: 200 error, pagination, since filter and media verified');
} finally {
  globalThis.fetch = originalFetch2;
}
