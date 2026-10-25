// Operational regressions: bad ports and bind failures must exit non-zero, a
// second server must not share a data directory, and request limits must hold.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(ROOT, 'src', 'server.mjs');
const children = new Set();
const dirs = new Set();

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-ops-'));
  dirs.add(dir);
  return dir;
}

function writeConfig(dir, port) {
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ port, token: 'CHANGE_ME', schedule: { timezone: 'UTC', posts: [], pollSeconds: 60 } }, null, 2)
  );
  return file;
}

function start(port, env = {}) {
  const dir = tempDir();
  const data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true });
  const cfg = writeConfig(dir, port);
  const childEnv = { ...process.env, SAM_CONFIG_FILE: cfg, SAM_DATA_DIR: data, SAM_PORT: String(port) };
  delete childEnv.SAM_MAX_BODY_BYTES;
  delete childEnv.SAM_RATE_LIMIT;
  delete childEnv.SAM_LOG_MAX_BYTES;
  delete childEnv.SAM_HTTP_TIMEOUT_MS;
  delete childEnv.SAM_PUBLIC_HOST;
  Object.assign(childEnv, env);
  const child = spawn(process.execPath, [SERVER], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
  });
  children.add(child);
  let log = '';
  child.stdout.on('data', (chunk) => (log += chunk));
  child.stderr.on('data', (chunk) => (log += chunk));
  return { child, dir, data, log: () => log };
}

function exited(child, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => reject(new Error('process did not exit')), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function health(port) {
  try {
    return await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
  } catch {
    return null;
  }
}

async function waitUp(port, child, log) {
  for (let i = 0; i < 40; i += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${log()}`);
    const res = await health(port);
    if (res?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`server did not become healthy\n${log()}`);
}

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

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n${err.stack}`);
    process.exitCode = 1;
  }
}

async function mcpCall(port, token, body) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

