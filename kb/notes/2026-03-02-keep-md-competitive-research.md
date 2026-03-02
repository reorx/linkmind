---
created: 2026-03-02
tags:
  - competitive-research
  - keep-md
  - product-analysis
  - agent-api
---

# keep.md 竞品调研

## 产品概述

**keep.md** — "markdown bookmarks as an api"

核心定位：从各种渠道收集链接/书签，抓取网页内容转为 Markdown，存储在云端，通过 API / CLI / Agent Skill 供 AI agent 消费。

**一句话总结：** 它是一个面向 AI agent 的书签 + 内容抓取 + Markdown API 服务。

官网：https://keep.md

## 功能模块

### 1. 链接收集（多渠道入口）

| 渠道 | 方式 |
|------|------|
| Chrome 扩展 | 点击保存当前页 / 所有标签页 / 右键菜单保存链接 |
| Chrome 书签 | `Cmd+D` 自动同步到 keep |
| X/Twitter 书签 | 扩展自动捕获 tweet bookmark；或连接 X 账号每日自动同步 |
| 手机 | iOS Shortcuts / Android PWA Share Sheet |
| API | `POST /api/ingest` 传入 URL |
| CLI | `keep-markdown` npm 包 |

Chrome 扩展还支持快捷键：`Cmd+Shift+K` 保存当前页，`Cmd+Shift+L` 保存所有标签页。

### 2. 内容处理

- 保存时自动抓取网页，提取为 clean markdown
- 提取优先级：原生 markdown → Readability 解析 → raw content
- Twitter 推文：保存推文文本 + 作者 + URL，如果推文含外链还会抓取外链内容
- 内容以 `contentMarkdown`（原始 markdown）和 `content.items`（结构化内容）两种形式存储
- **不做任何 AI 处理**——没有摘要、没有关联分析、没有洞察生成

### 3. API & CLI

**API 端点（Base URL: `https://keep.md/api`）：**

- `GET /api/me` — 账户信息
- `GET /api/stats` — 使用统计
- `GET /api/items` — 列出链接（支持 `?content=1` 包含 markdown）
- `GET /api/items/:id` — 链接详情
- `GET /api/items/:id/content` — 获取 markdown 内容
- `GET /api/feed` — 未处理的条目（**专为 agent 设计**）
- `POST /api/items/mark-processed` — 标记已处理
- `POST /api/ingest` — 收录 URL（mobile-friendly）
- `POST /api/items/sync` — 扩展批量同步
- `POST /api/items/archive` — 归档
- `GET /api/integrations/x/status` — X 集成状态
- `POST /api/integrations/x/sync` — 触发 X 书签同步

认证：Bearer token。Personal key 可读写，Extension key 只能同步。

**CLI（`keep-markdown` npm 包）：**

```
keep list          — 列出链接
keep search <q>    — 搜索（title/url/notes/tags）
keep get <id>      — 获取元数据
keep content <id>  — 获取 markdown 内容
keep archive <id>  — 归档
keep feed          — 未处理条目（for agents）
keep processed <id...> — 标记已处理
keep me            — 账户信息
keep stats         — 使用统计
```

选项：`--json`, `--since <7d|24h|date>`, `--status <list>`, `--content`, `--limit <n>`

### 4. Agent Skill

- 通过 `npx playbooks add skill keep.md/docs` 安装
- 支持 OpenClaw、Claude SDK、Manus、n8n 等 agent 框架
- Agent 通过 CLI/API 读取用户保存的内容作为 context
- OpenAPI spec: `https://keep.md/openapi.json`

### 5. 定价

- **Free**: 50 links（终身上限）
- **Paid**: $10/mo 起（月度配额），含 X 书签同步等高级功能
- 超配额返回 `429 quota_reached`

## 与 LinkMind 对比

