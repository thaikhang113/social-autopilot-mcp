// One entry point, two transports:
//   node src/server.mjs            -> streamable HTTP at /mcp (what ChatGPT connects to)
//   node src/server.mjs --stdio    -> stdio (local MCP clients: Claude Desktop, Cursor...)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as data from './store.mjs';
import { Social, Knowledge } from './adapters.mjs';
import { registerTools } from './tools.mjs';
import { startEngine } from './engine.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CFG_FILE = path.join(ROOT, 'config.json');
const cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));

// config.local.json (gitignored) overrides committed defaults, so a real token
// never lands in the repo. Written-back by schedule_post when present.
const LOCAL_CFG = path.join(ROOT, 'config.local.json');
const cfgFile = fs.existsSync(LOCAL_CFG) ? LOCAL_CFG : CFG_FILE;
if (cfgFile === LOCAL_CFG) Object.assign(cfg, JSON.parse(fs.readFileSync(LOCAL_CFG, 'utf8')));

// A background daemon must not die on one bad async tick or one stray rejection.
// Losing the process means ChatGPT silently loses the connector.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err?.stack ?? err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack ?? err);
});

const dataApi = {
  ...data,
  cfg,
  saveConfig: () => fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2)),
};
const social = new Social(dataApi, cfg);
const knowledge = new Knowledge(cfg);

function buildServer() {
  const server = new McpServer(
    { name: 'social-autopilot', version: '0.1.0' },
    {
      instructions:
        'This server is a social-media autopilot. Never publish anything without a decision.\n' +
        'Loop: 1) call list_pending_events. 2) for each event decide: skip (comment not worth answering), ' +
        'reply (comment that needs an answer), or publish (scheduled post that is due). ' +
        '3) if the text states facts, call verify_facts first and only keep supported claims. ' +
        '4) call decide with perform=true to actually send. Keep replies short and in the user language.',
    }
  );
  registerTools(server, { data: dataApi, cfg, social, knowledge });
  return server;
}

if (process.argv.includes('--stdio')) {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  startEngine({ data: dataApi, cfg, social });
} else {
  startEngine({ data: dataApi, cfg, social });

  // Stateless streamable HTTP: one fresh transport+server per request.
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: 'social-autopilot', pending: data.state.events.length }));
      return;
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end('not found');
      return;
    }
    if (cfg.token && cfg.token !== 'CHANGE_ME') {
      const got = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (got !== cfg.token) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
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
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(err?.message ?? err) }, id: null }));
    }
  });

  const port = Number(cfg.port ?? 8787);
  httpServer.listen(port, '127.0.0.1', () => {
    console.log(`social-autopilot MCP listening on http://127.0.0.1:${port}/mcp`);
    console.log(`health: http://127.0.0.1:${port}/health   |   stdio mode: node src/server.mjs --stdio`);
  });
}
