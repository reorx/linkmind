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

**Pipeline 流程：**
- 普通 URL：scrape（云端 Playwright）→ summarize → embed → related → insight
- Twitter URL 或需要本地环境：创建 probe_event → SSE 推送给 probe → probe 抓取 → POST 回结果 → resume pipeline

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

## Deployment — launchd

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

## 管理脚本

```bash
# 创建邀请码
pnpm --filter @linkmind/server exec tsx scripts/create_invite.ts
pnpm --filter @linkmind/server exec tsx scripts/create_invite.ts --max-uses 10

# 列出邀请码
pnpm --filter @linkmind/server exec tsx scripts/list_invites.ts
```
