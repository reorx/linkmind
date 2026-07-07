---
created: 2026-07-07
tags:
  - probe
  - telegram-bot
  - pipeline
  - launch
  - feature
---

# Probe 超时机制 + 用户告知

## 背景与决策

生产审计（见 [审计结果](../notes/2026-07-07-prod-audit-findings.md)）发现 probe 机制在生产从未启用：`probe_devices` 为空，31 条 probe_events pending，24 条 records 永久卡在 `waiting_probe`。

**已拍板（2026-07-07）**：probe 保持原设计——**用户在自己的设备上运行 probe 进程**，用自己的 Twitter cookies 抓自己的链接。服务端不提供共享 probe。产品口径：Twitter 链接需要用户连接自己的 probe，未连接时超时后明确告知失败。

对应 [before-launch](2026-07-07-before-launch.md) P0-3。

## 现状的四个缺口

1. **无超时**：record 进入 `waiting_probe` 后若无 probe 处理，永久卡住，无任何清理机制。
2. **Bot 对 waiting_probe 零反馈**：`pollAndNotify()`（bot.ts）只认 `scraped`/`analyzed`/`error` 三种状态，遇到 `waiting_probe` 会傻等 5 分钟然后显示"⏰ 处理超时，请稍后在网页端查看结果"——误导用户（永远不会有结果）。
3. **probe 迟到的结果无人通知**：probe 若在 5 分钟轮询窗口之后回传结果，`handleProbeResult()` 会重新跑 pipeline 到 analyzed，但 bot 轮询早已结束，用户收不到最终消息。
4. **`sent` 状态也会卡死**：事件推给 probe 后标记 `sent`，若 probe 中途挂掉不回传，事件既不会重发（`getPendingProbeEvents` 只查 `pending`）也不会过期。

## 设计

### 1. Bot 即时反馈 waiting_probe（bot.ts）

`pollAndNotify()` 增加 `waiting_probe` 分支：一旦检测到该状态，立即结束轮询并把状态消息改为：

```
🛰 此链接需要通过你的本地 Probe 抓取（如 Twitter/X）。
已进入等待队列——如果你的 probe 在线会自动处理并回复结果；
尚未安装请看教程：<WEB_BASE_URL>/probe
超过 24 小时未处理将自动标记失败。
```

注意：此时要确保 `telegram_chat_id`/`telegram_message_id` 已存到 record（供后续通知定位会话；创建 record 的几个入口已经存了 chat_id，核对补齐即可）。

### 2. 通知模块（新文件 src/notify.ts）

pipeline 不能 import bot（会循环依赖），建立解耦的通知通道：

```ts
type Notifier = (chatId: number, text: string, opts?: { recordUrl?: string }) => Promise<void>;
let notifier: Notifier | null = null;
export function setNotifier(fn: Notifier): void { ... }
export async function notifyUser(chatId, text, opts?): Promise<void> { /* notifier 未注册时仅 log */ }
```

bot.ts 启动时 `setNotifier((chatId, text, opts) => bot.api.sendMessage(chatId, text, ...))`（带"查看详情"按钮，复用 `makeRecordButtons`）。

### 3. Probe 超时清扫 cron（新文件 src/probe-timeout-cron.ts）

参照 `enqueue-cron.ts` 的模式，每 10 分钟一轮：

```
查询 probe_events WHERE status IN ('pending', 'sent')
  AND created_at < NOW() - PROBE_WAIT_TTL
对每条:
  1. updateProbeEventStatus(id, 'expired')
  2. 若关联 record 仍是 waiting_probe:
     updateRecord(recordId, { status: 'error',
       error_message: '等待本地 Probe 抓取超时（24h），请确认 probe 已安装并在线后重试' })
  3. 若 record 有 telegram_chat_id → notifyUser(chatId,
     '⏰ 链接等待 Probe 抓取超时已标记失败: <url>\n安装/启动 probe 后可在详情页 Rerun')
```

