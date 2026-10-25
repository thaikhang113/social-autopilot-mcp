# social-autopilot-mcp

> **English** · [Tiếng Việt](README.vi.md)

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
| Decision surface | `src/tools.mjs` | The 6 MCP tools the model calls |
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

`decide` without `perform=true` is a **non-destructive preview**: it does not consume the event, write history, or mark a comment handled. Call it again with `perform=true` to send. `skip` is itself a decision, so it consumes the event even without `perform`.

### The 6 tools

| Tool | Annotations | Contract |
|---|---|---|
| `list_pending_events` | read-only | `{limit?}` → `{events:[{id, kind:'post_due'\|'comment', summary, ...}]}` |
| `decide` | destructive | `{event_id, action:'skip'\|'reply'\|'publish', text?, reason?, perform?, retry?}` → `{ok, decided, performed?, dryRun?}` |
| `verify_facts` | read-only | `{query, draft?}` → `{answer, sources[], supported:boolean, reason?}` |
| `schedule_post` | non-destructive | `{brief, at?, cron?, timezone?}` → `{slotId, next, cron, deduped?}` |
| `cancel_slot` | destructive | `{slot_id}` → `{ok, removed, pendingRemoved}` |
| `recent_activity` | read-only | `{limit?}` → `{decisions[]}` |

`reply` / `publish` **require** `text`. `skip` does not. Kinds are validated explicitly: a `post_due` event accepts only `publish|skip`, a `comment` event only `reply|skip`. A wrong action returns a tool error and leaves the event pending.

If an event carries a `lastAttempt` warning, a previous send may have reached the platform before the failure was recorded. Check the platform, then pass `retry=true`; without it the server refuses to risk a duplicate. The event id stays stable across failures.

A `post_due` event also carries `slotId`, `occurrence` (the window it represents) and `cron`. `occurrence` is what makes recurrence deduplicable — see §5.

---

## 3. Data model

State lives in `data/state.json` (JSON, atomic write via temp+rename with retry):

```jsonc
{
  "seq": 0,
  "events":  [],   // pending decisions, consumed by decide()
  "history": [],   // decided events, audit trail (bounded to the latest 5000)
  "inbound": [],   // comments seen, with handled flag
  "outbox":  [],   // what mock published/replied (bounded to the latest 2000)
  "inflight": {},  // sends in progress; recovered as ambiguous after a crash
  "slotDone": {},  // latest decided occurrence per slot (survives history trimming)
  "commentDone": {} // id-only comment dedupe (bounded to 20000)
}
```

`data/log.jsonl` is an append-only log (`{type:'event'|'decision'|'decision_error'|'poll_error'|'engine_error'|'slot_cancelled', ...}`). It rotates to `log.jsonl.1`…`.3` at 5 MB by default.
`data/inbox.json` is the mock platform's "new comments" feed — the stand-in for a real webhook/inbox API.
`data/.lock` is the single-instance PID lock; a second server on the same data directory exits with code 1.

State is validated on load: a corrupt or wrong-shaped field (for example `"events": {}`) is reset with a warning instead of crashing every tool. Compaction keeps every unhandled comment and the latest 5000 handled comments, so dedupe still works without unbounded growth.

**Invariant:** an event id appears in `events` at most once, and once decided it moves to `history`. A failed send restores the **same** event id with `lastAttempt` instead of losing the decision; an interrupted send is recovered on startup as `lastAttempt.status:"unknown"` and requires `retry=true`.

---

## 4. Wiring a real platform

Only `src/adapters.mjs` changes. `config.json` selects the implementation:

```json
{ "social": { "kind": "http", "url": "http://127.0.0.1:9000/social", "token": "..." } }
```

The bridge must accept `POST` and answer these three ops:

| op | request | response |
|---|---|---|
| `publish` | `{text, media, idempotency_key?}` | `{id}` |
| `reply` | `{comment_id, text, idempotency_key?}` | `{id}` |
| `comments` | `{since}` | `{comments:[{id, author, text, post_id, at}]}` |

The server also sends an `Idempotency-Key: <event id>` header. A bridge that honours it can make retries safe; the mock adapter dedupes the key in `state.outbox`. Facebook's Graph API has no such header, so an ambiguous Facebook send must be checked manually before `retry=true`.

