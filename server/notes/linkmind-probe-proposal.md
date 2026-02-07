# linkmind-probe 设计方案

## 概述

linkmind-probe 是一个运行在用户本地的 Node.js daemon（TypeScript），负责执行需要本地环境的抓取任务（Twitter via bird CLI、网页 via Playwright + Defuddle）。它通过 SSE (Server-Sent Events) 与云端 SaaS 保持连接，接收抓取事件，完成后将结果上传。

**为什么选 Node.js 而非 Python：**
- 直接集成 `defuddle`（npm 包），未来可集成 `vibe-reader`
- 与 linkmind server 共享 scraper 代码（复用 `scraper.ts` 逻辑）
- 同一 runtime/toolchain（TypeScript, pnpm, tsx）
- 单一 `node_modules` 管理 Playwright，无需独立 Python venv

## 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        Cloud (SaaS)                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │ Telegram Bot│───▶│  Pipeline   │───▶│ PostgreSQL (Neon)   │  │
│  │  / Web UI   │    │             │    │  - links            │  │
│  └─────────────┘    └──────┬──────┘    │  - probe_events     │  │
│                            │           └─────────────────────┘  │
│                            ▼                                    │
│                     ┌─────────────┐                             │
│                     │     SSE     │◀──── Auth: Bearer token     │
│                     │   Server    │                             │
│                     └──────┬──────┘                             │
└────────────────────────────┼────────────────────────────────────┘
                             │
                    Events   │   Results
                   (SSE)     │   (HTTP POST)
                      ▼      │      ▲