try {
  await test('invalid SAM_PORT exits with code 1', async () => {
    const port = await freePort();
    const server = start(port, { SAM_PORT: 'not-a-port' });
    const code = await exited(server.child);
    assert.equal(code, 1);
    assert.match(server.log(), /invalid port/);
  });

  await test('EADDRINUSE exits with code 1', async () => {
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = blocker.address().port;
    try {
      const server = start(port);
      const code = await exited(server.child);
      assert.equal(code, 1);
      assert.match(server.log(), /cannot listen|EADDRINUSE/);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  await test('a second server on the same data dir is refused', async () => {
    const port1 = await freePort();
    const first = start(port1);
    await waitUp(port1, first.child, first.log);
    const port2 = await freePort();
    const dir = tempDir();
    const cfg2 = writeConfig(dir, port2);
    const second = spawn(process.execPath, [SERVER], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SAM_CONFIG_FILE: cfg2, SAM_DATA_DIR: first.data, SAM_PORT: String(port2) },
    });
    children.add(second);
    let log = '';
    second.stdout.on('data', (chunk) => (log += chunk));
    second.stderr.on('data', (chunk) => (log += chunk));
    const code = await exited(second);
    assert.equal(code, 1);
    assert.match(log, /already running/);
    first.child.kill();
    await exited(first.child).catch(() => {});
  });

  await test('a stale lock with a dead pid is taken over', async () => {
    const port = await freePort();
    const dir = tempDir();
    const data = path.join(dir, 'data');
    fs.mkdirSync(data, { recursive: true });
    const cfg = writeConfig(dir, port);
    fs.writeFileSync(path.join(data, '.lock'), JSON.stringify({ pid: 2147483647, at: new Date().toISOString() }));
    const child = spawn(process.execPath, [SERVER], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SAM_CONFIG_FILE: cfg, SAM_DATA_DIR: data, SAM_PORT: String(port) },
    });
    children.add(child);
    let log = '';
    child.stdout.on('data', (chunk) => (log += chunk));
    child.stderr.on('data', (chunk) => (log += chunk));
    await waitUp(port, child, () => log);
    child.kill();
    await exited(child).catch(() => {});
  });

  await test('startup recovers an in-flight attempt as an ambiguous event', async () => {
    const port = await freePort();
    const dir = tempDir();
    const data = path.join(dir, 'data');
    fs.mkdirSync(data, { recursive: true });
    const cfg = writeConfig(dir, port);
    fs.writeFileSync(
      path.join(data, 'state.json'),
      JSON.stringify({
        seq: 1,
        events: [],
        history: [],
        inbound: [],
        outbox: [],
        inflight: {
          evt_crash: {
            event: { id: 'evt_crash', kind: 'comment', commentId: 'c1', text: 'hello' },
            action: 'reply',
            text: 'hi',
            at: new Date().toISOString(),
            status: 'sending',
          },
        },
      })
    );
    const child = spawn(process.execPath, [SERVER], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SAM_CONFIG_FILE: cfg, SAM_DATA_DIR: data, SAM_PORT: String(port) },
    });
    children.add(child);
    let log = '';
    child.stdout.on('data', (chunk) => (log += chunk));
    child.stderr.on('data', (chunk) => (log += chunk));
    await waitUp(port, child, () => log);
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
    assert.deepEqual(saved.inflight, {});
    assert.equal(saved.events[0].id, 'evt_crash');
    assert.equal(saved.events[0].lastAttempt.ambiguous, true);
    child.kill();
    await exited(child).catch(() => {});
  });

  await test('oversized declared body gets HTTP 413', async () => {
    const port = await freePort();
    const server = start(port, { SAM_MAX_BODY_BYTES: '10' });
    await waitUp(port, server.child, server.log);
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });
    assert.equal(res.status, 413);
    server.child.kill();
    await exited(server.child).catch(() => {});
  });

  await test('rate limit returns HTTP 429', async () => {
    const port = await freePort();
    const server = start(port, { SAM_RATE_LIMIT: '2' });
    await waitUp(port, server.child, server.log);
    const statuses = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      statuses.push(res.status);
      await res.text();
    }
    assert.equal(statuses.at(-1), 429, `statuses=${statuses.join(',')}`);
    server.child.kill();
    await exited(server.child).catch(() => {});
  });

  await test('saveConfig strips env-only token/port/public host', async () => {
    const dir = tempDir();
    const data = path.join(dir, 'data');
    fs.mkdirSync(data, { recursive: true });
    const cfgPort = await freePort();
    let envPort = await freePort();
    while (envPort === cfgPort) envPort = await freePort();
    const cfg = writeConfig(dir, cfgPort);
    const child = spawn(process.execPath, [SERVER], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SAM_CONFIG_FILE: cfg,
        SAM_DATA_DIR: data,
        SAM_PORT: String(envPort),
        SAM_TOKEN: 'secret',
        SAM_PUBLIC_HOST: 'https://example.test',
      },
    });
    children.add(child);
    let log = '';
    child.stdout.on('data', (chunk) => (log += chunk));
    child.stderr.on('data', (chunk) => (log += chunk));
    await waitUp(envPort, child, () => log);

    const init = await mcpCall(envPort, 'secret', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ops', version: '0' } },
    });
    assert.equal(init.status, 200);
    const scheduled = await mcpCall(envPort, 'secret', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'schedule_post',
        arguments: { brief: 'env-safe slot', at: new Date(Date.now() + 3600_000).toISOString() },
      },
    });
    assert.equal(scheduled.status, 200);
    assert.ok(!scheduled.text.includes('"isError":true'), scheduled.text.slice(0, 300));

    const saved = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    assert.equal(saved.port, cfgPort);
    assert.equal(saved.token, 'CHANGE_ME');
    assert.equal(saved.publicHost, undefined);
    assert.equal(saved.schedule.posts.length, 1);

    child.kill();
    await exited(child).catch(() => {});
  });
} finally {
  for (const child of children) {
    try {
      child.kill();
    } catch {}
  }
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

console.log(process.exitCode ? '\nSOME OPS TESTS FAILED' : '\nALL OPS TESTS PASSED');