`kind:"mock"` (default) writes to `state.outbox` and reads comments from `data/inbox.json`.
This contract is the seam: Eclincher, Buffer, Postiz, a custom scheduler, or another MCP server all fit behind it.

**Facebook adapter:** `social.kind:"facebook"` uses the Page feed/comments API. It rejects HTTP 200 responses that contain `{error}`, follows feed pagination (bounded by `social.maxFeedPages`, default 5), filters comments by `since` instead of relying on the feed's own `since`, and is **text-only** — passing `media[]` throws instead of silently dropping it. It is still polling, not webhooks, so very old posts may fall outside the pagination window.

### Knowledge / grounding

```json
{ "knowledge": { "kind": "http", "url": "http://127.0.0.1:9100/kb", "token": "..." } }
```

Bridge: `POST {query}` → `{answer, sources:[{title, url?}]}`.
`kind:"file"` (default) scores lines in `docs/*.md` by term overlap — no embedding model, no network. Drop files in `docs/` and grounding works immediately.

`supported` is computed as: at least **50%** of the draft's content words (length ≥2, diacritics-insensitive, stopwords/negators removed) appear in the retrieved passage **and** no negation/antonym contradiction is detected. For example, “X is not open source” is rejected when the passage says “X is open source”, and “paid” is rejected when the passage says “free”. An empty draft returns `supported:false`. This is a *heuristic*, not verification — see §7.

---

## 5. Scheduling semantics

- `schedule_post` appends a slot to `schedule.posts` and **kicks the engine immediately**, so a slot whose `at` is already in the past surfaces at once instead of waiting up to `pollSeconds`.
- Identical `brief`/`at`/`cron`/`timezone` calls return the existing slot with `deduped:true` instead of stacking duplicates.
- `cancel_slot` removes the slot and any pending `post_due` events for it. A send already in flight cannot be recalled.
- Each tick (default 60s, `schedule.pollSeconds`) emits `post_due` for a slot with no queued/decided event. Ticks never overlap, so a slow platform cannot raise the same comment twice.
- Content is written by the model **at fire time**, so posts never go stale — that is why the slot holds a `brief` (intent) instead of `text`.

### One-shot vs cron

| `cron` | Behaviour |
|---|---|
| omitted | Fires once, ever, at `at`. Once published, the slot is spent. |
| 5-field expression | Fires at every matching minute in `timezone`, never before `at`. |

```
cron = "minute hour day-of-month month day-of-week"
"0 9 * * *"      → 09:00 every day
"0 9 * * 1,3,5"  → 09:00 Mon/Wed/Fri    (0=Sunday, 1=Monday)
"*/15 8-18 * * *" → every 15 min, 08:00–18:45
```

`dueOccurrence(slot, now, tz)` in `src/engine.mjs` is the only place that decides *when*. Parsing is delegated to `cron-parser` (real DST handling, ranges, steps, names) — do not hand-roll a cron parser. For a cron slot it returns the **most recent** occurrence at or before `now`, and never one earlier than `at`.

**Missed runs collapse into a single event, deliberately.** If the server is off for five days, a daily slot raises one `post_due` on boot — not five. Catching up by posting five times is never what a user wants from a social account.

Deduplication is per occurrence: the event carries `occurrence`, and history entries record it, so the same window is never raised twice while later windows still fire.

Two parser details that are easy to get wrong, both already handled:

- `cron-parser`'s `prev()` is **exclusive** of its `currentDate`, so asking at exactly 09:00:00 for `"0 9 * * *"` returns *yesterday*. The engine parses from `now + 1000ms` so the boundary occurrence counts as reached.
- Only 5-field expressions are accepted. A 6-field form would silently mean "with seconds" to the parser while this server schedules on minute granularity, so `schedule_post` rejects it.

`timezone` defaults to `schedule.timezone` in `config.json`, then to the host zone. Both the cron parser and `Intl` validate it, so a typo fails at `schedule_post` time rather than producing a slot that never fires.

---

## 6. Running & verifying

```bash
npm install
npm start          # HTTP, http://127.0.0.1:8787/mcp  (+ /health)
npm run stdio      # stdio transport for local clients
npm test           # unit + ops + isolated e2e + docs checks
```

