# 实现 AgentEvent 系统，为 pipeline 提供结构化事件记录

## 概要

基于 `server/notes/plan-agent-event.md` 设计文档，将完整的 AgentEvent 事件框架集成到 linkmind pipeline 中。新增 `agent_session` 和 `agent_event` 两张数据库表，实现 `AgentEventEmitter` 类在每个 pipeline 步骤前后记录结构化事件（同时写 pino 日志和 DB），并通过 SSE 接口支持前端实时获取处理进度。Web UI 的 record 详情页增加了 Rerun 按钮和 Processing History 时间线展示。通过多轮本地测试验证：正常完成、失败、Twitter/probe 等待三种路径均正确记录事件。

## 修改的文件

**新增文件：**

- `server/src/types/agent-event.ts` — 定义 `AgentEventType`（session_start/end, step_start/end, message）和 `AgentSessionStatus`（running/completed/failed）常量类型
- `server/migrations/003_agent_events.sql` — 创建 `agent_session` 和 `agent_event` 表及索引
- `server/src/db/agent-event.ts` — 6 个 DB 操作函数：createAgentSession, updateAgentSessionStatus, getLatestAgentSession, insertAgentEvent, getAgentEventsAfterCursor, getAgentEventsBySessionId
- `server/src/agent-event-emitter.ts` — `AgentEventEmitter` 类，封装 session 生命周期和事件发射，每次 emit 同时写 pino log + DB

**修改文件：**

- `server/src/db/types.ts` — 新增 `AgentSessionsTable`、`AgentEventsTable` 接口，并将 `agent_session`、`agent_event` 加入 `Database` 接口
- `server/src/db/index.ts` — 添加 `agent-event.js` 的 re-export
- `server/src/pipeline.ts` — 在 process-link、process-note、refresh-related 三个 task handler 中集成 `AgentEventEmitter`，用 `emitStepStart/End` 包裹每个步骤，用 `emitMessage` 记录中间状态
- `server/src/routes/api.ts` — 新增 3 个 API 端点：`GET /api/records/:id/session`（获取最新 session）、`GET /api/agent-events/stream`（SSE 实时推送）、`GET /api/records/:id/events`（获取全量事件）
- `server/src/routes/pages.ts` — link 详情页路由中增加查询 latestSession 和 agentEvents，传递给模板
- `server/src/views/link-detail.ejs` — 新增 Rerun 按钮、session 状态徽章、Processing History 事件时间线、SSE 实时更新 JS 逻辑

## Git 提交记录

本次 session 无 git 提交。所有改动为未暂存状态。

## 注意事项

- **waiting_probe 路径不应 endSession('completed')**：当 pipeline 因等待 probe 而暂停时，session 应保持 `running` 状态，不能标记为 completed。否则前端 SSE 会收到 session_end 后关闭连接，导致后续恢复的 pipeline（新 session）进度无法展示。code review 中发现并修复了此问题。
- **emitter 方法必须 await**：`emitMessage()` 等异步方法内部做 DB 写入，不 await 会导致 unhandled promise rejection 和事件丢失。code review 发现 3 处遗漏的 await。
- **SSE 关闭竞态**：SSE poll 循环需要在每次 `res.write()` 前检查 `closed` 标志，避免在客户端断开后继续写入已关闭的 socket。
- **step_start/step_end 必须配对**：在 probe fallback 等提前退出路径上，需要补发 `emitStepEnd` 再退出，否则前端时间线会显示步骤永远 "in progress"。
- **多 session 共存**：Absurd 重试机制会为同一 record 创建多个 session（每次重试一个），`getLatestAgentSession` 按 created_at desc 取最新的，这是正确行为。
- **并行 agent 开发模式**：通过 Task tool 分发独立任务给多个 agent（编辑不同文件），可以显著加速开发。关键是确保 agent 之间不编辑同一文件，避免冲突。
