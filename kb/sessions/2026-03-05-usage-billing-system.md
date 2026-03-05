---
created: 2026-03-05
tags:
  - usage-billing
  - pipeline
  - llm
  - database
  - migration
---

# 实现用量计费系统，追踪每用户 LLM/Crawler/Embedding 消费

## 概要

基于 `notes/usage-billing-design.md` 设计文档，使用 agent team（5 个子任务、4 个 agent 并行协作）完成了完整的用量计费系统实现。系统以 USD 为单位追踪每个用户的 LLM、Crawler、Embedding 资源消费，采用软限额策略（入口拦截、执行不中断），支持基于锚点日的自定义计费周期和惰性重置。实现后经过代码审查，修复了 `DEFAULT_CYCLE_LIMIT_USD` 环境变量未生效的问题，并验证了 UTC/本地时间日期处理的正确性。最终在生产数据库副本上验证 migration 通过后，部署到生产环境。

## 修改的文件

**新建文件：**
- `server/src/db/migrations/2026-03-04T1200-usage-billing.ts` — Kysely migration，创建 `user_balances` 和 `usage_transactions` 表及索引
- `server/src/db/usage.ts` — DB 操作层，原子事务插入 + 余额递增，ON CONFLICT 幂等处理
- `server/src/usage.ts` — 业务逻辑层，定价表、费用计算、周期管理、限额检查、recordTransaction
- `server/src/__tests__/usage.test.ts` — 18 个测试用例覆盖费用计算、周期日期、完整生命周期

**修改文件：**
- `server/src/llm.ts` — `chat()` 返回 `ChatResult`，`createEmbedding()` 返回 `EmbeddingResult`，`generateObject()` 返回 usage 信息
- `server/src/agent.ts` — 所有 generate 函数返回 `WithUsage<T>`，透传 LLM usage
- `server/src/pipeline.ts` — 每个 step 后调用 `recordTransaction` 记录消费，添加 scrapeSource 追踪
- `server/src/bot.ts` — pipeline 入口前 `checkAndGetBudget` 限额检查，超限返回提示
- `server/src/db/types.ts` — 添加 `UserBalancesTable`、`UsageTransactionsTable` 类型定义
- `server/src/db/index.ts` — 导出 db/usage.ts
- `server/src/search.ts` — 适配 `createEmbedding()` 新返回类型
- `server/src/cli/backfill-embeddings.ts` — 适配 `createEmbedding()` 新返回类型
- `server/src/__tests__/pipeline.test.ts` — 更新 mock 匹配新返回类型
- `server/src/__tests__/search.test.ts` — 更新 mock 匹配新返回类型
- `server/scripts/replicate-prod-db.sh` — 修复权限问题，使用 superuser 创建数据库和安装扩展

## Git 提交记录

- `c4bee58` feat(server): add usage billing system with per-user cost tracking

## 注意事项

- **pg DATE 列返回本地时间 Date**：node-postgres (pg-types) 解析 DATE 列时使用 `new Date(year, month, day)` 构造，返回的是**本地时间**午夜的 Date 对象，不是 UTC 午夜。因此 `getNextCycleStart` 等函数必须使用 `.getFullYear()/.getMonth()/.getDate()` 等本地时间方法，不能用 UTC 方法。代码审查曾建议切换到 UTC 方法，实测证明会导致时区偏移 bug。
- **Kysely 支持 partial unique index 的 ON CONFLICT**：`oc.columns([...]).where(...).doNothing()` 可以正确生成 `ON CONFLICT (...) WHERE ... DO NOTHING` 语法，匹配 PostgreSQL 的 partial unique index。已通过集成测试和生产副本验证。
- **Agent team 协作模式**：5 个任务按依赖关系分配给 4 个 agent 并行执行（db-builder → usage-builder → pipeline-integrator，llm-modifier 并行，test-writer 并行），总耗时约 15 分钟完成全部实现。
- **replicate-prod-db.sh 权限问题**：linkmind 用户没有 createdb 权限，脚本必须用 reorx superuser 执行 CREATE DATABASE、CREATE EXTENSION 和 pg_restore，之后 GRANT 权限给 linkmind。
- **DEFAULT_CYCLE_LIMIT_USD 需要传入 getOrCreateBalance**：环境变量在 usage.ts 中读取，但必须作为参数传给 db/usage.ts 的 `getOrCreateBalance()`，否则新用户始终使用 DB 默认值 $1.00。
