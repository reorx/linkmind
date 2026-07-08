---
created: 2026-07-08
tags:
  - deploy
  - ci-cd
  - probe
  - backlog
  - webhook
  - docker
---

# P0-3 收尾：修复 CI/CD 三层故障、部署 probe 超时机制、清零全部生产积压

## 概要

按 [before-launch 计划](../plans/2026-07-07-before-launch.md) 推进 P0-3 收尾（部署 + 积压清理）。push master 后连续排出三层 CI/CD 故障：① Docker 构建失败——镜像内 `pnpm@latest` 已升到 v11，不再读取 `package.json` 的 `pnpm.onlyBuiltDependencies` 且对被忽略的 build scripts 硬报错（`ERR_PNPM_IGNORED_BUILDS`），配置迁至 `pnpm-workspace.yaml` 并将 Dockerfile 的 pnpm 固定为本地同版本 10.25.0；② CD 静默失效——ali-hk-01 的 `/etc/webhook/hooks.json` token 被 7/7 某次未 export `WEBHOOK_SECRET` 的 ansible run 重新模板化为 `CHANGEME`，CI 的 deploy job 返回 200 但 hook 不触发，重新生成 token 同步 GitHub secrets（linkmind/vocalflow-rt）并在 webhook role 加 assert 防复发；③ 部署带宽瓶颈——生产实例公网带宽仅 ~1Mbps，而 Playwright 层排在源码 COPY 之后且 CI 无构建缓存，每次部署都全量拉 2.11GB，将 Playwright 层前置并给 build-push-action 加 GHA buildx cache，此后代码变更只拉小层。积压清理方面：用 curl 自动完成 probe 对生产的 device auth（无需浏览器交互），本机 probe daemon 一次性消化全部 31 条 pending probe_events（25 twitter + 6 browser，`browser→web` 兼容生效，0 错误），24 条 `waiting_probe` records 中 23 条 analyzed（nytimes #96 经 admin retry 成功），其余"卡在 scraped"的记录排查确认均为 `added_by_user=false` 的衍生链接——scraped 即其设计终态（`pipeline.ts` 有意跳过 summarize）。最终新容器 `16b9afb` 经修复后的 webhook 全自动部署，timeout cron 启动正常（ttlHours=24），`GET /probe` 教程页公网 200。

## 修改的文件

- `pnpm-workspace.yaml` — `onlyBuiltDependencies` 迁入（新增 esbuild），适配 pnpm v10/v11 的配置位置变更
- `package.json` — 移除 `pnpm` 字段，新增 `packageManager: pnpm@10.25.0`
- `Dockerfile` — 两处 `pnpm@latest` 固定为 `pnpm@10.25.0`；Playwright install 挪到源码 COPY 之前（稳定 ~500MB chromium 层）
- `.github/workflows/deploy.yml` — 新增 `docker/setup-buildx-action` + `cache-from/cache-to: type=gha`（层跨构建复用）
- `server/src/cli/admin-probe-stats.ts` — **新建**。查看 probe_events 按 status×url_type 分布、records 状态分布，`--list` 列出 pending/sent 明细
- `kb/plans/2026-07-07-before-launch.md` — P0-3 各项标记完成，记录附带修复
- `tmp/*.ts` — 临时排查脚本（absurd 队列状态、failed 任务、record 状态核对），未提交
- deploy workspace（不在本仓库）：`ansible/roles/webhook/tasks/main.yml` 加 assert 防 token 覆盖；`kb/docs/migration-hh-hk-01-to-ali-hk-01.md` 新增 §5 事故记录
- 服务器侧：`/etc/webhook/hooks.json` 新 token + restart；`/opt/apps/linkmind/.env` 临时 `PROBE_WAIT_TTL_HOURS=8760`（清完积压后已移除）
- 本机：`~/.linkmind-probe/config.json` 从本地 e2e 配置切换为生产（device auth 完成）

## 注意事项

- **probe device auth 可全程 curl 自动化**（无需浏览器）：`POST /api/auth/device` 拿 device_code/user_code → 用 `gen-token` 生成的 JWT 作 `lm_session` cookie `POST /auth/device/authorize`（body `user_code=XXX`）→ `POST /api/auth/token` 换 access_token → 手写 `~/.linkmind-probe/config.json`。已记入 AGENTS.md
- **衍生链接的终态是 scraped**：`added_by_user=false` 的 records（related 步骤发现的链接）流水线在 scrape 后有意停止（`pipeline.ts` "Derived link, stopping at scraped"），不做 summarize/insight。排查"卡住的 records"时先查 `added_by_user`，避免无意义 retry
- **Absurd 任务 completed ≠ record analyzed**：waiting_probe 转移、衍生链接提前返回等路径都会正常 complete 任务而 record 不到 analyzed；判断 pipeline 结果要看 records.status 而非任务状态
- **pnpm 版本务必三处一致**：本地、`packageManager` 字段、Dockerfile。`pnpm@latest` 的漂移是这次构建故障根因；未来升级 pnpm 要三处同步改
- **CI 全绿不等于部署成功**：webhook 200 但 "trigger rules were not satisfied" 是静默失败。排查路径：`journalctl -u webhook` → `cat /etc/webhook/hooks.json` 查 token 是否 `CHANGEME`
- **服务器手动长任务要用 nohup**：ali-hk-01 带宽 ~1Mbps，`docker compose pull` 需数小时，ssh 前台执行会因断连中途夭折
- **admin retry 对同一 record 幂等安全**：重复 retry 只是重跑 pipeline，衍生链接会再次停在 scraped，无副作用

## 遗留问题

- 生产实例（ecs.e-c1m2.large）公网带宽 ~1Mbps：连阿里云自家 OSS 都只有 9.5KB/s，建议控制台评估切「按量付费」调高峰值（HK 流量约 1 元/GB；有 GHA cache 后常规部署流量很小）
- 本机 probe 目前无常驻：session 里的前台进程已停，需要 `pnpm --filter @linkmind/probe run dev run`（daemon 模式）或配 launchd；device token 已授权生产可直接用
- breeze 仓库若有走 CI 的 CD，其 GitHub `WEBHOOK_SECRET` 尚未同步新 token（本次只同步了 linkmind/vocalflow-rt）
- master 本地领先 origin 6 个提交未 push（含另一 session 的 Web 列表/详情页重设计）；push 会触发 CD 上线 Web 改版，需用户拍板时机
- GHA cache 首次生效要看下次构建：若下次部署仍全量拉层，需检查 cache-from 是否命中

## 相关文档

- [Before Launch 计划](../plans/2026-07-07-before-launch.md) — 本 session 按此推进 P0-3 并更新进度
- [Probe 超时机制 session](2026-07-08-probe-timeout-and-notify.md) — 本次部署上线的功能即该 session 的产出
- [生产审计结果](../notes/2026-07-07-prod-audit-findings.md) — 积压数字（31 events / 24 records）的来源依据
