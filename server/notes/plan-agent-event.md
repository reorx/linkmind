# Plan: AgentEvent System for LinkMind

## 概述

将 tenderbuddy 的 AgentEvent 框架完整移植到 linkmind，为 pipeline 处理过程提供结构化事件记录。事件持久化到 DB，支持通过 SSE 接口实时推送给前端，并在 record 详情页展示处理进度和历史。

## 参考

- `tenderbuddy/packages/core/src/schema/agent-event.ts` — DB schema
- `tenderbuddy/packages/core/src/types/agent-event.ts` — 类型定义
- `tenderbuddy/packages/core/src/db/agent_event.ts` — DB 操作
- `tenderbuddy/packages/core/src/agent-event-emitter.ts` — Emitter class

## 需要新增的文件

### 1. 类型定义 — `server/src/types/agent-event.ts`

```ts
export const AgentEventType = {
  SESSION_START: 'session_start',
  SESSION_END: 'session_end',
  STEP_START: 'step_start',    // pipeline 步骤开始（替代 tenderbuddy 的 TOOL_START）
  STEP_END: 'step_end',        // pipeline 步骤结束（替代 tenderbuddy 的 TOOL_END）
  MESSAGE: 'message',          // 通用信息事件（如 "content too short, retrying"）
} as const;

export type AgentEventTypeValue = (typeof AgentEventType)[keyof typeof AgentEventType];

export const AgentSessionStatus = {
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type AgentSessionStatusValue = (typeof AgentSessionStatus)[keyof typeof AgentSessionStatus];
```

**说明：** 保留 AgentEvent 命名，但 event_type 根据 linkmind 实际场景调整：
- `STEP_START` / `STEP_END` 对应 pipeline 步骤（scrape, summarize, embed, related, insight）
- `MESSAGE` 用于中间状态信息（重试、fallback 等）
- `SESSION_START` / `SESSION_END` 对应一次完整的 pipeline 执行

### 2. DB Schema — Kysely migration `server/migrations/005_agent_events.sql`

```sql
-- Agent session: one per pipeline run
CREATE TABLE agent_session (
  id VARCHAR(32) PRIMARY KEY,          -- nanoid or uuid
  ref_type VARCHAR(64) NOT NULL,       -- 'record'
  ref_id VARCHAR(32) NOT NULL,         -- record id (as string)
  agent_name VARCHAR(128) NOT NULL,    -- 'process-link' | 'process-note' | 'refresh-related'
  status VARCHAR(16) NOT NULL DEFAULT 'running',  -- running | completed | failed
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_session_ref ON agent_session(ref_type, ref_id);

-- Agent event: individual events within a session
CREATE TABLE agent_event (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(32) NOT NULL REFERENCES agent_session(id),
  event_type VARCHAR(32) NOT NULL,     -- session_start | session_end | step_start | step_end | message
  name VARCHAR(128),                   -- step name: scrape | summarize | embed | related | insight
  data JSONB,                          -- flexible payload
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_event_session ON agent_event(session_id);
```

### 3. Kysely 类型 — 追加到 `server/src/db/types.ts`

```ts
// 在 Database interface 中追加：
// agent_sessions: AgentSessionsTable;
// agent_events: AgentEventsTable;

export interface AgentSessionsTable {
  id: string;
  ref_type: string;
  ref_id: string;
  agent_name: string;
  status: string;
  error_message: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AgentEventsTable {
  id: Generated<number>;
  session_id: string;
  event_type: string;
  name: string | null;
  data: any | null;
  created_at: Generated<Date>;
}
```

### 4. DB 操作 — `server/src/db/agent-event.ts`

从 tenderbuddy 移植，适配 Kysely（tenderbuddy 用 drizzle）：

```ts
// createAgentSession(data) → insert into agent_session, return row
// updateAgentSessionStatus(sessionId, status, errorMessage?) → update agent_session
// getLatestAgentSession(refType, refId) → 最新 session
// insertAgentEvent(data) → insert into agent_event, return row
// getAgentEventsAfterCursor(sessionId, cursor, limit) → cursor-based 增量查询
// getAgentEventsBySessionId(sessionId) → 全量查询（给 SSE 首次加载用）
```

### 5. AgentEventEmitter — `server/src/agent-event-emitter.ts`

