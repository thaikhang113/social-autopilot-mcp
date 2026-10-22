# social-autopilot-mcp

MCP server (Model Context Protocol) that connects ChatGPT web / Claude / any MCP client to a **social-media autopilot loop**: scheduled posting, comment triage, and fact-grounding against your own documents.

> **Design rule #1 — the LLM decides, the server executes.**
> This server never writes content and never decides whether to reply. It only answers two questions:
> *"is there anything to decide right now?"* and *"do what I decided"*.
> Any change that makes the server generate text or auto-reply on its own breaks the design.

---

## 1. What problem this solves

ChatGPT web cannot reach `localhost`, and social platforms don't expose a model-friendly API. This server sits in between:

```
ChatGPT web ──HTTPS/tunnel──> POST /mcp  (streamable HTTP)  ─┐
                                                              │
setInterval: due slots      ──> events[]  ───────────────────┤──> tools.mjs  (LLM's hands)
setInterval: new comments   ──> events[]  ───────────────────┘
                                                              │
docs/*.md  ──> verify_facts (grounding)  ─────────────────────┘──> adapters.mjs (platform side)
```

Three independent pieces, deliberately decoupled:

| Piece | File | Responsibility |
|---|---|---|
| Decision surface | `src/tools.mjs` | The 5 MCP tools the model calls |
| Trigger engine | `src/engine.mjs` | Decides *when* there is work (timers only) |
| Side effects | `src/adapters.mjs` | Talks to the real platform / knowledge base |

`src/server.mjs` wires them; `src/store.mjs` is persistence.

---

## 2. The loop the model must follow

The server injects this in the MCP `instructions` field, so a fresh client learns it on connect:

```
1. list_pending_events               -> what needs a decision
2. per event: skip | reply | publish
3. verify_facts before any factual claim
4. decide(perform=true)              -> actually sends
```

`decide` without `perform=true` only records the decision (a dry run). This is intentional: write actions are two-phase so a bad draft is never sent by accident.

### The 5 tools

| Tool | Annotations | Contract |
|---|---|---|
| `list_pending_events` | read-only | `{limit?}` → `{events:[{id, kind:'post_due'\|'comment', summary, ...}]}` |
| `decide` | destructive | `{event_id, action:'skip'\|'reply'\|'publish', text?, reason?, perform?}` → `{ok, decided, performed?}` |
| `verify_facts` | read-only | `{query, draft?}` → `{answer, sources[], supported:boolean}` |
| `schedule_post` | non-destructive | `{brief, at, every_days?}` → `{slotId, next}` |
| `recent_activity` | read-only | `{limit?}` → `{decisions[]}` |

`reply` / `publish` **require** `text`. `skip` does not. Publishing a comment event or replying to a post event is rejected implicitly (no `performed` is produced) — kinds are checked in `decide`.

---

## 3. Data model

State lives in `data/state.json` (JSON, atomic write via temp+rename with retry):

```jsonc
{
  "seq": 0,
  "events":  [],   // pending decisions, consumed by decide()
  "history": [],   // decided events, audit trail, never deleted
  "inbound": [],   // comments seen, with handled flag
  "outbox":  []    // what mock published/replied
}
```

`data/log.jsonl` is an append-only log (`{type:'event'|'decision'|'poll_error'|'engine_error', ...}`).
`data/inbox.json` is the mock platform's "new comments" feed — the stand-in for a real webhook/inbox API.

**Invariant:** an event id appears in `events` at most once, and once decided it moves to `history`. `decide` on an unknown/already-decided id throws.

---

## 4. Wiring a real platform

Only `src/adapters.mjs` changes. `config.json` selects the implementation:

```json
{ "social": { "kind": "http", "url": "http://127.0.0.1:9000/social", "token": "..." } }
```

The bridge must accept `POST` and answer these three ops:

| op | request | response |
|---|---|---|
| `publish` | `{text, media}` | `{id}` |
| `reply` | `{comment_id, text}` | `{id}` |
| `comments` | `{since}` | `{comments:[{id, author, text, post_id, at}]}` |

`kind:"mock"` (default) writes to `state.outbox` and reads comments from `data/inbox.json`.
This contract is the seam: Eclincher, Buffer, Postiz, a custom scheduler, or another MCP server all fit behind it.

### Knowledge / grounding

```json
{ "knowledge": { "kind": "http", "url": "http://127.0.0.1:9100/kb", "token": "..." } }
```

