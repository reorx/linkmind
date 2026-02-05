# LinkMind

LinkMind 是一个基于 Telegram Bot 的智能链接收藏和分析工具。把链接发给 Bot，它会自动抓取网页内容、生成中文摘要、在你的笔记库中搜索相关内容，并输出有价值的 insight。

## 为什么做这个

日常浏览中我们会遇到大量想读或值得保存的文章，但缺少一个好的方式来管理和回顾它们。LinkMind 的核心想法是：

- 把想读的链接发给 Telegram Bot，自动完成抓取和存档
- 利用 [QMD](https://github.com/tobi/qmd) 将本地笔记库变成可语义搜索的知识库，让 AI 找到与文章相关的笔记和历史链接
- 有了丰富的上下文后，生成更有价值的摘要和 insight

## 功能

- **链接收藏** — 发送 URL 给 Telegram Bot，自动抓取网页内容并存档
- **智能摘要** — LLM 生成中文摘要和标签
- **关联发现** — 在笔记库和历史链接中搜索相关内容，生成个人化的 insight
- **Web 界面** — 时间线形式浏览所有链接，详情页展示摘要、insight、原文和相关内容
- **笔记联动** — 详情页可直接打开相关笔记，定位到具体产生共鸣的段落
- **去重处理** — 重复提交的链接会自动识别并重新处理，不会创建重复记录
- **Twitter/X 支持** — 通过 [bird](https://github.com/nichochar/bird-cli) CLI 抓取推文内容

## 架构

```
Telegram Bot (bot.ts)
    ↓ 用户发送链接
Pipeline (pipeline.ts)
    ├── [抓取]  Playwright + Defuddle → 网页内容提取 (scraper.ts)
    ├── [分析]  LLM 生成摘要 + 标签 + insight (agent.ts)
    │     └── QMD 语义搜索相关笔记和历史链接 (search.ts)
    └── [导出]  Markdown 文件导出 + QMD 索引更新 (export.ts)
    ↓
Web Server (web.ts)
    ├── /           时间线首页（分页）
    ├── /link/:id   链接详情页（双栏布局）
    └── /note       笔记查看器
```

### 数据流

1. Bot 从 Telegram 消息中提取 URL（支持一条消息包含多个链接）
2. 检查是否已存在该 URL，重复则更新而非新建
3. **抓取阶段**：Playwright 无头浏览器加载页面，提取 OG 元数据，Defuddle 提取正文，转换为 Markdown
4. **分析阶段**：LLM 生成摘要和标签；通过 QMD 搜索相关笔记和历史链接，结合上下文生成 insight
5. **导出阶段**：生成 Markdown 文件写入磁盘，触发 QMD 重新索引
6. Bot 将结果（摘要、insight、相关内容）发送回 Telegram；Web 界面提供永久访问页面

## 前置依赖

- **Node.js** >= 22
- **pnpm** — 包管理器
- **Playwright 浏览器** — 运行 `pnpm exec playwright install chromium` 安装
- **[QMD](https://github.com/tobi/qmd)** — 本地知识库搜索引擎，用于语义搜索笔记和链接
- **LLM API** — 支持 OpenAI 兼容 API（如 Qwen/DashScope、OpenAI 等）或 Google Gemini
- **[bird](https://github.com/nichochar/bird-cli)** CLI（可选）— 用于抓取 Twitter/X 内容

## 部署

### 1. 安装

```bash
git clone https://github.com/reorx/linkmind.git
cd linkmind
pnpm install
pnpm exec playwright install chromium
```

### 2. 创建 Telegram Bot

1. 在 Telegram 中找到 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot`，按照指引创建 Bot
3. 获取 Bot Token

### 3. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件，填入必要的配置：

```bash
# Telegram Bot（必填）
TELEGRAM_BOT_TOKEN=your_bot_token_here

# LLM 配置（二选一）
LLM_PROVIDER=openai          # openai 或 gemini

# OpenAI 兼容 API
OPENAI_API_KEY=your_key
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
OPENAI_DEFAULT_MODEL=qwen-plus

# 或 Google Gemini
# GEMINI_API_KEY=your_key
# GEMINI_MODEL=gemini-2.0-flash

# Web 服务
WEB_PORT=3456
WEB_BASE_URL=https://your-domain.com  # Bot 发送的永久链接地址

# QMD 知识库
QMD_NOTES_COLLECTION=notes    # 笔记集合名
QMD_LINKS_COLLECTION=links    # 链接集合名
QMD_LINKS_PATH=~/LocalDocuments/linkmind/links  # 导出文件路径
```

### 4. 配置 QMD

确保 [QMD](https://github.com/tobi/qmd) 已安装，然后添加集合并完成初始化：

```bash
# 添加笔记库集合（指向你的 Obsidian 或其他笔记目录）
qmd collection add /path/to/your/notes --name notes

# 添加链接库集合（与 .env 中 QMD_LINKS_PATH 一致）
qmd collection add ~/LocalDocuments/linkmind/links --name links

# 索引并生成向量嵌入
qmd embed

# 测试搜索功能（首次运行会触发 reranker 模型下载）
qmd vsearch test
```

### 5. 配置公开访问地址

Telegram Bot 推送的消息中包含"查看完整分析"的链接，指向 Web 详情页。为了能点开这些链接，**必须为服务配置一个可访问的公开 URL**（即 `WEB_BASE_URL`）。

两种方式：

- **本地开发**：使用 [localias](https://github.com/peterldowns/localias) 等工具，通过修改 hosts 将一个合法域名指向本地服务，如 `http://linkmind.local:3456`
- **公网访问**：使用 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) 将本地服务暴露到公网，获取一个可访问的 URL。这种方式更方便日常使用，但注意要对 Tunnel 做好认证保护

### 6. 启动服务

```bash
pnpm dev
```

服务启动后会同时运行 Telegram Bot 和 Web 服务器。

### 7. 用 launchd 常驻（macOS）

项目提供了 launchd plist 文件 [`deploy/com.linkmind.plist`](deploy/com.linkmind.plist)，用于在 macOS 上以 daemon 方式运行。

**安装：**

```bash
# 复制 plist 到 LaunchAgents 目录
cp deploy/com.linkmind.plist ~/Library/LaunchAgents/

# 加载并启动服务
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.linkmind.plist
```

**日常控制：**

```bash
# 查看服务状态
launchctl print gui/$(id -u)/com.linkmind

# 停止服务
launchctl bootout gui/$(id -u)/com.linkmind

# 启动服务
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.linkmind.plist

# 重启服务（停止 + 启动）
launchctl bootout gui/$(id -u)/com.linkmind && \
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.linkmind.plist
```

**日志位置：**

| 文件 | 说明 |
|---|---|
| `data/linkmind.log` | 应用日志（JSON lines，由 pino 写入，通过 `.env` 的 `LOG_FILE` 配置） |
| `data/launchd-stdout.log` | launchd 标准输出（pretty-print 格式） |
| `data/launchd-stderr.log` | launchd 标准错误（崩溃信息等） |

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Telegram Bot Token |
| `LLM_PROVIDER` | | `openai` | LLM 服务：`openai` 或 `gemini` |
| `OPENAI_API_KEY` | 使用 openai 时 | — | OpenAI 兼容 API Key |
| `OPENAI_BASE_URL` | 使用 openai 时 | — | OpenAI 兼容 API 地址 |
| `OPENAI_DEFAULT_MODEL` | | `qwen-plus` | 模型名称 |
| `GEMINI_API_KEY` | 使用 gemini 时 | — | Google AI Studio API Key |
| `GEMINI_MODEL` | | `gemini-2.0-flash` | Gemini 模型名称 |
| `WEB_PORT` | | `3456` | Web 服务端口 |
| `WEB_BASE_URL` | | `http://localhost:3456` | 永久链接的公开地址 |
| `QMD_NOTES_COLLECTION` | | `notes` | QMD 笔记集合名 |
| `QMD_LINKS_COLLECTION` | | `links` | QMD 链接集合名 |
| `QMD_LINKS_PATH` | | `~/LocalDocuments/linkmind/links` | Markdown 导出路径 |
| `LOG_LEVEL` | | `info` | 日志级别 |
| `LOG_FILE` | | — | 日志文件路径（JSON lines 格式）|

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/links` | 添加链接并处理 `{ "url": "..." }` |
| `GET` | `/api/links` | 获取最近链接列表 `?limit=20` |
| `GET` | `/api/links/:id` | 获取链接详情 |
| `DELETE` | `/api/links/:id` | 删除链接（同时清理关联引用和导出文件）|
| `POST` | `/api/retry` | 重试所有失败的链接 |
| `POST` | `/api/retry/:id` | 重试单个失败的链接 |

## 开发

```bash
# 运行服务（Bot + Web）
pnpm dev

# 类型检查
pnpm typecheck

# 测试 pipeline
npx tsx src/test-pipeline.ts <url>                  # 完整流程
npx tsx src/test-pipeline.ts <url> --scrape-only    # 仅测试抓取
npx tsx src/test-pipeline.ts <url> --analyze-only   # 仅测试 LLM 分析
```

## 技术栈

- **运行时** — Node.js + TypeScript (tsx)
- **Telegram Bot** — [grammY](https://grammy.dev/)
- **Web 框架** — Express 5 + EJS 模板
- **数据库** — PostgreSQL 18 (Kysely)
- **全文搜索** — [pg_search](https://github.com/paradedb/paradedb) (ParadeDB BM25)
- **向量搜索** — [pgvector](https://github.com/pgvector/pgvector)
- **网页抓取** — Playwright + [Defuddle](https://github.com/nichochar/defuddle)
- **LLM** — OpenAI 兼容 API / Google Gemini（可切换）
- **知识库搜索** — [QMD](https://github.com/tobi/qmd)（语义搜索 + 向量化）
- **日志** — Pino + pino-pretty

## 全文搜索 (pg_search)

LinkMind 使用 [pg_search](https://docs.paradedb.com/) (ParadeDB) 扩展实现全文搜索，支持 BM25 排序算法，**原生支持中文**，无需额外分词配置。

### 安装 pg_search

**本地开发 (macOS):**

从 [ParadeDB Releases](https://github.com/paradedb/paradedb/releases) 下载对应版本的 `.pkg` 安装包：
- macOS Sequoia + PG 18: `pg_search@18--x.x.x.arm64_sequoia.pkg`
- macOS Sonoma + PG 18: `pg_search@18--x.x.x.arm64_sonoma.pkg`

安装后启用扩展：

```sql
CREATE EXTENSION IF NOT EXISTS pg_search;
```

**云端部署 (Neon):**

Neon 已预装 pg_search，直接启用即可：

```sql
CREATE EXTENSION IF NOT EXISTS pg_search;
```

> 注意：Neon 的 pg_search 仅支持 PG17，版本为 0.15.26；本地安装可使用 PG18 + 最新版本。

### 索引字段

`links` 表的 BM25 索引覆盖以下文本字段：

| 字段 | 用途 | 说明 |
|------|------|------|
| `og_title` | 网页标题 | OpenGraph 标题，权重最高 |
| `summary` | LLM 摘要 | 精炼的中文摘要，适合快速检索 |
| `markdown` | 正文内容 | 完整的网页正文（Markdown 格式） |

索引创建语句：

```sql
CREATE INDEX idx_links_bm25 ON links
USING bm25 (id, og_title, summary, markdown)
WITH (key_field='id');
```

### 搜索用法

使用 `@@@` 操作符进行搜索，支持中英文混合查询：

```sql
-- 基础搜索
SELECT id, og_title, paradedb.score(id) as score
FROM links
WHERE og_title @@@ '深度学习' 
   OR summary @@@ '深度学习' 
   OR markdown @@@ '深度学习'
ORDER BY score DESC
LIMIT 10;

-- 短语搜索（精确匹配）
SELECT * FROM links
WHERE summary @@@ '"机器学习模型"';

-- 模糊搜索（容错）
SELECT * FROM links
WHERE id @@@ paradedb.match('summary', '学习', distance => 1);

-- 高亮显示匹配内容
SELECT id, paradedb.snippet(summary) as highlight
FROM links
WHERE summary @@@ 'AI Agent';
```

### 与 Neon 的兼容性

pg_search 在本地 PostgreSQL 和 Neon 上的 API 完全一致，代码无需修改即可在两个环境间切换：

| 环境 | PostgreSQL 版本 | pg_search 版本 |
|------|----------------|----------------|
| 本地开发 | 18.1 | 0.21.6 |
| Neon 生产 | 17 | 0.15.26 |

### 参考资料

- [ParadeDB 官方文档](https://docs.paradedb.com/)
- [Neon pg_search 文档](https://neon.com/docs/extensions/pg_search)
- [BM25 算法介绍](https://en.wikipedia.org/wiki/Okapi_BM25)
