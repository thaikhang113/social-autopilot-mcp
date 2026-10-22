# social-autopilot-mcp

> [English](README.md) · **Tiếng Việt**

MCP server (Model Context Protocol) nối **ChatGPT web / Claude / bất kỳ MCP client** với một vòng lặp **autopilot mạng xã hội**: đăng bài theo lịch, phân loại comment, và kiểm chứng nội dung dựa trên tài liệu của chính bạn.

> **Nguyên tắc thiết kế #1 — LLM quyết định, server thi hành.**
> Server này **không tự viết nội dung** và **không tự quyết định** có trả lời hay không. Nó chỉ trả lời hai câu hỏi:
> *"ngay bây giờ có gì cần quyết không?"* và *"làm đúng cái tôi đã quyết"*.
> Bất kỳ thay đổi nào khiến server tự sinh chữ hoặc tự trả lời là **phá vỡ thiết kế**.

---

## 1. Bài toán này giải quyết gì

ChatGPT web không truy cập được `localhost`, còn các nền tảng mạng xã hội thì không có API thân thiện với model. Server này đứng giữa:

```
ChatGPT web ──HTTPS/tunnel──> POST /mcp  (streamable HTTP)  ─┐
                                                              │
setInterval: slot tới giờ   ──> events[]  ───────────────────┤──> tools.mjs  (tay của LLM)
setInterval: comment mới    ──> events[]  ───────────────────┘
                                                              │
docs/*.md  ──> verify_facts (grounding)  ─────────────────────┘──> adapters.mjs (phía nền tảng)
```

Ba phần độc lập, tách rời có chủ đích:

| Phần | File | Trách nhiệm |
|---|---|---|
| Bề mặt quyết định | `src/tools.mjs` | 5 tool MCP mà model gọi |
| Engine kích hoạt | `src/engine.mjs` | Quyết định *khi nào* có việc (chỉ timer) |
| Tác dụng phụ | `src/adapters.mjs` | Nói chuyện với nền tảng thật / knowledge base |

`src/server.mjs` nối chúng lại; `src/store.mjs` lo lưu trữ.

---

## 2. Vòng lặp model phải theo

Server nhét đoạn này vào trường `instructions` của MCP, nên client mới kết nối là biết ngay:

```
1. list_pending_events               -> có gì cần quyết
2. mỗi event: skip | reply | publish
3. verify_facts trước mọi phát ngôn có số liệu/sự thật
4. decide(perform=true)              -> mới thật sự gửi
```

`decide` **không** có `perform=true` chỉ ghi lại quyết định (chạy khô). Cố ý như vậy: thao tác ghi là **hai pha** để một bản nháp tệ không bao giờ bị gửi nhầm.

### 5 tool

| Tool | Annotations | Hợp đồng |
|---|---|---|
| `list_pending_events` | read-only | `{limit?}` → `{events:[{id, kind:'post_due'\|'comment', summary, ...}]}` |
| `decide` | destructive | `{event_id, action:'skip'\|'reply'\|'publish', text?, reason?, perform?}` → `{ok, decided, performed?}` |
| `verify_facts` | read-only | `{query, draft?}` → `{answer, sources[], supported:boolean}` |
| `schedule_post` | non-destructive | `{brief, at?, cron?, timezone?}` → `{slotId, next, cron}` |
| `recent_activity` | read-only | `{limit?}` → `{decisions[]}` |

`reply` / `publish` **bắt buộc** có `text`. `skip` thì không. Publish một event comment hoặc reply một event `post_due` sẽ không sinh ra `performed` — `decide` kiểm tra `kind`.

Event `post_due` còn mang `slotId`, `occurrence` (khung thời gian nó đại diện) và `cron`. `occurrence` là thứ khiến việc lặp lại dedup được — xem §5.

---

## 3. Mô hình dữ liệu

State nằm trong `data/state.json` (ghi nguyên tử: temp + rename, có retry):

```jsonc
{
  "seq": 0,
  "events":  [],   // chờ quyết định, bị decide() tiêu thụ
  "history": [],   // event đã quyết, audit trail, không bao giờ xoá
  "inbound": [],   // comment đã thấy, kèm cờ handled
  "outbox":  []    // những gì mock đã đăng/trả lời
}
```

`data/log.jsonl` là log append-only (`{type:'event'|'decision'|'poll_error'|'engine_error', ...}`).
`data/inbox.json` là "feed comment mới" của nền tảng mock — đóng vai webhook/inbox API thật.

**Bất biến:** một event id xuất hiện trong `events` tối đa một lần, và khi đã quyết thì chuyển sang `history`. `decide` với id lạ/đã quyết sẽ ném lỗi.

---

## 4. Nối vào nền tảng thật

Chỉ `src/adapters.mjs` thay đổi. `config.json` chọn cách hiện thực:

```json
{ "social": { "kind": "http", "url": "http://127.0.0.1:9000/social", "token": "..." } }
```

