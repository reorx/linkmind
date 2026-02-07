# linkmind-probe 设计方案

## 概述

linkmind-probe 是一个运行在用户本地的 Python daemon，负责执行需要本地环境的抓取任务（Twitter via bird、网页 via Playwright）。它通过 SSE (Server-Sent Events) 与云端 SaaS 保持连接，接收抓取事件，完成后将结果上传。

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
│     │  bird CLI       │          │  vibe-reader    │            │
│     │ (Twitter/X)     │          │  (Playwright)   │            │
│     │ Chrome cookies  │          │  local browser  │            │
│     └─────────────────┘          └─────────────────┘            │
└─────────────────────────────────────────────────────────────────┘
```

## 组件设计

### 1. linkmind-probe (Python)

**目录结构：**
```
linkmind-probe/
├── pyproject.toml
├── src/
│   └── linkmind_probe/
│       ├── __init__.py
│       ├── cli.py          # CLI 入口 (login, run, status)
│       ├── daemon.py       # SSE 连接 + 事件处理
│       ├── auth.py         # 认证逻辑
│       ├── scrapers/
│       │   ├── twitter.py  # bird CLI wrapper
│       │   └── web.py      # vibe-reader/Playwright
│       └── config.py       # 配置管理
└── tests/
```

**CLI 命令：**
```bash
linkmind-probe login             # 浏览器认证
linkmind-probe run               # 后台启动 daemon
linkmind-probe run --foreground  # 前台运行（调试用）
linkmind-probe stop              # 停止 daemon
linkmind-probe status            # 检查运行状态
linkmind-probe logout            # 清除 token
```

**状态目录：** `~/.linkmind-probe/`
```
~/.linkmind-probe/
├── config.json      # 配置 + token
├── linkmind-probe.pid   # PID 文件
└── linkmind-probe.log   # 日志文件
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

## Daemon 实现 (参考 vibefs)

采用与 vibefs 相同的 daemon 模式：

**启动流程 (`run` 命令)：**
```python
def run_daemon():
    """Fork a background process running 'linkmind-probe run --foreground'."""
    log_file = open(LOG_PATH, 'a')
    proc = subprocess.Popen(
        [sys.executable, '-m', 'linkmind_probe', 'run', '--foreground'],
        stdout=log_file,
        stderr=log_file,
        start_new_session=True,  # 脱离终端
    )
    log_file.close()
    time.sleep(0.3)
    if proc.poll() is not None:
        click.echo('Daemon exited immediately, check ~/.linkmind-probe/linkmind-probe.log')
    else:
        click.echo(f'Daemon started (pid {proc.pid})')
```

**前台模式 (`run --foreground`)：**
```python
def run_foreground():
    """Run in foreground, write PID, connect SSE, process events."""
    write_pid()
    atexit.register(remove_pid)
    
    click.echo(f'linkmind-probe running (pid {os.getpid()})')
    
    # SSE 连接 + 事件处理主循环
    asyncio.run(event_loop())
```

**PID 管理：**
```python
PID_PATH = '~/.linkmind-probe/linkmind-probe.pid'

def read_pid() -> int | None:
    try:
        return int(open(PID_PATH).read().strip())
    except:
        return None

def is_running() -> bool:
    pid = read_pid()
    if pid is None:
        return False
    try:
        os.kill(pid, 0)  # 检查进程是否存在
        return True
    except ProcessLookupError:
        remove_pid()
        return False

def stop_daemon() -> bool:
    pid = read_pid()
    if pid is None:
        return False
    try:
        os.kill(pid, signal.SIGTERM)
        return True
    except ProcessLookupError:
        remove_pid()
        return False
```

**与 vibefs 的区别：**
- vibefs 有 auto-cleanup（所有授权过期后自动退出）
- linkmind-probe 持续运行，不自动退出
- linkmind-probe 需要 SSE 断线重连逻辑

## 技术选型

| 组件 | 选择 | 理由 |
|------|------|------|
| CLI 框架 | `click` | 与 vibefs 一致，成熟稳定 |
| HTTP 客户端 | `httpx` | 异步友好，SSE 支持 |
| SSE 客户端 | `httpx-sse` | 轻量，与 httpx 配合 |
| Playwright | `vibe-reader` 库 | 已有封装，复用 |
| Twitter | `bird` CLI subprocess | 成熟方案 |
| Daemon 化 | subprocess.Popen | vibefs 模式，跨平台 |

## 开发计划

### Phase 1: 基础框架
- [ ] Python 项目结构 + CLI 骨架 (click)
- [ ] Daemon 模式 (run/stop/status, PID 管理)
- [ ] Device auth flow (API + 前端页面)
- [ ] 配置文件管理 (~/.linkmind-probe/)

### Phase 2: 通信层
- [ ] SSE server 端 (Node.js/Express)
- [ ] SSE client 端 (Python)
- [ ] 心跳 + 重连逻辑

### Phase 3: 抓取功能
- [ ] Twitter scraper (bird wrapper)
- [ ] Web scraper (vibe-reader)
- [ ] 结果上传

### Phase 4: Pipeline 集成
- [ ] probe_events 表 + 队列逻辑
- [ ] Pipeline 支持 scrapeData 参数
- [ ] receive_result 触发 Pipeline 重跑
- [ ] link.status = 'waiting_probe' 状态

### Phase 5: 用户体验
- [ ] Probe 状态页面 (web)
- [ ] 连接状态通知 (Telegram)
- [ ] 错误重试机制

## 待讨论

1. **Probe 多设备** — 一个用户可以有多个 Probe 吗？如果是，事件发给哪个？
2. **任务队列** — Probe 离线时的事件如何处理？保留多久？
3. **安全** — access_token 是否需要定期刷新？
4. **vibe-reader** — 是否需要 fork 或直接依赖？是 Python 还是 Node？

---

*Last updated: 2026-02-07*