┌────────────────────────────┼──────┼─────────────────────────────┐
│                     Local  │      │                             │
│                     ┌──────┴──────┴──┐                          │
│                     │ linkmind-probe │                          │
│                     │    (daemon)    │                          │
│                     └───────┬────────┘                          │
│                             │                                   │
│              ┌──────────────┼──────────────┐                    │
│              ▼                             ▼                    │
│     ┌─────────────────┐          ┌─────────────────┐            │
│     │  bird CLI       │          │  Playwright     │            │
│     │ (Twitter/X)     │          │  + Defuddle     │            │
│     │ Chrome cookies  │          │  local browser  │            │
│     └─────────────────┘          └─────────────────┘            │
└─────────────────────────────────────────────────────────────────┘
```

## 组件设计

### 1. linkmind-probe (Node.js/TypeScript)

**目录结构：**
```
linkmind-probe/
├── package.json
├── tsconfig.json
├── .nvmrc                         # v22
├── src/
│   ├── cli.ts                     # CLI entry point (commander)
│   ├── daemon.ts                  # SSE client + event dispatch + daemon lifecycle
│   ├── auth.ts                    # Device authorization flow
│   ├── config.ts                  # Config + PID management (~/.linkmind-probe/)
│   ├── scraper.ts                 # Unified scraper (Twitter via bird, web via Playwright+Defuddle)
│   └── types.ts                   # Shared types (ScrapeData, SSE events)
└── tests/
```

**依赖：**
```json
{
  "dependencies": {
    "commander": "^13.0.0",
    "defuddle": "^0.6.6",
    "playwright": "^1.50.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  }
}
```

关键决策：
- **commander** — 轻量 CLI 框架，TypeScript 支持好
- **Native `fetch`** — Node 22 已有稳定 fetch，无需额外依赖
- **无 SSE 库** — 手动解析 fetch ReadableStream（简单，无额外依赖）
- **playwright + defuddle** — 与 linkmind server 一致
- **无 eventsource polyfill** — 原生 EventSource API 不支持自定义 headers (Authorization)，所以用 fetch + 手动 SSE 解析

**CLI 命令：**
```bash
linkmind-probe login --api-base <url>   # Device auth flow
linkmind-probe run                       # Start daemon (background)
linkmind-probe run --foreground          # Run in foreground
linkmind-probe stop                      # Stop daemon (SIGTERM)
linkmind-probe status                    # Check if running
linkmind-probe logout                    # Clear token
```

**状态目录：** `~/.linkmind-probe/`
```
~/.linkmind-probe/
├── config.json      # { api_base, access_token, user_id }
├── probe.pid        # PID 文件
└── probe.log        # 日志文件 (daemon mode)
```

**配置文件：** `~/.linkmind-probe/config.json`
```json
{
  "api_base": "https://linkmind.example.com",
  "access_token": "lmp_xxxx",
  "user_id": "abc123"
}
```

### 2. 认证流程 (Device Authorization Flow)

类似 GitHub CLI 的体验：

```
┌──────────────────┐         ┌──────────────────┐         ┌──────────────────┐
│  linkmind-probe  │         │   SaaS API       │         │   Browser        │
└────────┬─────────┘         └────────┬─────────┘         └────────┬─────────┘
         │                            │                            │
         │  POST /api/auth/device     │                            │
         │  (request device code)     │                            │
         │───────────────────────────▶│                            │
         │                            │                            │
         │  { device_code, user_code, │                            │
         │    verification_uri,       │                            │
         │    expires_in, interval }  │                            │
         │◀───────────────────────────│                            │
         │                            │                            │
         │  Open browser + print:     │                            │
         │  "Enter code: ABCD-1234"   │                            │
         │─────────────────────────────────────────────────────────▶
         │                            │                            │
         │                            │   User visits              │
         │                            │   /auth/device?code=...    │
         │                            │◀───────────────────────────│
         │                            │                            │
         │                            │   User logs in (if needed) │
         │                            │   + clicks Authorize       │
         │                            │◀───────────────────────────│
         │                            │                            │
         │  Poll: POST /api/auth/token│                            │
         │  { device_code }           │                            │
         │───────────────────────────▶│                            │
         │                            │                            │
         │  (pending... keep polling) │                            │
         │◀───────────────────────────│                            │
         │                            │                            │
         │  Poll again...             │                            │
         │───────────────────────────▶│                            │
         │                            │                            │
         │  { access_token, user_id } │                            │
         │◀───────────────────────────│                            │
         │                            │                            │
         │  ✅ Login successful!      │                            │
         │                            │                            │
```

**为什么选 Device Flow：**
- 不需要在本地起 HTTP server（避免端口冲突、防火墙问题）
- 用户体验清晰：看到 code，打开浏览器，输入/确认
- 安全：token 不经过 URL redirect

### 3. 事件通信 (SSE)

**订阅事件：**
```
GET /api/probe/subscribe_events
Authorization: Bearer lmp_xxxx
Accept: text/event-stream
```

**事件格式 (Server → Probe via SSE)：**
```
event: scrape_request
data: {"event_id":"evt_abc123","url":"https://twitter.com/xxx/status/123","url_type":"twitter","link_id":42,"created_at":"2026-02-07T10:00:00Z"}

event: scrape_request
data: {"event_id":"evt_def456","url":"https://example.com/article","url_type":"web","link_id":43,"created_at":"2026-02-07T10:00:00Z"}

event: ping
data: {}
```

**结果上传 (Probe → Server via HTTP POST)：**
```
POST /api/probe/receive_result
Authorization: Bearer lmp_xxxx
Content-Type: application/json

{
  "event_id": "evt_abc123",
  "success": true,
  "data": {
    "title": "...",
    "content": "...",
    "markdown": "...",
    "og_title": "...",
    "og_description": "...",
    "og_image": "...",
    "og_site_name": "...",
    ...
  }
}
```

**错误情况：**
```json
{
  "event_id": "evt_abc123",
  "success": false,
  "error": "bird CLI failed: cookie expired"
}
```

**心跳：**
- Server 每 30s 发送 `event: ping`
- Probe 60s 无事件判定断开，自动重连（exponential backoff）

### 4. 数据库新增表

```sql
-- Probe 设备注册
CREATE TABLE probe_devices (
  id TEXT PRIMARY KEY,            -- device_id
  user_id TEXT NOT NULL,
  access_token TEXT UNIQUE,       -- lmp_xxxx
  name TEXT,                      -- e.g. "Xiao's MacBook"
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Probe 事件队列
CREATE TABLE probe_events (
  id TEXT PRIMARY KEY,            -- evt_xxx
  user_id TEXT NOT NULL,
  link_id INTEGER REFERENCES links(id),
  url TEXT NOT NULL,
  url_type TEXT NOT NULL,         -- 'twitter' | 'web'
  status TEXT DEFAULT 'pending',  -- 'pending' | 'sent' | 'completed' | 'failed'
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

-- Device auth 临时状态
CREATE TABLE device_auth_requests (
  device_code TEXT PRIMARY KEY,
  user_code TEXT NOT NULL,        -- ABCD-1234
  user_id TEXT,                   -- 填充在用户授权后
  status TEXT DEFAULT 'pending',  -- 'pending' | 'authorized' | 'expired'
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 5. SaaS API 新增端点

| Method | Path | 说明 |
|--------|------|------|
| POST | `/api/auth/device` | 请求 device code |
| POST | `/api/auth/token` | 用 device_code 换 access_token |
| GET | `/auth/device` | 浏览器页面：输入 user_code 并授权 |
| GET | `/api/probe/subscribe_events` | SSE 订阅事件流 |
| POST | `/api/probe/receive_result` | 接收抓取结果 |
| GET | `/api/probe/status` | 检查 probe 状态 |

### 6. Pipeline 改造

**当前流程：**
```
Bot 收到 URL → scrapeStep → summarizeStep → embedStep → relatedStep → insightStep
```

**新流程：**
```
processUrl(url, scrapeData?)
    │
    ├─▶ 如果 scrapeData 已传入：
    │       跳过 scrapeStep，直接用传入的数据
    │       继续 summarizeStep → embedStep → ...
    │
    └─▶ 如果 scrapeData 未传入：
            │
            ├─▶ 判断是否需要 Probe (Twitter 或配置为本地抓取)
            │       创建 probe_event (pending)
            │       更新 link.status = 'waiting_probe'
            │       通过 SSE 推送给 Probe
            │       ⛔ Pipeline 退出，等待 Probe 回调
            │
            └─▶ 不需要 Probe：
                    执行 scrapeStep (云端 Playwright)
                    继续 summarizeStep → embedStep → ...
```

**receive_result 触发重跑：**
```
POST /api/probe/receive_result
    │
    ├─▶ 根据 event_id 找到 probe_event
    ├─▶ 更新 probe_event.status = 'completed', 存储 result
    ├─▶ 根据 link_id 找到对应的 link
    └─▶ 调用 processUrl(link.url, scrapeData) 继续 Pipeline
            └─▶ 因为 scrapeData 已传入，跳过 scrapeStep
```

**Link 状态变化：**
```
pending → waiting_probe → scraped → analyzed
                │
                └─▶ (probe 超时/失败) → failed
```

**Pipeline 函数签名变更：**
```typescript
interface ScrapeData {
  title?: string;
  markdown: string;
  og_title?: string;
  og_description?: string;
  og_image?: string;
  og_site_name?: string;
  // ... 其他 scraper 返回的字段
}

// 原来
async function processUrl(userId: number, url: string): Promise<...>

// 改为
async function processUrl(
  userId: number,
  url: string,
  scrapeData?: ScrapeData  // 如果传入，跳过 scrapeStep
): Promise<...>
```

## Daemon 实现

**SSE 客户端 (native fetch)：**
```typescript
async function connectSSE(config: Config): Promise<void> {
  const res = await fetch(`${config.api_base}/api/probe/subscribe_events`, {
    headers: {
      'Authorization': `Bearer ${config.access_token}`,
      'Accept': 'text/event-stream',
    },
  });

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE: split on \n\n, extract event: and data: fields
    // Dispatch: ping → reset heartbeat timer, scrape_request → spawn scrape task
  }
}
```

**重连逻辑：**
- Exponential backoff: 5s → 10s → 20s → 40s → 60s (max)
- 成功连接后重置 backoff
- Heartbeat timeout: 60s 无事件 → 重连

**Daemon lifecycle：**
- `runForeground(config)`: write PID, register SIGTERM/SIGINT handlers, run SSE loop
- `runDaemon(config)`: spawn `node --import tsx src/cli.ts run --foreground` as detached child, redirect stdout/stderr to log file

**PID 管理：**
- `loadConfig()` / `saveConfig(config)` — 读写 `config.json`
- `writePid()` / `removePid()` / `readPid()` — PID 文件管理
- `isRunning()` — 通过 `process.kill(pid, 0)` 检查进程是否存活
- `stopDaemon()` — 发送 SIGTERM

**与 vibefs 的区别：**
- vibefs 有 auto-cleanup（所有授权过期后自动退出）
- linkmind-probe 持续运行，不自动退出
- linkmind-probe 需要 SSE 断线重连逻辑

## 技术选型

| 组件 | 选择 | 理由 |
|------|------|------|
| CLI 框架 | `commander` | 轻量，零依赖，TypeScript 支持好 |
| HTTP 客户端 | Native `fetch` | Node 22 内置稳定 fetch，无需额外依赖 |
| SSE 客户端 | 手动解析 fetch ReadableStream | 简单，无需额外依赖；原生 EventSource 不支持自定义 headers |
| Web 抓取 | `playwright` + `defuddle` | 与 linkmind server 一致，可复用 scraper 代码 |
| Twitter | `bird` CLI subprocess | 成熟方案（与 Python 版相同） |
| Daemon 化 | `child_process.spawn` (detached) | Node.js 原生，跨平台 |
| 包管理 | `pnpm` + `package.json` | 与 linkmind server 一致 |

## 开发计划

### Step 1: 项目初始化 + Config + CLI 骨架
- [ ] pnpm init, tsconfig, .nvmrc
- [ ] 实现 `config.ts` (PID 管理, config 读写)
- [ ] 实现 `cli.ts` 所有命令 (commander, stubs for auth/daemon)
- [ ] 验证 `linkmind-probe status` 可用

### Step 2: Auth Flow
- [ ] 实现 `auth.ts` (device auth with native fetch)
- [ ] 接入 `linkmind-probe login`
- [ ] 对接 linkmind server 测试

### Step 3: Scraper
- [ ] 从 server 的 `scraper.ts` 复制并适配 `scrapeTwitter()`
- [ ] 从 server 的 `scraper.ts` 复制并适配 `scrapeUrl()` + `htmlToSimpleMarkdown()`
- [ ] 统一为 `scraper.ts`，返回 `ScrapeData`

### Step 4: Daemon + SSE
- [ ] 实现 SSE parser (native fetch + ReadableStream)
- [ ] 实现事件循环 + 重连逻辑
- [ ] 实现结果上传
- [ ] 接入 daemon 模式 (foreground + background)
- [ ] 端到端测试：发 Twitter URL → probe 收到事件 → 抓取 → 上传结果 → pipeline 继续

**注意：** Server 端代码（web.ts, pipeline.ts, db.ts）已实现所有所需端点和 DB 表，无需修改。Node.js probe 是 Python probe 的 drop-in replacement，API 合约相同。

## 待讨论

1. **Probe 多设备** — 一个用户可以有多个 Probe 吗？如果是，事件发给哪个？
2. **任务队列** — Probe 离线时的事件如何处理？保留多久？
3. **安全** — access_token 是否需要定期刷新？

---

*Last updated: 2026-02-07*