Bridge phải nhận `POST` và trả lời 3 op:

| op | request | response |
|---|---|---|
| `publish` | `{text, media}` | `{id}` |
| `reply` | `{comment_id, text}` | `{id}` |
| `comments` | `{since}` | `{comments:[{id, author, text, post_id, at}]}` |

`kind:"mock"` (mặc định) ghi vào `state.outbox` và đọc comment từ `data/inbox.json`.
Hợp đồng này chính là **seam**: Eclincher, Buffer, Postiz, scheduler tự viết, hay một MCP server khác đều lắp vừa.

### Knowledge / grounding (chống bịa)

```json
{ "knowledge": { "kind": "http", "url": "http://127.0.0.1:9100/kb", "token": "..." } }
```

Bridge: `POST {query}` → `{answer, sources:[{title, url?}]}`.
Đây là chỗ lắp NotebookLM (đã đấu thành MCP, hoặc bọc HTTP) — model hỏi tài liệu trước khi trả lời.

`kind:"file"` (mặc định) chấm điểm từng dòng trong `docs/*.md` theo trùng khớp từ khoá — không cần embedding, không cần mạng. Thả file vào `docs/` là grounding chạy được ngay.

`supported` được tính: **≥ 35%** số từ trong draft dài hơn 4 ký tự xuất hiện trong đoạn văn lấy về. Đây là **heuristic**, không phải kiểm chứng thật — xem §7.

---

## 5. Ngữ nghĩa lịch đăng

- `schedule_post` thêm slot vào `schedule.posts` và **gọi tick engine ngay**, nên slot có `at` đã qua sẽ hiện tức thì thay vì chờ tới `pollSeconds`.
- Mỗi tick (mặc định 60s, `schedule.pollSeconds`) phát `post_due` cho slot chưa có event/đã quyết.
- Nội dung do **model viết tại thời điểm cháy**, nên bài không bao giờ cũ — đó là lý do slot giữ `brief` (ý định) chứ không giữ `text`.

### Một lần vs cron

| `cron` | Hành vi |
|---|---|
| bỏ trống | Cháy **một lần duy nhất**, tại `at`. Đăng xong là hết. |
| biểu thức 5 field | Cháy mỗi phút khớp lịch trong `timezone`, không bao giờ trước `at`. |

```
cron = "phút giờ ngày-trong-tháng tháng thứ-trong-tuần"
"0 9 * * *"       → 09:00 mỗi ngày
"0 9 * * 1,3,5"   → 09:00 thứ 2/4/6    (0=Chủ nhật, 1=thứ 2)
"*/15 8-18 * * *" → mỗi 15 phút, 08:00–18:45
```

`dueOccurrence(slot, now, tz)` trong `src/engine.mjs` là **nơi duy nhất** quyết định *khi nào*. Việc parse giao cho `cron-parser` (xử lý DST thật, range, step, tên thứ) — **đừng tự viết lại parser cron**. Với slot cron nó trả về **occurrence gần nhất ≤ now**, và không bao giờ sớm hơn `at`.

**Các lần bị lỡ được gộp thành MỘT event — cố ý.** Server tắt 5 ngày thì slot daily chỉ bắn **1** `post_due` lúc khởi động, không phải 5. Đăng bù 5 bài liên tiếp không bao giờ là thứ người dùng muốn từ một tài khoản mạng xã hội.

Dedup theo **từng occurrence**: event mang `occurrence`, history ghi lại, nên cùng một khung không bị bắn hai lần trong khi các khung sau vẫn cháy bình thường.

Hai chi tiết của parser dễ sai, cả hai đã được xử lý:

- `prev()` của `cron-parser` **loại trừ** `currentDate`, nên hỏi đúng 09:00:00 với `"0 9 * * *"` sẽ trả về **hôm qua**. Engine parse từ `now + 1000ms` để mốc biên được tính là đã tới.
- Chỉ nhận biểu thức **5 field**. Dạng 6 field đối với parser có nghĩa là "có giây", trong khi server này lên lịch theo phút — nên `schedule_post` từ chối luôn.

`timezone` lấy từ `schedule.timezone` trong `config.json`, rồi tới timezone của máy. Cả parser và `Intl` đều kiểm tra, nên gõ sai là fail ngay lúc `schedule_post` chứ không tạo ra slot không bao giờ cháy.

---

## 6. Chạy & kiểm tra

```bash
npm install
npm start          # HTTP, http://127.0.0.1:8787/mcp  (+ /health)
npm run stdio      # stdio cho client local
npm test           # e2e, cần server đang chạy
```

Windows: dùng `start.cmd` (giữ cửa sổ mở — đóng là server chết).

`test/e2e.mjs` là test duy nhất và phủ toàn bộ đường đi: handshake, `tools/list`, grounding cả **đúng** và **sai**, nhặt comment, publish, reply, skip, gộp lần lỡ, dedup theo occurrence, auth (tuỳ chọn), audit trail, health. Nó nói chuyện qua **HTTP thật với process thật** — không mock tầng MCP.