| 维度 | keep.md | LinkMind |
|------|---------|----------|
| **定位** | 书签收集 → Markdown API → 喂给 agent | 链接收集 → 智能分析（摘要/关联/洞察）→ 浏览 |
| **收集渠道** | Chrome 扩展、手机、X 同步、API | Telegram Bot |
| **内容处理** | 抓取 → 转 Markdown（就到这里） | 抓取 → LLM 摘要 → 向量化 → 关联发现 → 洞察生成 |
| **抓取方式** | Chrome 扩展端抓取（浏览器内提取） | Playwright + Defuddle + Firecrawl + Probe |
| **搜索** | 简单的 title/url/tags 搜索 | 向量语义搜索（pgvector） |
| **AI 能力** | 无 | 完整 pipeline：summarize → embed → related → insight |
| **存储** | 云端 SaaS | 云端（PostgreSQL + Neon） |
| **消费方式** | API/CLI → 外部 agent 消费 | Web UI + Telegram 内查看 |
| **目标用户** | AI agent 开发者 / 重度 agent 用户 | 个人知识管理 / 信息消费者 |

**核心差异：** keep.md 在"智能"方面基本是空白的——纯粹是一个"存储 + API 暴露"层，把智能分析完全交给下游 agent。LinkMind 内置了完整的 AI pipeline，是端到端的智能链接分析系统。

## 与 MyKB 对比

| 维度 | keep.md | MyKB |
|------|---------|------|
| **定位** | 云端书签 → Markdown API | 本地知识库搜索引擎 |
| **数据存储** | 云端 SaaS | 完全本地 |
| **数据来源** | 网页书签、Twitter | Obsidian vault（可扩展） |
| **搜索** | 简单关键词搜索 | BM25 + 向量语义混合搜索 |
| **Embedding** | 无 | 本地 embeddinggemma-300m |
| **隐私** | 数据在云端 | 数据完全在本地 |
| **Agent 集成** | 原生 API + Skill | CLI（可被 agent 调用） |

**核心差异：** keep.md 优势在多渠道收集和 API 暴露，劣势是数据不在用户手里、搜索能力弱。MyKB 优势在混合搜索和数据隐私，劣势是数据源单一、缺少便捷收集渠道。

## 借鉴意义

### 对 LinkMind 的启发

1. **Agent-first API 设计**：`/feed` + `mark-processed` 模式，专门为 agent 消费设计的端点。LinkMind 可以暴露经过 AI 分析后的内容（摘要 + 关联 + 洞察），比 keep.md 只给原始 markdown 有价值得多。

2. **多渠道收集**：Chrome 扩展、手机 Share Sheet、API ingest 都是自然的扩展方向。特别是 Chrome 扩展 + 浏览器书签自动同步，几乎零摩擦的 UX。

3. **X/Twitter 书签同步**：LinkMind 已支持 Twitter 链接抓取（Probe + bird CLI），但还不支持主动同步用户的 Twitter 书签列表。

4. **面向用户的 CLI**：目前 LinkMind 的 CLI 是内部管理用的，可以考虑做一个用户级 CLI（`list / search / get / add`）。

### 对 MyKB 的启发

1. **多数据源**：如果 MyKB 能接入 LinkMind 的数据（API 或本地同步），用户就能在本地同时搜索笔记和收藏链接。

2. **Agent Skill 封装**：提供标准 agent skill 接口，让 OpenClaw 等 agent 能直接搜索用户的本地知识库。

### LinkMind + MyKB 组合优势

keep.md 本质是 **收集 + 存储 + API**，没有智能分析，没有本地搜索。

**LinkMind + MyKB 组合**覆盖 keep.md 全部能力并远超之：

- **收集**：LinkMind 多渠道（扩展后不输 keep.md）
- **智能处理**：LinkMind AI pipeline（keep.md 完全没有）
- **云端存储 + API**：LinkMind server
- **本地搜索**：MyKB 混合搜索（keep.md 只有简单关键词）
- **数据主权**：MyKB 本地优先（keep.md 全在云端）

**关键整合点：让 MyKB 能索引 LinkMind 的数据。** 用户在 LinkMind 收藏的链接，经 AI 分析后的摘要和内容，同步到本地被 MyKB 索引。兼得云端便捷收集 + 智能分析 + 本地强力搜索 + 数据所有权。
