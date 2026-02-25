# LinkMind — Project Summary

## What Is This

LinkMind 是一个基于 Telegram Bot 的智能链接收藏和分析工具。用户把链接发给 Bot，自动抓取网页内容、生成中文摘要、通过向量搜索发现相关内容，生成 insight。附带 Web 界面浏览。

## Monorepo Structure

pnpm workspace，三个包：

```
linkmind/
├── core/       @linkmind/core    — 共享类型和工具函数
├── server/     @linkmind/server  — 云端服务（Bot + Pipeline + Web）
└── probe/      @linkmind/probe   — 本地抓取 daemon（SSE 连接云端）
```

- `core/` — `ScrapeData`, `ScrapeRequestEvent`, `ScrapeResultPayload`, `UrlType` 类型定义；`htmlToSimpleMarkdown()`, `isTwitterUrl()` 工具函数。无运行时依赖，直接暴露 TS 源码（tsx 解析）。
- `server/` — Telegram Bot、Pipeline（scrape → summarize → embed → related → insight）、Express Web 界面、Probe SSE 事件分发。
- `probe/` — 本地 daemon，通过 SSE 接收抓取任务（Twitter via bird CLI、Web via Playwright + Defuddle），结果 POST 回云端。

## Tech Stack

- **Runtime**: Node.js >= 22, TypeScript (tsx)
- **Package Manager**: pnpm (workspace)
- **Bot**: Telegram Bot API (grammy)
- **Web Scraping**: Playwright + Defuddle
- **LLM**: OpenAI 兼容 API
- **Database**: PostgreSQL (Neon) + Kysely ORM + pgvector
- **Web**: Express + EJS
- **Twitter**: bird CLI
- **Durable Execution**: Absurd SDK

## Architecture

```
                          Cloud (SaaS) — @linkmind/server
┌──────────────────────────────────────────────────────────────┐
│  Telegram Bot ──▶ Pipeline ──▶ PostgreSQL (Neon)             │
│  Web UI (Express+EJS)    │       - links, users, invites     │
│                          │       - probe_events, probe_devices│
│                          ▼       - link_relations            │
│                    SSE Server ◀── Auth: Bearer token          │
└──────────────────────────┬───────────────────────────────────┘
                           │ Events (SSE) ↓  Results (POST) ↑
┌──────────────────────────┴───────────────────────────────────┐
│               Local — @linkmind/probe                        │
│  linkmind-probe daemon                                       │
│    ├── bird CLI (Twitter/X, Chrome cookies)                   │
│    └── Playwright + Defuddle (Web)                            │
└──────────────────────────────────────────────────────────────┘
```

**Pipeline 流程 (process-link)：**

```
Step 1: scrape
  ├─ Probe 数据已有 → 直接使用
  ├─ Twitter URL → 创建 probe_event (url_type: twitter) → waiting_probe → return
  └─ 普通 URL → scrapeStepWithFallback:
      1. Playwright + Defuddle
      2. 字数 < 200? → Playwright 重试
      3. 仍不足? → Firecrawl API (FIRECRAWL_API_KEY)
      4. 仍不足? → Probe fallback (url_type: browser) → waiting_probe → return

Step 2: summarize (LLM)
  → 输出 { valid_content, summary, tags }
  → valid_content: false? → Step 2.5

Step 2.5: re-scrape + re-summarize (仅当 valid_content=false)
  → scrapeStepWithFallback(skipPlaywright=true): 只走 Firecrawl → Probe
  → 重新 summarize

Step 3: embed (向量化 summary)
Step 4: related (向量搜索相关 records)
Step 5: insight (LLM，基于 summary + related links)
```

Probe 等待机制：record 进入 `waiting_probe` 状态，probe 端通过 SSE 接收任务，抓取后 POST 回结果，触发 `handleProbeResult()` 恢复 pipeline。

## Common Commands

```bash
# 安装依赖
pnpm install

# 类型检查（server + probe）
pnpm typecheck

# 运行测试
pnpm test

# 启动 server（开发）
pnpm --filter @linkmind/server run dev

# 启动 probe（开发）
pnpm --filter @linkmind/probe run dev -- run --foreground
```

## 部署

- 部署配置**不在本仓库**，位于 OpenClaw workspace 的 `deploy/` 目录下
- 使用 **Ansible** 管理所有部署操作，playbook 和 roles 都在 `deploy/ansible/`
- 服务器：hh-hk-01 (103.69.129.33:1122)
- 所有与部署相关的改动都在 workspace 的 `deploy/` 目录进行，不要在本仓库创建部署文件

### Deployment — launchd (本地开发)

Server 通过 macOS launchd 作为 user agent 运行。

**plist 路径**: `~/Library/LaunchAgents/com.linkmind.plist`

```bash
# 加载 / 卸载
launchctl load ~/Library/LaunchAgents/com.linkmind.plist
launchctl unload ~/Library/LaunchAgents/com.linkmind.plist

# 启动 / 停止
launchctl start com.linkmind
launchctl stop com.linkmind

# 查看日志
tail -f ~/Code/linkmind/data/launchd-stdout.log
tail -f ~/Code/linkmind/data/launchd-stderr.log
```

注意：`KeepAlive=true`，`launchctl stop` 后会自动重启，彻底停止需 `unload`。

## 生产数据维护

- **禁止对生产环境执行裸 SQL 操作**
- 所有数据维护必须通过 `server/scripts/admin-*.ts` 脚本完成
- 流程：
  1. 在 `server/scripts/` 下编写 TypeScript 脚本，调用项目内部函数
  2. 先用本地 `.env` 测试
  3. 确认无误后，使用 `.env.prod` 对生产环境执行：
     ```bash
     cd server
     npx tsx --env-file=.env.prod scripts/admin-xxx.ts <args>
     ```
- `.env.prod` 包含生产环境配置，已在 `.gitignore` 中，不会提交到仓库

## Admin API

Admin 接口使用 `ADMIN_TOKEN` 环境变量认证，请求需带 `Authorization: Bearer <ADMIN_TOKEN>` header。

**可用接口：**

```bash
# 测试抓取（同步，返回完整结果）
curl -X POST http://localhost:<port>/api/admin/test-scrape \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'

# 重试 record pipeline（异步，返回 taskId）
curl -X POST http://localhost:<port>/api/admin/retry/<record_id> \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

- `ADMIN_TOKEN` 配置在 `server/.env`（本地）和 `server/.env.prod`（生产）
- 未配置时返回 503

## 管理脚本

```bash
# 创建邀请码
pnpm --filter @linkmind/server exec tsx scripts/create_invite.ts
pnpm --filter @linkmind/server exec tsx scripts/create_invite.ts --max-uses 10

# 列出邀请码
pnpm --filter @linkmind/server exec tsx scripts/list_invites.ts
```