Chạy hai lần để phủ cả auth:

```bash
node test/e2e.mjs                          # 17 check, không token
SAM_TOKEN=secret node test/e2e.mjs         # 18 check, có case 401
```

### Bí mật (token)

Token được đọc theo thứ tự: biến môi trường → `config.local.json` (gitignore) → `config.json`:

| Biến | Tác dụng |
|---|---|
| `SAM_TOKEN` | Bearer token bắt buộc trên `/mcp`. Không set hoặc `CHANGE_ME` = tắt auth (chỉ dùng khi dev local). |
| `SAM_PORT` | Đổi cổng (mặc định 8787). |
| `SAM_PUBLIC_HOST` | Host công khai ghi vào `instructions` cho client. |

```powershell
$env:SAM_TOKEN = 'chuoi-ngau-nhien-dai'
node src\server.mjs
```

Auth được enforce **một lần, ở tầng HTTP**. Không có tham số `token` trong từng tool — MCP client gửi credential qua header `Authorization`, **không bao giờ** nhét vào tool arguments, nên tham số đó chỉ có thể fail.

---

## 7. Giới hạn có chủ đích (đừng "sửa" bằng cách đoán)

| Giới hạn | Vì sao có | Nâng cấp đúng cách |
|---|---|---|
| `token` mặc định `CHANGE_ME` = tắt auth | tiện dev local | set `SAM_TOKEN` trước khi mở tunnel; thêm OAuth 2.1 + `/.well-known/oauth-protected-resource` nếu nhiều người dùng |
| `supported` là trùng khớp từ | không thêm dependency, chạy offline | thay bằng kiểm tra ngữ nghĩa/LLM-as-judge, giữ nguyên shape trả về |
| `every_days` là khoảng ngày, không phải cron | "đăng mỗi ngày" không cần parser cron | xong — thay bằng `cron` qua `cron-parser`, xem §5 |
| Dùng file JSON thay vì DB | một người dùng, state nhỏ | chỉ thay `src/store.mjs`; giữ nguyên chữ ký `save()`/`pushEvent`/`takeEvent` |
| HTTP stateless (không session, không SSE streaming) | cách đơn giản nhất ChatGPT chấp nhận | dùng `StreamableHTTPServerTransport` có session id nếu cần streaming |
| `inbox.json` mock | chưa có inbox API thật | `social.kind:"http"` |

---

## 8. Ghi chú vận hành — học bằng cách trả giá

- **Tuyệt đối không chạy trong thư mục được OneDrive sync.** OneDrive giữ lock file; lệnh ghi state ném lỗi trong callback timer, thành unhandled rejection, và **giết process im lặng sau vài phút**. `save()` giờ có retry, nhưng cách sửa thật là dùng đường dẫn không sync (`D:\` trên máy này).
- `setInterval(asyncFn)` không nuốt lỗi: một rejection ở đó **kết liễu Node theo mặc định**. Engine bọc từng bước trong try/catch, và `server.mjs` cài `unhandledRejection` / `uncaughtException` vì đây là daemon chạy dài.
- Khởi động nền trên Windows sống sót qua shell đã đóng:
  `cmd /c start "" /b node src\server.mjs`

---

## 9. Nối với ChatGPT web

Yêu cầu (theo tài liệu OpenAI): endpoint **HTTPS công khai** phục vụ **streamable HTTP** ở path dạng `/mcp`; `localhost` không truy cập được.

```powershell
cloudflared tunnel --url http://127.0.0.1:8787   # -> https://<random>.trycloudflare.com
```

Sau đó: <https://chatgpt.com/plugins> → `+` → **Add custom MCP server** → URL `https://<random>.trycloudflare.com/mcp` → **Create as a plugin**.

Nếu server có `SAM_TOKEN`, connector phải gửi `Authorization: Bearer <token>` — khai báo lúc thêm connector, không thì mọi call bị 401.

Production: dùng **OpenAI Secure MCP Tunnel** (`tunnel-client`, chỉ outbound) hoặc một endpoint HTTPS cố định. Quick tunnel chỉ để dev.

---

## 10. Bản đồ file

```
src/server.mjs    điểm vào, chọn transport, nạp env/config, auth HTTP, bắt lỗi process
src/tools.mjs     5 tool MCP + zod schema
src/engine.mjs    dueOccurrence()/validateCron() + timer: slot tới giờ + poll comment -> events
src/adapters.mjs  Social (publish/reply/comments) + Knowledge (grounding)  <- seam để mở rộng
src/store.mjs     lưu JSON, ghi nguyên tử có retry, log append-only
config.json       cổng, loại adapter, các slot lịch (commit; không chứa bí mật)
config.local.json override tuỳ chọn, gitignore (token nằm đây hoặc trong SAM_TOKEN)
docs/*.md         corpus grounding cho verify_facts
test/e2e.mjs      test tích hợp toàn đường đi
```