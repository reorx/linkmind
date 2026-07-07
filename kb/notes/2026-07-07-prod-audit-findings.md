---
created: 2026-07-07
tags:
  - production
  - audit
  - launch
  - ops
---

# 生产环境审计结果（P0-1）

对应 [before-launch 计划](../plans/2026-07-07-before-launch.md) 的 P0-1。审计脚本：`tmp/audit-prod-db.ts`（只读，`cd server && npx tsx --env-file=.env.prod ../tmp/audit-prod-db.ts`）。

## 部署拓扑（与 CLAUDE.md 记载不同，已变更）

- **生产已于 2026-07-03 迁移到 ali-hk-01**（`/opt/apps/linkmind/`，Caddy 反代 `linkmind.reorx.com`）。CD：push master → GHCR → webhook 自动部署。
- 部署文档：iCloud deploy workspace `kb/docs/linkmind.md`。
- ⚠️ CLAUDE.md 中"服务器：hh-hk-01"的记载已过时，需更新。

## 审计中发现并已修复的问题

1. **hh-hk-01 僵尸副本**：迁移后 hh 上的容器仍在运行，与 ali 双实例共用 Neon + 同一个 Bot token。已于 2026-07-07 `docker compose down` 停止移除。
2. **ali 生产 .env 缺失配置**（迁移时从不完整的本地 `.env.prod` 复制导致）：缺 `FIRECRAWL_API_KEY`、`STORAGE_BACKEND`、`R2_*` 五项。后果：图片写入容器内临时目录（重建即丢）、Firecrawl fallback 失效。已从 hh 旧 `.env` 恢复并重启容器，验证启动正常、公网 200。本地 `server/.env.prod` 备份已同步补齐（备份于 `.env.prod.bak-20260707`）。

## 生产状态快照（2026-07-07）

- **代码版本**：镜像 revision `b675a70`（2026-04-10 构建）= master 最新提交，**生产无落后**。
- **Migration**：Kysely 2 个 migration 均已应用；`006_record_files.sql` 已执行（`record_files` 表存在）。所有 SQL 基线 001-006 齐备。
- **图片迁移**：`records.images` 遗留数据 = 0 条（迁移脚本已跑过），但 `images` 列仍在 → 只剩 Phase 6 清理。
- **数据规模**：5 users，190 records（188 link / 2 note）：analyzed 156、waiting_probe 24、scraped 7、error 3。
- **Absurd 队列**：214 completed，5 failed（3 次重试耗尽，见下），无积压 pending。
- **计费**：仅 user 1 有 balance（$0.041/$1.00 limit）；usage_transactions 正常记录（gemini $0.24 / jina $0.007 / dashscope embedding $0.003）。
- **Crawler keys**：1 个 Jina free key，剩余充足（39.3 万/1000 万 credits 已用）。
- **Share**：0 条分享记录（功能未被使用过）。
- **Sentry**：`SENTRY_DSN` 在新旧生产环境都未配置 → 错误追踪从未启用（代码里 DSN 缺失时静默跳过）。

## 追加发现（2026-07-07 重跑 failed 记录时）

### ⚠️ Gemini 在 ali-hk-01 被地理封锁（迁移引入的严重故障）

重跑 5 条 failed 记录时，抓取全部成功（连老大难 note.mowen.cn 都拿到 7238 字符），但 summarize 全部报 `Gemini 400: User location is not supported for the API use`。**ali-hk-01（阿里云香港）的出口 IP 被 Google Gemini API 拒绝**，旧机 hh-hk-01 出口路由不同所以之前可用。即：2026-07-03 迁移后，生产所有新链接的 LLM 步骤都是坏的。

**已做的止血**：`LLM_PROVIDER` 切换为 `openai`（DashScope qwen-plus，`OPENAI_BASE_URL` 已有配置；从阿里云访问 DashScope 反而是最优路径），重启后重跑 5 条记录**全部 analyzed 成功**。Gemini 配置保留在 .env 中未删。备份：ali 上 `.env.bak-llm-switch`。

**待用户决策（长期方案）**：
1. 继续用 qwen-plus（成本更低，但 summary/insight 质量需观察；insight-thinking 计划是按 Gemini thinkingConfig 设计的，需改写）
2. 给 Gemini 加代理（llm.ts 中 `GEMINI_API_BASE` 是硬编码，需加 env 覆盖支持）
3. 把服务迁到 Gemini 支持的地区（如 tc-sg-01 新加坡）

### env 全量对比（hh vs ali）

除已修复的 5 个变量外，两边 .env 逐 key 对比**完全一致**，无其他丢失。

## 遗留问题（进入后续任务）

1. **Probe 完全离线**：`probe_devices` 表为空（生产从未注册过 probe 设备），`probe_events` 31 条 pending，24 条 records 卡在 `waiting_probe`（最早 2026-01-31，含 1 条微信文章走 browser fallback）→ 对应 before-launch P0-3。
2. **5 个 failed task**（重试耗尽）：note.mowen.cn（SPA 抓取失败的老案例）、0xsid.com、super.engineering、2 条微信文章（4-5 月用户添加时失败——当时 Firecrawl key 已缺失可能是诱因）→ 修复 env 后可用 admin retry 重跑验证。
3. **SENTRY_DSN 未配置** → 对应 P0-7，需在 GlitchTip 建项目并配置。
4. **计费默认限额**：`DEFAULT_CYCLE_LIMIT_USD`、`BILLING_TIMEZONE` 未显式配置（走代码默认 $1.00 / Asia/Shanghai），上线前确认即可。
