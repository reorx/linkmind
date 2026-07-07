---
created: 2026-07-08
tags:
  - probe
  - telegram-bot
  - pipeline
  - notification
  - cron
  - testing
---

# 实现 Probe 超时机制与用户告知，并完成本地 server + probe 端到端验收

## 概要

按照 [probe-timeout-and-notify 计划](../plans/2026-07-07-probe-timeout-and-notify.md) 补齐 probe 机制的四个缺口：waiting_probe 无超时永久卡死、Bot 对 waiting_probe 零反馈、probe 迟到结果无人通知、`sent` 状态事件卡死。采用 BDD 流程先写 6 个行为测试再实现：新增解耦通知通道 `notify.ts`（pipeline/cron 不 import bot，由 bot 启动时注册 notifier）、超时清扫 cron `probe-timeout-cron.ts`（每 10 分钟将超过 `PROBE_WAIT_TTL_HOURS`（默认 24h）的 `pending`/`sent` 事件标 `expired`，关联 record 仍在 waiting_probe 才标 error 并通知用户）、Bot 轮询遇 waiting_probe 立即反馈并引导安装、probe 回传恢复的 pipeline 完成后主动推送结果消息、无需登录的 `GET /probe` 安装教程页。最终 typecheck 通过、63 个测试通过，并在本地同时运行 server 与 probe，用真实 Twitter 链接完成两轮完整联动（waiting_probe → SSE 推送 → bird 抓取 → receive_result → pipeline analyzed）。

## 修改的文件

- `server/src/notify.ts` — **新建**。通知通道：`setNotifier`/`notifyUser`（未注册时仅 log，永不抛错）、`notifyRecordProcessed`（record 完成后发结果消息，无 telegram_chat_id 时 no-op）、`fetchRelatedRecordsInfo`（自 bot.ts 迁入）、`getWebBaseUrl`
- `server/src/probe-timeout-cron.ts` — **新建**。超时清扫 cron：`sweepExpiredProbeEvents(ttlHours)`（可独立调用便于测试）、`startProbeTimeoutCron`/`stopProbeTimeoutCron`、`getProbeWaitTtlHours`（env `PROBE_WAIT_TTL_HOURS`，支持小数）
- `server/src/__tests__/probe-timeout.test.ts` — **新建**。6 个 BDD 行为测试，独立测试库 `linkmind_probe_test`，覆盖 pending/sent 超时、未超时不动、record 已流转只标 event、无 chat_id 不通知不抛错、handleProbeResult 恢复后完成通知
- `server/src/views/probe.ejs` — **新建**。Probe 安装教程页（前置要求、device auth 登录、launchd/systemd 常驻、验证步骤）
- `server/src/bot.ts` — `pollAndNotify` 增加 waiting_probe 分支（立即结束轮询、补存 telegram_chat_id、提示安装教程与超时策略）；启动时 `setNotifier` 注册真实发送；`formatResult`/`escHtml`/`truncate`/`fetchRelatedRecordsInfo` 移出
- `server/src/telegram-render.ts` — 新增 `formatResultTelegram`（原 bot.ts 的 `formatResult`）、`RelatedRecordInfo`，导出 `escHtml`
- `server/src/pipeline.ts` — 带 probe `scrapeData` 的任务 analyzed 后调用 `notifyRecordProcessed`（普通任务由 bot 轮询报告，避免双重消息）
- `server/src/db/probe.ts` — 新增 `getExpiredProbeEvents(ttlHours)`
- `server/src/routes/pages.ts` — 注册 `GET /probe`（无需登录）
- `server/src/index.ts` — 启动 probe-timeout cron
- `server/src/__tests__/usage.test.ts` — 测试库改名 `linkmind_usage_test`，修复与 pipeline.test.ts 共用 `linkmind_test` 导致的并行冲突

## 注意事项

- **通知解耦 pattern**：pipeline/cron 需要给 Telegram 用户发消息时，不能 import bot.ts（循环依赖），通过 `notify.ts` 的注册回调机制解耦；notifier 未注册时降级为 log-only，测试中用 mock notifier 注入即可断言通知行为
- **每个集成测试文件用独立测试库**：vitest 默认并行跑测试文件，两个文件共用同一个测试 DB（bootstrapDatabase dropIfExists）会互相 drop 导致 flaky 失败。命名约定 `linkmind_<name>_test`
- **本地 `.env` 与 `.env.prod` 共用同一个 bot token**：本地启动 server 会与生产抢 Telegram getUpdates 轮询、吞掉线上用户消息。本次验收临时替换为 dummy token（bot 401 但不影响 web/worker/cron），结束后已恢复。建议申请独立 dev bot
- **本地 E2E 验收方法**：直接在本地 DB 种 `probe_devices` 行 + 手写 `~/.linkmind-probe/config.json` 可跳过交互式 device auth；用 `gen-token` CLI 生成 JWT 通过 `POST /api/links` 添加链接即可触发全链路，无需真实 Telegram 消息
- `expired` 是 probe_events.status 的新值（TEXT 字段，无需 migration）；清扫时 record 已流转走（probe 曾回传）只标 event 不动 record
- search.test.ts 的 2 个 BM25 测试在本地失败是既有环境问题（本地无 ParadeDB），与功能无关

## 遗留问题

- ~~**probe daemon 不认识 `browser` url_type**（既有 bug）~~ **已修复（2026-07-08 后续 session）**：server fallback 改为创建 `url_type: 'web'`（统一到 core 的 `UrlType`），`createProbeEvent` 参数收紧为 `UrlType` 防复发；daemon 增加 `browser` → `web` 兼容分支消化生产 6 条 backlog 事件，无需改生产数据
- **`~/.linkmind-probe/config.json` 当前指向 localhost**（验收时种的临时 device `local-e2e-device`，仅存在于本地 DB）：后续连生产消化 backlog 前需重新 `login` 做 device auth
- 生产上线后需执行计划第 6 节的存量 backlog 运维步骤（reorx 本机 probe 连生产消化 25 条 twitter pending；6 条 browser 事件先走 admin retry）
- 本地 `.env` 的 bot token 与生产相同的问题未根治，建议创建独立 dev bot

## 相关文档

- [Probe 超时机制 + 用户告知计划](../plans/2026-07-07-probe-timeout-and-notify.md) — 本次 session 按此计划实现
- [Before Launch 计划](../plans/2026-07-07-before-launch.md) — 本计划对应其中 P0-3
- [生产审计结果](../notes/2026-07-07-prod-audit-findings.md) — 本计划的背景依据