- TTL 环境变量：`PROBE_WAIT_TTL_HOURS`，默认 `24`
- `expired` 是 probe_events.status 的新值（TEXT 字段，无需 migration）
- `sent` 超时同样清扫（覆盖缺口 4）；record 已流转走的（probe 回传过）只标 event，不动 record
- index.ts 启动时与 enqueue-cron 一起启动

### 4. Probe 回传后的完成通知（pipeline.ts + notify.ts）

`handleProbeResult()` 重新 spawn 的 pipeline 完成后主动通知（覆盖缺口 3）：

- `spawnProcessLink` 已支持传入 probe 的 `scrapeData`，以此为判断依据：**带 probe 数据的任务**在 pipeline 全部 step 完成（analyzed）后，若 record 有 `telegram_chat_id`，调用 `notifyUser()` 发送与 `pollAndNotify` 相同格式的结果消息（复用 `formatResult`，需从 bot.ts 提取到共享模块或移入 telegram-render.ts）
- 普通任务不发（bot 的轮询会处理），避免双重消息

### 5. Probe 安装教程页（web）

新增 `GET /probe` 静态页面（EJS，无需登录），内容：

1. 前置要求：Node.js ≥ 22、pnpm、Chrome（已登录 Twitter/X）、[bird CLI](https://github.com/nichochar/bird-cli)
2. 安装：clone 仓库 → `pnpm install` → `pnpm --filter @linkmind/probe run dev -- login`（device auth 流程，类似 GitHub CLI）
3. 运行：`... run dev -- run --foreground`，以及 launchd/systemd 常驻示例
4. 验证：发一条 Twitter 链接给 Bot，观察是否自动处理

（可选，后续优化：把 `@linkmind/probe` 发布为 npm 包，安装简化为 `npx @linkmind/probe login`——单独任务，不阻塞本计划。）

### 6. 存量 backlog 处理（代码完成后的运维步骤）

1. reorx 在自己 Mac 上运行 probe 连生产（device auth 以 user 1 身份）→ SSE subscribe 会自动重发 25 条 pending twitter 事件，逐条消化
2. 6 条 `browser` 类型事件对应的 records：先用 admin retry 重跑（Firecrawl 已修复，大概率不再需要 probe）；跑不过的留给 probe
3. 处理不掉的等超时清扫自动标记失败，属预期行为

## 涉及文件

| 文件 | 改动 |
|------|------|
| `server/src/notify.ts` | **新建** — 通知通道（setNotifier / notifyUser） |
| `server/src/probe-timeout-cron.ts` | **新建** — 超时清扫 cron |
| `server/src/bot.ts` | `pollAndNotify` 加 waiting_probe 分支；启动时 setNotifier；`formatResult` 提取到共享模块 |
| `server/src/pipeline.ts` | probe 数据任务完成后调用 notifyUser |
| `server/src/index.ts` | 启动 probe-timeout cron |
| `server/src/views/probe.ejs` + `routes/pages.ts` | **新建** — probe 安装教程页 |
| `server/src/db/probe.ts` | 超时查询函数（`getExpiredProbeEvents(ttl)`） |

## 测试（BDD：先写行为测试再实现）

`server/src/__tests__/probe-timeout.test.ts`（test DB，同 pipeline.test.ts bootstrap 模式）：

1. 超过 TTL 的 `pending` 事件 → 清扫后 event=expired、record=error、error_message 正确
2. 超过 TTL 的 `sent` 事件 → 同上
3. 未超 TTL 的事件 → 不动
4. event 超时但 record 已 analyzed（probe 曾回传）→ 只 expire event，record 不动
5. notifyUser：record 有 telegram_chat_id 时被调用一次（mock notifier），无 chat_id 时不调用且不抛错
6. handleProbeResult 恢复的 pipeline 完成后触发通知（mock）

## 验证

```bash
pnpm typecheck && pnpm test
# 本地端到端：发 Twitter 链接 → 收到 waiting_probe 提示 → 启动本地 probe → 收到结果消息
# 把 PROBE_WAIT_TTL_HOURS 设为 0.01 验证超时路径
```
