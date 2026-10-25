// One entry point, two transports:
//   node src/server.mjs            -> streamable HTTP at /mcp (what ChatGPT connects to)
//   node src/server.mjs --stdio    -> stdio (local MCP clients: Claude Desktop, Cursor...)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as data from './store.mjs';
import { Social, Knowledge } from './adapters.mjs';
import { registerTools } from './tools.mjs';
import { startEngine } from './engine.mjs';
import { deepMerge, normalizeConfig } from './config.mjs';
import { acquireLock } from './lock.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CFG_FILE = process.env.SAM_CONFIG_FILE
  ? path.resolve(process.env.SAM_CONFIG_FILE)
  : path.join(ROOT, 'config.json');

// config.local.json (gitignored) overrides committed defaults, so a real token
// never lands in the repo. Written back by schedule_post/cancel_slot.
const LOCAL_CFG = path.join(path.dirname(CFG_FILE), 'config.local.json');
const baseCfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
const localCfg = fs.existsSync(LOCAL_CFG) ? JSON.parse(fs.readFileSync(LOCAL_CFG, 'utf8')) : {};
const fileCfg = normalizeConfig(deepMerge(baseCfg, localCfg));
const persisted = structuredClone(fileCfg);
const cfgFile = fs.existsSync(LOCAL_CFG) ? LOCAL_CFG : CFG_FILE;
const cfg = structuredClone(fileCfg);

// Env wins over both files: the token is a secret, so it belongs in the
// environment (or config.local.json), never in the committed config.json.
if (process.env.SAM_TOKEN) cfg.token = process.env.SAM_TOKEN;
if (process.env.SAM_PORT) cfg.port = Number(process.env.SAM_PORT);
if (process.env.SAM_PUBLIC_HOST) cfg.publicHost = process.env.SAM_PUBLIC_HOST;
if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
  console.error(`[server] invalid port: ${JSON.stringify(cfg.port)} (expected 1-65535)`);
  process.exit(1);
}

// A background daemon must not die on one stray rejection, but a truly fatal
// startup/listener error must exit non-zero so a supervisor can see it.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err?.stack ?? err);
});

let releaseLock;
try {
  releaseLock = acquireLock(data.DATA_DIR);
} catch (err) {
  console.error(`[server] ${err.message}`);
  process.exit(1);
}
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack ?? err);
  releaseLock?.();
  process.exit(1);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    releaseLock?.();
    process.exit(0);
  });
}

const recovered = data.recoverAttempts();
if (recovered > 0) console.error(`[store] recovered ${recovered} in-flight attempt(s); they need an explicit retry`);

function writeConfigAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
}

const dataApi = {
  ...data,
  cfg,
  saveConfig: () => {
    const toSave = structuredClone(cfg);
    // Never persist env-only secrets/ports to config.json or config.local.json.
    if (process.env.SAM_TOKEN) toSave.token = persisted.token;
    if (process.env.SAM_PORT) toSave.port = persisted.port;
    if (process.env.SAM_PUBLIC_HOST) {
      if (persisted.publicHost === undefined) delete toSave.publicHost;
      else toSave.publicHost = persisted.publicHost;
    }
    writeConfigAtomic(cfgFile, toSave);
  },
};
const social = new Social(dataApi, cfg);
const knowledge = new Knowledge(cfg);
let engine = null;

function buildServer() {
  const publicHost = cfg.publicHost ? String(cfg.publicHost).replace(/\/+$/, '') : '';
  const publicLine = publicHost
    ? `\nPublic MCP endpoint: ${publicHost.endsWith('/mcp') ? publicHost : `${publicHost}/mcp`}`
    : '';
  const server = new McpServer(
    { name: 'social-autopilot', version: '0.1.0' },
    {
      instructions:
        'This server is a social-media autopilot. Never publish anything without a decision.\n' +
        'Loop: 1) call list_pending_events. 2) for each event decide: skip, reply (comment events only), ' +
        'or publish (post_due events only). An action that does not match the event kind is rejected. ' +
        '3) if the text states facts, call verify_facts first and only keep supported claims. ' +
        '4) call decide with perform=true to actually send. perform=false is only a non-destructive preview. ' +
        'If an event warns that a previous attempt may have succeeded, check the platform and pass retry=true. ' +
        'Keep replies short and in the user language. cancel_slot removes a future scheduled slot.' +
        publicLine,
    }
  );
  // `kick` is a late-bound getter: the engine starts after the first server is
  // built (stdio path), and a captured null would never tick again.
  registerTools(server, { data: dataApi, cfg, social, knowledge, kick: () => engine?.tick?.() });
  return server;
}

function tokenMatches(got, expected) {
  const a = Buffer.from(String(got ?? ''));
  const b = Buffer.from(String(expected ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authorized(req) {
  if (!cfg.token || cfg.token === 'CHANGE_ME') return true;
  const got = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  return tokenMatches(got, cfg.token);
}

const MAX_BODY_BYTES = Number(process.env.SAM_MAX_BODY_BYTES ?? 1_000_000);
const RATE_LIMIT = Number(process.env.SAM_RATE_LIMIT ?? 300);
const rateHits = new Map();

function rateLimited(ip) {
  if (!(RATE_LIMIT > 0)) return false;
  const now = Date.now();
  const recent = (rateHits.get(ip) ?? []).filter((time) => now - time < 60_000);
  if (recent.length >= RATE_LIMIT) {
    rateHits.set(ip, recent);
    return true;
  }
  recent.push(now);
  rateHits.set(ip, recent);
  if (rateHits.size > 2000) {
    for (const [key, times] of rateHits) {
      if (!times.some((time) => now - time < 60_000)) rateHits.delete(key);
    }
  }
  return false;
}

if (process.argv.includes('--stdio')) {
  try {
    const server = buildServer();
    await server.connect(new StdioServerTransport());
    engine = startEngine({ data: dataApi, cfg, social });
  } catch (err) {
    console.error('[server] stdio startup failed:', err?.stack ?? err);
    releaseLock?.();
    process.exit(1);
  }
} else {
  // Stateless streamable HTTP: one fresh transport+server per request.
  const httpServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      const authed = authorized(req);
      const payload = { ok: true, name: 'social-autopilot', version: '0.1.0' };
      // Pending count can leak activity; only reveal it to an authorized caller
      // (or when auth is disabled).
      if (authed) payload.pending = data.state.events.length;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end('not found');
      return;
    }

    const declared = Number(req.headers['content-length']);
    if (MAX_BODY_BYTES > 0 && Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      res.writeHead(413, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'payload too large' }));
      return;
    }
    if (rateLimited(req.socket.remoteAddress ?? 'unknown')) {
      res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'rate limit exceeded' }));
      return;
    }
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    try {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(err?.message ?? err) }, id: null }));
      } else {
        res.end();
      }
    }
  });

  const port = cfg.port;
  httpServer.requestTimeout = 30_000;
  httpServer.headersTimeout = 10_000;
  httpServer.on('error', (err) => {
    console.error(`[server] cannot listen on 127.0.0.1:${port}: ${err.message}`);
    releaseLock?.();
    process.exit(1);
  });
  httpServer.listen(port, '127.0.0.1', () => {
    engine = startEngine({ data: dataApi, cfg, social });
    console.log(`social-autopilot MCP listening on http://127.0.0.1:${port}/mcp`);
    console.log(`health: http://127.0.0.1:${port}/health   |   stdio mode: node src/server.mjs --stdio`);
    console.log(`data: ${data.DATA_DIR}   |   auth: ${cfg.token && cfg.token !== 'CHANGE_ME' ? 'enabled' : 'disabled'}`);
  });
}