Windows convenience: `start.cmd` uses its own folder (`%~dp0`), so the checkout can move. Keep the window open — closing it stops the server.

`npm test` no longer needs (or touches) a running server or the real `data/`. With no `BASE`, `test/e2e.mjs` copies the config into a temp directory, starts its own server on a random port with `SAM_DATA_DIR`/`SAM_CONFIG_FILE`, and deletes everything on exit. Set `BASE=http://127.0.0.1:8787` to target an already-running server instead; in that mode the caller owns its data directory.

The suite covers:
- `test/adapters.test.mjs` — Facebook response/pagination edge cases.
- `test/edge-cases.test.mjs` — Vietnamese search/grounding and cron dedupe.
- `test/reliability.test.mjs` — config deep-merge, negation guard, corrupt state, failed/ambiguous sends, comment re-raise, log rotation, single-instance lock.
- `test/ops.test.mjs` — invalid port, `EADDRINUSE`, second-server refusal, body limit, rate limit.
- `test/e2e.mjs` — real HTTP/process path: handshake, 6 tools, grounding true/false/negated, comment pickup, dry-run, publish, reply, skip, wrong-kind rejection, cron, dedupe, cancel, auth, CORS, health.
- `test/readme-check.mjs` — encoding, fences, EN/VI parity.

The e2e run prints **32 checks** in either auth mode. The auth check asserts 401 when `SAM_TOKEN` is set and an accepted bare request when auth is disabled:

```bash
node test/e2e.mjs                          # 32 checks, auth disabled
SAM_TOKEN=secret node test/e2e.mjs         # 32 checks, includes the 401 case
```

### Secrets and limits

The token is read from the environment first, then `config.local.json` (gitignored), then `config.json`:

| Variable | Purpose |
|---|---|
| `SAM_TOKEN` | Bearer token required on `/mcp`. Unset or `CHANGE_ME` = auth disabled (local dev only). |
| `SAM_PORT` | Override the listen port (default 8787). |
| `SAM_PUBLIC_HOST` | Public base URL written into the MCP `instructions` (e.g. `https://xxx.trycloudflare.com`). |
| `SAM_CONFIG_FILE` | Alternate `config.json` path (used by tests/ops). |
| `SAM_DATA_DIR` | Alternate state/log/inbox directory (used by tests/ops). |
| `SAM_MAX_BODY_BYTES` | Max declared request body; default 1000000, `0` disables. |
| `SAM_RATE_LIMIT` | `/mcp` requests per minute per IP; default 300, `0` disables. |
| `SAM_LOG_MAX_BYTES` | Log rotation threshold; default 5 MB. |
| `SAM_HTTP_TIMEOUT_MS` | Timeout for bridge/Facebook requests; default 15000. |

```powershell
$env:SAM_TOKEN = 'paste-a-long-random-string'
node src\server.mjs
```

Env values are never written back by `schedule_post`/`cancel_slot`; only `config.local.json` (or the committed config when no local file exists) is updated, and `SAM_TOKEN`/`SAM_PORT`/`SAM_PUBLIC_HOST` are stripped from that write.

Auth is enforced **once, at the HTTP layer** with a timing-safe comparison. There is no per-tool `token` argument — MCP clients send credentials as an `Authorization` header, never inside tool arguments, so a token parameter could only ever fail. `/health` stays public but hides the pending count unless the request is authorized.

## 7. Deliberate limitations (do not "fix" these by guessing)

| Limitation | Why it exists | Correct upgrade |
|---|---|---|
| `token` defaults to `CHANGE_ME` = auth off | local dev convenience | set `SAM_TOKEN` before exposing a tunnel; add OAuth 2.1 + `/.well-known/oauth-protected-resource` for multi-user |
| `supported` is word-overlap + polarity check | zero deps, works offline | replace with a semantic/LLM-as-judge check behind the same return shape |
| `every_days` is day-interval, not cron | no cron parser needed for "post every day" | done — replaced by `cron` via `cron-parser`, see §5 |
| JSON files instead of a DB | single user, tiny state | swap `src/store.mjs` only; keep `save()`/`pushEvent`/`takeEvent` signatures. History/outbox are compacted, so this is not an unbounded audit archive. |
| Facebook is polling and text-only | no webhook server / media upload in this scope | add Meta Webhooks and `/photos`; media currently fails loudly instead of being dropped |
| Single-instance lock is a PID file | no extra dependency | swap for a DB advisory lock if the data directory moves to a shared volume |
| Stateless HTTP (no sessions, no SSE streaming) | simplest thing that ChatGPT accepts | use `StreamableHTTPServerTransport` with session ids if streaming responses are needed |
| Mock `inbox.json` | no real inbox API available | `social.kind:"http"` |