Bridge: `POST {query}` → `{answer, sources:[{title, url?}]}`.
`kind:"file"` (default) scores lines in `docs/*.md` by term overlap — no embedding model, no network. Drop files in `docs/` and grounding works immediately.

`supported` is computed as: at least 35% of draft words longer than 4 chars appear in the retrieved passage. That is a *heuristic*, not verification — see §7.

---

## 5. Scheduling semantics (know the limits before extending)

- `schedule_post` appends a slot to `config.json` → `schedule.posts`.
- Each engine tick (default 60s, `schedule.pollSeconds`) emits `post_due` for any slot whose `at` has passed and which has no queued/decided event.
- **A slot fires once.** `every_days` is stored but *not* used by the engine yet.
- Content is written by the model **at fire time**, so posts never go stale — that is why the slot holds a `brief` (intent) instead of `text`.

To implement true recurrence, compute the next occurrence from `everyDays` inside `seedDuePosts` and compare against `history` entries; do not add a second timer.

---

## 6. Running & verifying

```bash
npm install
npm start          # HTTP, http://127.0.0.1:8787/mcp  (+ /health)
npm run stdio      # stdio transport for local clients
npm test           # e2e, requires the server running
```

Windows convenience: `start.cmd` (keep the window open — closing it stops the server).

`test/e2e.mjs` is the only test and it covers the whole path: handshake, `tools/list`, grounding true **and** false cases, comment pickup, publish, reply, skip, audit trail, health. It talks over real HTTP to a real process — no mocks of the MCP layer.

## 7. Deliberate limitations (do not "fix" these by guessing)

| Limitation | Why it exists | Correct upgrade |
|---|---|---|
| `token` defaults to `CHANGE_ME` = auth off | local dev convenience | set a real token before exposing a tunnel; add OAuth 2.1 + `/.well-known/oauth-protected-resource` for multi-user |
| `supported` is word-overlap | zero deps, works offline | replace with a semantic/LLM-as-judge check behind the same return shape |
| `every_days` ignored | recurrence needs a "next occurrence" rule that wasn't specified | implement in `seedDuePosts`, see §5 |
| JSON files instead of a DB | single user, tiny state | swap `src/store.mjs` only; keep `save()`/`pushEvent`/`takeEvent` signatures |
| Stateless HTTP (no sessions, no SSE streaming) | simplest thing that ChatGPT accepts | use `StreamableHTTPServerTransport` with session ids if streaming responses are needed |
| Mock `inbox.json` | no real inbox API available | `social.kind:"http"` |

## 8. Operational notes learned the hard way

- **Never run this from a OneDrive-synced folder.** OneDrive holds file locks; the state write then throws inside a timer callback, becomes an unhandled rejection, and silently kills the process after a few minutes. `save()` now retries, but the real fix is a non-synced path (`D:\` in this machine's setup).
- `setInterval(asyncFn)` swallows nothing: a rejection there terminates Node by default. The engine wraps each stage in try/catch, and `server.mjs` installs `unhandledRejection` / `uncaughtException` handlers because this is a long-running daemon.
- Background start on Windows that survives the spawning shell:
  `cmd /c start "" /b node src\server.mjs`

## 9. Connecting ChatGPT web

Requirements (per OpenAI docs): a public **HTTPS** endpoint serving **streamable HTTP** at a path like `/mcp`; `localhost` is not reachable.

```powershell
cloudflared tunnel --url http://127.0.0.1:8787   # -> https://<random>.trycloudflare.com
```

Then: <https://chatgpt.com/plugins> → `+` → **Add custom MCP server** → URL `https://<random>.trycloudflare.com/mcp` → **Create as a plugin**.

Production: OpenAI **Secure MCP Tunnel** (`tunnel-client`, outbound-only) or a stable public HTTPS endpoint. A quick tunnel is for development only.

## 10. File map

```
src/server.mjs    entry point, transport selection, process-level error handling
src/tools.mjs     the 5 MCP tools + zod schemas + auth guard
src/engine.mjs    timers: due slots + comment polling -> events
src/adapters.mjs  Social (publish/reply/comments) + Knowledge (grounding)  <- extensible seam
src/store.mjs     JSON persistence, atomic save with retry, append-only log
config.json       port, token, adapter kind, schedule slots
docs/*.md         grounding corpus for verify_facts
test/e2e.mjs      full-path integration test
```