---
created: 2026-07-15
tags:
  - probe
  - undici
  - http2
  - sse
  - debugging
  - admin-cli
---

# 新机器初始化 probe 并修复 Node 26 fetch h2 导致的结果上传死锁

## 概要

本次 session 从"把 probe 在本地跑起来"开始：这台机器是全新环境（无依赖、无 `~/.linkmind-probe/` 配置、无 bird CLI、无 `.env`），完整走了一遍初始化——`pnpm install` + `pnpm build`、通过 SSH 到 ali-hk-01 在容器里 `gen-token` 拿生产 JWT 完成非交互式 device auth、安装 `@steipete/bird`（brew formula 已下架）。随后用户报告 record 210 一直卡在等待抓取状态，排查发现 probe 收到任务、bird 抓取 1.5 秒即成功，但 `receive_result` 上传 POST 无 socket、无报错地永久悬挂。经过多轮对照实验（前台/守护、单进程/跨进程、本地 HTTP/生产 HTTPS、GET/POST）和 `kill -USR1` 挂 inspector 检查活跃句柄，最终定位根因：**Node 26 的 fetch 默认协商 HTTP/2**，SSE 长连接与 POST 复用同一条 h2 会话，而 undici 不会在会话有在途请求时派发非幂等请求（`client-h2.js` 从 h1 pipelining 照搬的幂等门禁）——SSE 永不结束，POST 永久排队。修复：probe 入口 `setGlobalDispatcher(new Agent({ allowH2: false }))` 强制 HTTP/1.1，并给上传加 30s 超时和细粒度日志。E2E 验证全链路通过。顺带修复了 `admin-delete-record` 被 `probe_events`/`usage_transactions` 外键阻塞的既有 bug，并清理了测试记录。

## 修改的文件

- `probe/src/cli.ts` — 入口处设置 `setGlobalDispatcher(new Agent({ allowH2: false }))`，规避 h2 死锁（附详细注释说明原因）
- `probe/package.json` / `pnpm-lock.yaml` — 新增 `undici` 直接依赖
- `probe/src/daemon.ts` — `uploadResult` 增加 30s `AbortSignal.timeout`（杜绝无限悬挂）和上传前日志；`processEvent` 增加抓取完成日志
- `server/src/pipeline.ts` — `deleteRecordFull` 增加两步：删除引用该 record 的 `probe_events`、将 `usage_transactions.record_id` 置空（两个 FK 均无 ON DELETE，之前会直接删除失败）
- `server/src/db/probe.ts` — 新增 `deleteProbeEventsByLinkId()`
- `server/src/db/usage.ts` — 新增 `detachUsageFromRecord()`（保留计费历史，仅解除关联）
- `AGENTS.md` — 更新 bird 安装方式为 `pnpm add -g @steipete/bird`；新增 Node >= 26 h2 坑的警告条目

## 注意事项

- **Node >= 26 fetch 默认启用 HTTP/2**：同进程内"永不结束的流式请求（SSE）+ 同源非幂等请求（POST）"会死锁。触发需同时满足：同进程、同 dispatcher、同 origin、h2 会话。跨进程或独立 `dispatcher` 均不触发。生产容器 Node 22 不受影响，本机 homebrew node 26.3.1 会踩。
- **undici 幂等门禁的出处**：`lib/dispatcher/client-h2.js:194` 与 `client-h1.js:832` 注释一字不差——h1 pipelining 的重试歧义护栏被原样搬进 h2 路径，而 h2 的 GOAWAY 机制本已解决该问题。属于过度保守的移植缺陷。
- **保留 h2 的替代方案**（已实测）：给 SSE 单独一个 `Agent` 作为 `dispatcher`，POST 走全局 dispatcher，两条 h2 会话互不干扰。probe 场景 h2 无收益，故选择全局禁用。
- **诊断"fetch 无声卡死"的方法**：`kill -USR1 <pid>` 打开 inspector，用 CDP `Runtime.evaluate` 检查 `process._getActiveHandles()`（看有无 ChildProcess/多余 TLSSocket）、`process.getActiveResourcesInfo()`、TLSSocket 的 `alpnProtocol`。本次正是靠"只有一条 alpn=h2 的 TLSSocket、无 pending 请求"锁定 undici 内部排队。
- **管道缓冲陷阱**：`command | grep -vE ... > file` 后台运行时 grep 会块缓冲，`tail` 日志文件可能漏掉已发生的关键行，差点误判修复无效。排查时应直接读原始日志。
- **bird CLI 安装方式已变**：`pnpm add -g @steipete/bird`（binary 在 `~/Library/pnpm/`）；brew tap 里的 `bird` formula 已下架，`birdclaw` 是无关工具。
- **非交互式 device auth 全流程可用**：本地无 `.env.prod` 时，可 SSH 到服务器容器里 `gen-token` 拿 JWT，再 curl 三步完成授权（AGENTS.md 已有文档）。
- **删除 record 的完整依赖**：`records` 被 `probe_events.link_id` 和 `usage_transactions.record_id`（均无 ON DELETE）引用，`record_relations`/`record_files`/`shared_records` 是 CASCADE。新代码已处理前两者。

## 相关文档

- [Probe 超时与通知 session](2026-07-08-probe-timeout-and-notify.md) — 参考了其中 probe E2E 测试流程与非交互式 device auth 方法