## 8. Operational notes learned the hard way

- **Never run this from a OneDrive-synced folder.** OneDrive holds file locks; the state write then throws inside a timer callback, becomes an unhandled rejection, and silently kills the process after a few minutes. `save()` now retries, but the real fix is a non-synced path (`D:\` in this machine's setup).
- A bind failure or invalid `SAM_PORT` now logs the reason and exits **1**, so a supervisor/terminal can tell the server is not listening. A second process on the same data directory is refused by `data/.lock` instead of silently overwriting decisions.
- `unhandledRejection` is logged; `uncaughtException` is logged and exits non-zero (resuming after an unknown fatal error is unsafe). The engine still wraps each poll stage so one bad tick does not kill the daemon.
- Request bodies with a declared size over `SAM_MAX_BODY_BYTES` get HTTP 413, and `/mcp` is rate-limited per IP (`SAM_RATE_LIMIT`). The HTTP server also sets request/header timeouts.
- CORS is `Access-Control-Allow-Origin: *` because MCP clients are normally server-side and authenticate with a Bearer header, not cookies. If you put a browser app with cookies in front of it, restrict the origin instead of relying on the wildcard.
- `/health` is public but only reveals the pending count when the request carries a valid token; auth comparison is timing-safe.
- Background start on Windows that survives the spawning shell:
  `cmd /c start "" /b node src\server.mjs`

## 9. Connecting ChatGPT web

Requirements (per OpenAI docs): a public **HTTPS** endpoint serving **streamable HTTP** at a path like `/mcp`; `localhost` is not reachable.

```powershell
cloudflared tunnel --url http://127.0.0.1:8787   # -> https://<random>.trycloudflare.com
```

Then: <https://chatgpt.com/plugins> → `+` → **Add custom MCP server** → URL `https://<random>.trycloudflare.com/mcp` → **Create as a plugin**.

If `SAM_TOKEN` is set on the server, the connector must send it as `Authorization: Bearer <token>` — set that up when adding the connector, or auth will reject every call with 401. Set `SAM_PUBLIC_HOST=https://<random>.trycloudflare.com` to include the public `/mcp` URL in the server's `instructions`; it is never persisted into the config files.

Production: OpenAI **Secure MCP Tunnel** (`tunnel-client`, outbound-only) or a stable public HTTPS endpoint. A quick tunnel is for development only.

## 10. File map

```
src/server.mjs       entry point, transport selection, env/config load, HTTP auth/limits, process error handling
src/tools.mjs        the 6 MCP tools + zod schemas
src/decision.mjs     transactional decide(): kind/action validation, dry-run, retries, inflight recovery
src/config.mjs       deep merge + shape/port/timezone normalization
src/grounding.mjs    overlap + negation/antonym guard for verify_facts
src/engine.mjs       dueOccurrence()/validateCron() + timers: due slots + comment polling -> events
src/adapters.mjs     Social (mock/http/facebook) + Knowledge (grounding)  <- extensible seam
src/store.mjs        JSON persistence, compact state, atomic save, log rotation, inflight attempts
src/state-schema.mjs pure normalize/compact/recover helpers (unit-testable)
src/lock.mjs         single-instance PID lock in the data directory
config.json          port, adapter kind, timezone, schedule slots (committed; no secrets)
config.local.json    optional gitignored override (token lives here or in SAM_TOKEN)
docs/*.md            grounding corpus for verify_facts
test/e2e.mjs         isolated full-path integration test
test/reliability.test.mjs  config/grounding/state/decision/lock regressions
test/ops.test.mjs    exit codes, single-instance, body/rate limits
```