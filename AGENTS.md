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

- `core/` — `ScrapeData`, `ScrapeRequestEvent`, `ScrapeResultPayload`, `UrlType` 类型定义；`htmlToSimpleMarkdown()`, `isTwitterUrl()` 工具函数。无运行时依赖，通过条件 exports 暴露：`types` 条件指向 `.ts` 源码（IDE/typecheck），`default` 条件指向 `dist/` 编译产物（运行时）。
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

# 构建（core + server）
pnpm build

# 类型检查（server + probe）
pnpm typecheck

# 运行测试
pnpm test

# 启动 server（开发，tsx）
pnpm --filter @linkmind/server run dev

# 启动 server（生产，需先 build）
cd server && node dist/index.js

# 启动 probe（开发）
pnpm --filter @linkmind/probe run dev -- run --foreground

# CLI 脚本（开发，tsx 直接运行）
cd server && npx tsx src/cli.ts <command> [args]

# CLI 脚本（编译后）
cd server && node dist/cli.js <command> [args]

# 列出所有可用 CLI 命令
cd server && node dist/cli.js
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
- 所有数据维护必须通过 `server/src/cli/admin-*.ts` 脚本完成
- 流程：
  1. 在 `server/src/cli/` 下编写 TypeScript 脚本，调用项目内部函数
  2. 先用本地 `.env` 测试
  3. 确认无误后，使用 `.env.prod` 对生产环境执行：
     ```bash
     cd server
     # 开发环境（tsx 直接运行）
     npx tsx --env-file=.env.prod src/cli.ts <command> <args>
     # 或编译后
     node --env-file=.env.prod dist/cli.js <command> <args>
     ```
- `.env.prod` 包含生产环境配置，已在 `.gitignore` 中，不会提交到仓库

## 生产 Migration 安全验证流程

在生产环境执行 migration 前，先在本地复制生产数据库进行验证。

### 步骤

```bash
# 1. 复制生产数据库到本地（需要本地 PostgreSQL 运行中）
#    脚本读取 server/.env.prod 中的 DATABASE_URL，dump 后 restore 到本地
#    注意：需要 superuser (reorx) 创建数据库和安装 pgvector 扩展
export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"
LOCAL_DB="linkmind_pro_$(date +%Y%m%d)"

# dump 生产数据
pg_dump "$(grep '^DATABASE_URL=' server/.env.prod | sed 's/^DATABASE_URL=//')" \
  --format=custom --no-owner --no-privileges -f /tmp/${LOCAL_DB}.dump

# 创建本地数据库（superuser）+ 安装 pgvector
psql -U reorx -h localhost -p 5432 -d postgres -c "CREATE DATABASE \"${LOCAL_DB}\" OWNER linkmind;"
psql -U reorx -h localhost -p 5432 -d ${LOCAL_DB} -c "CREATE EXTENSION IF NOT EXISTS vector;"

# restore（pg_search/BM25 相关错误可忽略，本地没有 ParadeDB）
pg_restore --no-owner --no-privileges -U reorx -h localhost -p 5432 -d ${LOCAL_DB} /tmp/${LOCAL_DB}.dump

# 授权给 linkmind 用户
psql -U reorx -h localhost -p 5432 -d ${LOCAL_DB} -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO linkmind; GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO linkmind;"

# 2. 在本地副本上执行 migration 验证
cd server
DATABASE_URL="postgresql://linkmind@localhost:5432/${LOCAL_DB}" node dist/cli.js run-sql migrations/005_xxx.sql
# 或 Kysely migration:
DATABASE_URL="postgresql://linkmind@localhost:5432/${LOCAL_DB}" node dist/cli.js migrate

# 3. 检查结果
psql -U linkmind -h localhost -p 5432 -d ${LOCAL_DB} -c "\d <new_table>"
# 以及测试 CLI 等功能是否正常

# 4. 确认无误后，在生产环境执行
ssh hh-hk-01 "cd /opt/apps/linkmind && docker compose exec -w /app/server server node dist/cli.js run-sql migrations/005_xxx.sql"
# 或 Kysely migration:
ssh hh-hk-01 "cd /opt/apps/linkmind && docker compose exec -w /app/server server node dist/cli.js migrate"
```

### 注意事项

- 本地 PostgreSQL 客户端路径：`/opt/homebrew/opt/postgresql@18/bin/`
- linkmind 用户没有 createdb 权限，需要用 reorx superuser 创建数据库
- pg_search (ParadeDB BM25) 本地没有，restore 时相关错误可忽略
- 生产环境 docker compose 路径：`/opt/apps/linkmind/`
- 执行 CLI 需要 `-w /app/server` 指定工作目录

## Database Migration

使用 Kysely 的 Migrator 框架管理数据库 schema 变更。

**历史基线：** `server/migrations/` 下的 SQL 文件（001-005）是项目早期的手动 migration，不受 Kysely 管理。对于全新数据库，必须先执行这些 SQL 文件建立基线 schema，然后再运行 Kysely migration。

**新 migration 写法：** 在 `server/src/db/migrations/` 下创建 TypeScript 文件，命名格式 `YYYY-MM-DDTHHMM-description.ts`，使用 raw SQL：

```ts
import { type Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE records ADD COLUMN foo TEXT`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  // forward-only, no rollback
}
```

**执行 migration：**

```bash
# 本地（使用 .env，开发模式）
cd server && npx tsx src/cli.ts migrate

# 本地（编译后）
cd server && node dist/cli.js migrate

# 本地（使用 .env.prod 对生产执行）
cd server && node --env-file=.env.prod dist/cli.js migrate

# Docker（生产服务器）
docker compose exec server node dist/cli.js migrate
```

**执行独立 SQL 文件：**

```bash
# 本地
cd server && node dist/cli.js run-sql <sql-file-path>

# Docker（生产服务器）
docker compose exec server node dist/cli.js run-sql <sql-file-path>
```

**新数据库初始化（三步）：**

1. 执行 `server/migrations/` 下的 SQL 基线文件（001_init.sql 到 005_share_records.sql），注意 002_bm25_index.sql 是可选的（需要 ParadeDB 扩展）
2. 运行 migration：`cd server && node dist/cli.js migrate`（Kysely 自动创建 migration 追踪表并执行所有新 migration）
3. 执行 Absurd SQL：`cd server && node dist/cli.js run-sql sql/absurd.sql`，然后 `SELECT absurd.create_queue('linkmind')`

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

## API 测试

用户 API（`/api/links` 等）通过 cookie 中的 JWT token 认证（cookie 名 `lm_session`）。本地测试时，可用脚本生成 token：

```bash
# 生成指定用户的 JWT token（7天有效期）
cd server && npx tsx src/cli.ts gen-token <username>

# 使用生成的 token 调用 API
curl http://localhost:3456/api/links -b "lm_session=<token>"

# 添加链接
curl -X POST http://localhost:3456/api/links \
  -b "lm_session=<token>" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

## 管理脚本

所有脚本通过统一 CLI 入口调用，脚本源码在 `server/src/cli/`。

```bash
# 列出所有可用命令
cd server && node dist/cli.js

# 创建邀请码
cd server && npx tsx src/cli.ts create-invite
cd server && npx tsx src/cli.ts create-invite --max-uses 10

# 列出邀请码
cd server && npx tsx src/cli.ts list-invites
```