```ts
class AgentEventEmitter {
  constructor(opts: { refType: string; refId: string; agentName: string })

  // Session 生命周期
  async startSession(): Promise<string>
  async endSession(status: 'completed' | 'failed', error?: string): void

  // Pipeline 步骤事件（替代 tenderbuddy 的 emitToolStart/End）
  async emitStepStart(stepName: string, meta?: Record<string, unknown>): void
  async emitStepEnd(stepName: string, meta?: Record<string, unknown>, durationMs?: number): void

  // 通用信息事件
  async emitMessage(message: string, meta?: Record<string, unknown>): void

  getSessionId(): string | null
}
```

**每个 emit 方法做两件事：**
1. 写 pino log（保持现有日志格式兼容）
2. 存 DB（insertAgentEvent）

### 6. SSE 接口 — `server/src/routes/api.ts` 新增

```
GET /api/agent-events/stream?session_id=<session_id>&cursor=0
```

- SSE (text/event-stream)
- 独立于 records 路由，用 session_id 请求
- 首次连接：cursor=0，推送该 session 的全部 events
- 之后：轮询 DB（每 2s），用 lastEventId 作为 cursor 查增量
- 当 session status 变为 completed/failed 时，推送最终事件并关闭连接
- 需要 requireAuth 认证

**SSE event 格式：**
```
event: agent_event
data: {"id": 1, "event_type": "step_start", "name": "scrape", "data": {...}, "created_at": "..."}

event: agent_event
data: {"id": 2, ...}
```

**前端流程：**
1. 加载 record 详情页时，调用 `getLatestAgentSession('record', recordId)` 获取最新 session
2. 如果 session 存在且 status=running，建立 SSE 连接 `/api/agent-events/stream?session_id=xxx`
3. 如果 session 已完成，直接从 DB 加载全量 events 渲染（无需 SSE）

### 7. Web UI — Record 详情页改动

**rerun 按钮：**
- 在 record 详情页添加 "Rerun" 按钮
- record owner 可触发（requireAuth + 校验 record.user_id === req.userId）
- 点击后调用 `POST /api/admin/retry/:id`
- 按钮切换为 loading 状态，同时建立 SSE 连接展示进度

**事件流展示：**
- record 详情页底部增加 "Processing History" 区域
- 展示最新 session 的 events（时间线/日志格式）
- 如果 session 正在 running，自动通过 SSE 实时更新
- 每条 event 显示：时间、step name、状态（start/end/message）、耗时、关键 meta

## 改动现有文件

### `server/src/pipeline.ts`

**核心改动：** 在 `spawnProcessLink`、`spawnProcessNote`、`spawnRefreshRelated` 的 task handler 中：

1. 创建 `AgentEventEmitter` 实例
2. `startSession()` 在 task 开始时
3. 每个步骤前后调用 `emitStepStart()` / `emitStepEnd()`
4. 中间状态（retry、fallback、waiting_probe 等）调用 `emitMessage()`
5. `endSession('completed')` 或 `endSession('failed', error)` 在 task 结束时

**现有 `log.info(...)` 调用保留还是替换？**
→ **替换。** `emitStepStart/End/Message` 内部会调用 pino log，不需要重复。

### `server/src/db/types.ts`

追加 `AgentSessionsTable`、`AgentEventsTable` 和 `Database` interface。

### `server/src/db/index.ts`

导出 `agent-event.ts` 的所有方法。

### `server/src/routes/api.ts`

新增 SSE endpoint。

### Web 模板

Record 详情页 EJS 模板添加 rerun 按钮和事件流展示区域。

## 实施步骤

1. **Schema + Types** — 创建 migration SQL、Kysely 类型、AgentEventType/Status 类型
2. **DB 操作** — 实现 `db/agent-event.ts`
3. **AgentEventEmitter** — 实现 emitter class
4. **Pipeline 集成** — 在 pipeline.ts 中接入 emitter，替换现有 log 调用
5. **SSE 接口** — 实现 `/api/records/:id/events`
6. **Web UI** — Rerun 按钮 + 事件流展示
7. **本地测试** — 跑完整 pipeline，验证事件写入和 SSE 推送
8. **迁移** — 在本地和 Neon 执行 migration

## 决议

1. **Rerun 权限：** record owner 可触发（通过 requireAuth，校验 record.user_id === req.userId）
2. **Session ID 格式：** nanoid
3. **历史 session 展示：** 只展示最新 session
4. **Event 清理策略：** 暂不需要，全量保留
