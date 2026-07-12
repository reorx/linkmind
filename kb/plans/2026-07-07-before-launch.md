---
created: 2026-07-07
tags:
  - launch
  - roadmap
  - planning
---

# Before Launch — 上线前任务清单

> 项目自 2026-03-10 后停滞（最后一次功能提交为 Gemini JSON 截断修复），2026-07-07 恢复推进。
> 本文档基于对代码库、`kb/plans/`、`kb/notes/`、`TODO.md` 的全面盘点，列出上线前必须完成的任务，并链接到对应的方案文件。

## 上线定义

Telegram Bot + Web 的链接收藏分析 SaaS，**邀请制注册、免费使用（带用量软限额）**。生产环境已部署在 hh-hk-01（docker compose，`/opt/apps/linkmind/`），Twitter 抓取依赖本地 probe daemon。

---

## 现状盘点

### 已完成（有代码佐证）

| 功能 | 方案文档 | 状态 |
|------|---------|------|
| 统一 Record 模型（link/note/image） | [unified-record-model-plan](../notes/unified-record-model-plan.md) | ✅ 已实现 |
| Telegram 交互（回复加备注、转发消息） | [telegram-interaction-plan](../notes/telegram-interaction-plan.md), [forward-message-as-link-plan](../notes/forward-message-as-link-plan.md) | ✅ 已实现 |
| 抓取 fallback chain（Crawlee → Playwright → Jina → Firecrawl → Probe） | [robust-scraping-plan](../notes/robust-scraping-plan.md), [plan-jina-system-config](../notes/plan-jina-system-config.md) | ✅ 已实现 |
| WeChat / HN 专用提取器（Substance） | — （见 sessions/2026-03-04） | ✅ 已实现 |
| Kysely migration 框架 | [2026-02-26-kysely-migration.md](2026-02-26-kysely-migration.md) | ✅ 已实现 |
| Share 公开分享 | [2026-02-26-share-feature-design.md](2026-02-26-share-feature-design.md) | ✅ 已实现 |
| Record Files + 对象存储（S3/R2/MinIO/Local） | [2026-02-26-record-files-storage.md](2026-02-26-record-files-storage.md) | ✅ 全部完成（Phase 6 清理 + 生产 migration + 部署，2026-07-13） |
| Usage Billing（用量计费 + 软限额 + admin 页面） | [usage-billing-design.md](usage-billing-design.md), [usage-billing-review.md](usage-billing-review.md) | ✅ 已实现（migration `2026-03-04T1200-usage-billing.ts`） |
| CSV 导出/导入 + Settings 页 | [export-import-plan](../notes/export-import-plan.md) | ✅ 已实现 |
| Sentry/GlitchTip 错误追踪 | [sentry-integration-plan](../notes/sentry-integration-plan.md) | ✅ 已实现 |
| Summary 截断修复（JSON → XML 标签格式） | [session 2026-03-10](../sessions/2026-03-10-gemini-json-truncation-fix.md) | ✅ 已实现 |

### 已规划、未实现

| 功能 | 方案文档 | 说明 |
|------|---------|------|
| Scraper 抽象层（registry + YouTube stub） | [2026-03-11-scraper-abstraction.md](2026-03-11-scraper-abstraction.md) | 文件仍是平铺结构（`scraper.ts`, `scraper-*.ts`），未重构 |
| Insight thinking mode + 脚注引用 | [2026-03-11-insight-thinking-footnotes.md](2026-03-11-insight-thinking-footnotes.md) | `llm.ts` 无 thinking 支持，无 `insight-render.ts` |
| Record 评分（👍/👎 + 相关链接加权） | [2026-03-06-record-rating.md](2026-03-06-record-rating.md) | 无 rating 字段、无 callback handler |
| Probe QMD 搜索个人笔记 | [probe-qmd-search-plan](../notes/probe-qmd-search-plan.md) | 未实现 |
| 热门内容预加载 / Crawler 开放（CLI + API） | TODO.md 2026-03-16 / 03-17 | 无方案文档，仅想法 |

---

## 上线任务

### P0 — 上线阻塞项（必须完成）

#### 1. 生产环境状态审计（恢复工作的第一步）✅ 2026-07-07 完成

结果详见 [生产审计结果](../notes/2026-07-07-prod-audit-findings.md)。要点：**生产已迁移到 ali-hk-01**（2026-07-03，非 CLAUDE.md 记载的 hh-hk-01）；镜像即 master 最新代码，无落后。

- [x] 确认 server 容器运行状态、版本 → ali-hk-01 健康，revision `b675a70`（最新）
- [x] 核对 migration 状态 → Kysely 2 个均已应用，001-006 SQL 基线齐备
- [x] 检查 Absurd 队列 → 无积压，5 个 failed（重试耗尽，需 retry 验证）
- [x] 检查 Sentry → **`SENTRY_DSN` 从未配置**，错误追踪一直未启用（转入 P0-7）
- [x] 核对环境变量 → 发现 ali 迁移时丢失 `STORAGE_BACKEND`/`R2_*`/`FIRECRAWL_API_KEY`，**已修复并重启验证**；本地 `.env.prod` 备份已同步
- [x] 附带修复：停掉 hh-hk-01 僵尸副本（双 Bot 实例冲突风险）

#### 2. Record Files 生产收尾（审计发现大部分已完成）

参照 [2026-02-26-record-files-progress.md](2026-02-26-record-files-progress.md)：

- [x] 生产执行 `006_record_files.sql` → 已执行（审计确认）
- [x] R2 环境变量 → 已配置（2026-07-07 修复迁移时的丢失）
- [x] 旧 `records.images` 数据迁移 → 已完成（遗留数据 0 条）
- [x] 验证 Web 端图片展示正常 → **2026-07-08 生产实测通过**：清积压产生了 5 条带图记录（twitter/telegram），`/link/172` 页面 `<img>` 指向 `/files/records/172/0_twitter.jpg`，该端点从 R2 返回 image/jpeg 200。⚠️ 顺带发现 #58/#41 的 record_files 有重复行（同 storage_key 两条，疑似 retry 未去重），Phase 6 清理时一并处理
- [x] Phase 6 清理 → **代码完成**（commit `8d7f8f2`，2026-07-10）：删除 `image-handler.ts` + `backfill-images.ts`（stale，查的是不存在的 `links` 表）；移除 `/images` 静态路由、`RecordEntry/RecordsTable.images` 类型、helpers mapper、pages.ts（详情页+分享页）的 images 变量/模板参数、link-detail.ejs + admin record-detail.ejs 的 fallback；migration `2026-07-10T0013` DROP `records.images` 列
- [x] Phase 6 补充：`bot.ts` `pollAndNotify` 发图 → **改用 `getRecordFiles()` 从 storage 取首图 buffer 发送**（`new InputFile(buffer)`），取不到/失败回退纯文本
- [x] Phase 6 补充 ②：record_files 防重 → migration `2026-07-10T0012` 清重复行（保留最小 id）+ 加 `UNIQUE(record_id, storage_key)`；`insertRecordFile` 改 `onConflict.doUpdateSet` upsert；新增 `record-files.test.ts`（2 tests 过）
- [x] **生产收尾** → **2026-07-13 完成**：① 本地副本（`linkmind_pro_20260713`）预演通过——实际重复行为 #41/#56/#58 共 5 组（比预期多 #56 的 3 组），0012 清后 12→7 行、约束建成，0013 列已删；② 生产 migration 从本地直连 Neon 执行（部署前，无窗口期），只读抽查一致；③ push master（`16b9afb..f55f037`，13 commits 含 redesign `03520b5`，用户拍板一起上）→ CI 74s 绿 → webhook 自动部署，容器启动无错误；④ 上线抽查：`/link/56`、`/link/118` 图片走 `/files/records/...` 从 R2 出图（image/jpeg 200），部署后日志无 error/conflict。⚠️ 待用户手动验证：Telegram 发一条带图链接，确认 bot 发图走 record_files buffer 路径

#### 3. 清理积压数据 + Probe 可用性策略

- [x] 重跑 5 条 failed 记录 → **全部 analyzed 成功**（2026-07-07；抓取链修复生效，note.mowen.cn 也拿到了正文）
- [x] ~~决策：生产 LLM 长期方案~~ → **已定：在 tc-sg-01 部署 LLM Gateway**（gemini/openai/anthropic 请求统一经 gateway 发出），见 TODO.md 2026-07-07 条目。背景：Gemini 被 ali-hk-01 地理封锁，现临时跑 qwen-plus，详见 [审计结果](../notes/2026-07-07-prod-audit-findings.md)
- [ ] 落地 LLM Gateway：tc-sg-01 部署（deploy workspace）+ `llm.ts` 给 `GEMINI_API_BASE` 加 env 覆盖 + 生产切回 `LLM_PROVIDER=gemini`
- [x] ~~决策：多用户场景下 Twitter 抓取怎么办~~ → **已定（2026-07-07）：用户在自己设备上跑 probe 进程**，服务端不提供共享 probe；未处理的等待超时后明确告知失败
- [x] 实施 [probe 超时机制 + 用户告知](2026-07-07-probe-timeout-and-notify.md) → **代码完成**（commit `2f756e4`，2026-07-08）：超时清扫 cron、notify 通道、Bot waiting_probe 即时反馈、`/probe` 教程页
- [x] 部署上线：push master 触发 CD → 确认生产容器更新、timeout cron 启动日志正常 → **完成（2026-07-08）**：容器已更新到 `16b9afb`（webhook 自动部署），cron 启动日志正常（ttlHours=24, interval=10min），`GET /probe` 教程页公网 200。清积压期间临时加的 `PROBE_WAIT_TTL_HOURS=8760` 已移除并重启验证
  - 附带修复 ①：CI 构建失败——Docker 内 `pnpm@latest` 升到 v11 不再读 `package.json` 的 `pnpm.onlyBuiltDependencies`。配置迁到 `pnpm-workspace.yaml`（`289769d`）+ pin `pnpm@10.25.0`（`47460f1`）
  - 附带修复 ②：**CD 静默失效**——ali-hk-01 `/etc/webhook/hooks.json` 的 token 被 7/7 某次未带 `WEBHOOK_SECRET` 的 ansible run 打回 `CHANGEME`。已重新生成 token 同步 GitHub secrets（linkmind/vocalflow-rt）+ webhook role 加 assert 防复发（详见 deploy workspace 迁移文档 §5）
  - 附带修复 ③：部署带宽优化——Playwright 层挪到源码 COPY 前 + CI 加 buildx GHA cache（`16b9afb`），以后代码变更部署只拉小层
- [x] 修复已知问题：probe daemon（`probe/src/daemon.ts`）只认 `twitter`/`web`，server fallback 创建的是 `browser` 类型事件 → **已修复**（`5a05fad`，2026-07-08）：server 统一创建 `web`，daemon 兼容旧值 `browser`
- [x] 处理积压：31 条 pending probe_events / 24 条 `waiting_probe` records → **2026-07-08 全部清完**：本机 probe 经 device auth 连生产（curl 自动完成授权），一次性消化全部 31 条事件（browser→web 兼容生效，0 错误）；24 条 waiting_probe 中 23 条 analyzed（nytimes #96 经 admin retry 后成功）、#164 为衍生链接终态 scraped。另 admin retry 清查了 7 条历史 scraped records，确认均为 `added_by_user=false` 衍生链接，scraped 即设计终态，无积压残留

#### 4. Bug 验证：insight 截断 ✅ 2026-07-08 完成

TODO.md Bugs 记录"insight 会被截断"。相关修复（`2b78b0a` 移除 maxTokens、`200c3c8` summary 改 XML 格式、`2629676` 记录 finishReason）已提交，验证结论：

- [x] 数据验证（生产日志因容器重建已清零，改用 usage_transactions 的 output_tokens）：新增 `admin-llm-audit` CLI，150 天全历史 **0 条调用顶到 2048 cap**——insight 最大 351 tokens（prompt 限 500 字生效）、summary 最大 1071。**截断 bug 自 3 月修复后未再发生**
- [x] 抽查昨天 qwen 处理的 3 条 insight（#201/#56/#172）：结尾均为完整句子，无截断
- [x] 附带发现并修复（`461ddd9`）：`2b78b0a` 只删了调用处参数，`llm.ts` 两个 provider 里 `?? 2048` 默认 cap 一直还在（qwen 生产同样被限）；且 OpenAI 路径不记录 finish_reason，qwen 上截断不可观测。已改为不显式传参就不发 max_tokens，ChatResult 增加 `finishReason` 字段，OpenAI 路径非 stop 时 log.warn（对齐 Gemini 路径），带单测
- [x] qwen 质量评估：抽查的 summary/insight 中文流畅、结构好、能自然关联相关链接，质量可接受 → **LLM Gateway 切回 gemini 不紧迫**，可按原计划排期不提前
- 注：修复尚未部署（未 push；push 队列里还有未验证的 web 重设计 `03520b5`，部署时机待定）。上线后真实链接的端到端确认并入 P0-6 走查

#### 5. 计费限额上线验证 ✅ 2026-07-08 完成（默认限额留一个确认项）

Usage billing 代码已合入，上线前实测结果（commit `efc1401`）：

- [x] 入口检查：**发现并修复实现缺口**——design 要求 bot + API 双入口，实际只有 bot.ts 有（4 处）；`POST /api/links`、`/api/retry`、`/api/retry/:id` 完全绕过限额。已补上（超限返回 402 + usage 详情），本地实测：限额 0 → 402 拒绝；恢复限额 → 200 放行。bot 入口经代码确认（同一 `checkAndGetBudget` + `replyBudgetExceeded`，不再用真实 bot 实测以免与生产抢 getUpdates）
- [x] admin billing 页面（`/admin/usage`、`/admin/usage/:id`）本地实测数据正确，消费实时入账
- [x] CLI 命令已补齐（按项目规范加 `admin-` 前缀）：`admin-set-limit`、`admin-usage-report`、`admin-reset-cycle`、`admin-reconcile-usage`；新增 `setUserLimit`/`reconcileUsage` 函数带生命周期测试（Phase 6/7，20 tests 全过）。生产只读验证通过：reorx $0.072/$1.00，reconcile 账目同步
- [x] 默认限额：**建议维持代码默认 $1.00/周期，不配 env**。依据生产实测：单条 record ≈ $0.002（31 条积压花 $0.072），$1.00 ≈ 500 条/月，免费邀请制足够。⚠️ 如要改，生产 `.env.prod` 加 `DEFAULT_CYCLE_LIMIT_USD` 即可（未决问题 #3 可据此关闭）
- 注：本地测试 server 需绕开 `dotenv override`（cwd 放修改过的 `.env`，dummy bot token + 独立端口），直接 env var 覆盖无效——已踩坑（短暂用生产 token 起了本地 bot，~30s，已杀，生产轮询自动恢复）

#### 6. 新用户端到端体验走查（Dogfooding）

- [ ] 用一个全新 Telegram 账号走完整流程：邀请码 → 注册 → 发链接（普通网页 / WeChat / HN / Twitter / 转发消息 / 纯笔记）→ 收到 summary + insight → Web 登录查看 → 分享页
- [ ] 走查失败路径：无效链接、抓取全链失败、超限、probe 离线
- [ ] 记录并修复走查中发现的体验问题

#### 7. 运维基线

- [ ] 生产 DB 备份策略确认（Neon 自带 PITR 即可，确认保留周期）
- [ ] 部署流程演练一次（OpenClaw workspace `deploy/ansible/`，确认脚本在 4 个月后仍可用）
- [ ] 日志与告警：确认 Sentry 告警通知渠道可达（如 Telegram/邮件）

### P1 — 强烈建议在上线时具备

#### 8. 公开落地页 / 首页

当前 Web 只有登录后的界面（`login.ejs` 为入口）。上线需要一个未登录可见的产品介绍页：说明产品是什么、怎么获得邀请、Bot 的入口链接。（无现成方案文档，需新写一个简short plan。）

#### 9. Record 评分（👍/👎）

方案已完整：[2026-03-06-record-rating.md](2026-03-06-record-rating.md)。工作量小（一个 migration + callback handler + search 加权），且直接提升"相关链接"质量——这是产品的核心卖点，建议上线前做。

#### 10. Insight 质量提升（thinking + 脚注）

方案已完整：[2026-03-11-insight-thinking-footnotes.md](2026-03-11-insight-thinking-footnotes.md)。insight 是产品的差异化核心，配合 [FEEDBACK.md](../../FEEDBACK.md) 中用户反馈（相关链接要有 pitch、要有未读提示），建议上线前完成 thinking + 脚注部分，pitch/未读提示可放 post-launch。

#### 11. 搜索（Web + Telegram）

TODO.md 2026-03-05 条目。用户积累内容后没有搜索会明显影响留存。DB 已有 pgvector（002 BM25 索引为可选 ParadeDB）。无方案文档，需先写 plan。规模可裁剪：Web 端语义搜索先行，Telegram `/search` 命令次之。

### P2 — 明确推迟到上线后

| 项目 | 来源 | 推迟理由 |
|------|------|---------|
| Scraper 抽象层重构 + YouTube 支持 | [2026-03-11-scraper-abstraction.md](2026-03-11-scraper-abstraction.md) | 纯内部重构，现有 fallback chain 工作正常；YouTube 是新能力非阻塞项 |
| AI 问答（回复消息对话、调 insight prompt、个人 memory） | TODO.md 2026-03-05 | 大功能，需单独规划 |
| 热门内容预加载（HN/Twitter 缓存池） | TODO.md 2026-03-16 | 优化项，用户量起来后再做 |
| Crawler 能力开放（CLI / Reader API / 抓取历史） | TODO.md 2026-03-17 | 独立产品方向，上线后验证需求 |
| Probe QMD 搜索个人笔记 | [probe-qmd-search-plan](../notes/probe-qmd-search-plan.md) | 依赖 probe 生态成熟 |
| 消息 reaction 记录 / reply delete 命令 | TODO.md 2026-03-05 | 交互糖，非阻塞 |
| 付费/订阅支付接入 | — | 邀请制免费上线，billing 数据先积累，付费后置 |

---

## 当前状态与下一步顺序（2026-07-08 更新）

**已完成**：P0-1 审计（含两个附带生产修复）；P0-2 大部分；P0-3 代码（commit `2f756e4`，未 push）；三个关键决策（probe 用户自跑 / LLM Gateway on tc-sg-01 / 超时告知）。

**下个 session 按此顺序逐个解决**：

1. ~~**P0-3 收尾**~~ ✅ **2026-07-08 全部完成**（部署验证 + 积压清零）。遗留建议：生产实例（ecs.e-c1m2.large）公网带宽仅 ~1Mbps，建议在阿里云控制台评估调整计费方式/带宽；本机 probe 需用 `linkmind-probe run` 常驻（当前 device token 已连生产）
2. ~~**P0-4 insight 截断验证**~~ ✅ **2026-07-08 完成**：150 天数据 0 截断；顺手修掉 llm.ts 隐藏的 2048 默认 cap + qwen 路径 finish_reason 盲区（`461ddd9`，未 push）；qwen 质量可接受，LLM Gateway 不紧迫
3. ~~**P0-5 计费验证**~~ ✅ **2026-07-08 完成**：修掉 API 入口无限额检查的实现缺口 + 4 个 admin CLI + 实测通过（`efc1401`，未 push）；默认限额建议维持 $1.00（待你确认）
4. ~~**P0-2 剩余**~~ ✅ **2026-07-13 全部完成**：代码（`8d7f8f2`）+ 生产 migration（先于部署执行，无窗口期）+ 部署（含 redesign `03520b5` 一并上线，用户拍板）。详见 P0-2 清单末条
5. **LLM Gateway 落地**（可与 3/4 并行，deploy workspace 工作）：tc-sg-01 部署 gateway → `llm.ts` 加 `GEMINI_API_BASE` env 覆盖 → 生产切回 gemini
6. **P1 功能**：评分（9）→ insight thinking/脚注（10）→ 落地页（8）→ 搜索（11，范围待拍板）
7. **收官**：P0-6 端到端走查 → P0-7 运维基线（Sentry DSN、备份确认、部署演练）→ 上线

## 原始排期参考（2026-07-07 制定，供对照）

```
第 1 周   P0-1 生产审计 → P0-2 record files 收尾 → P0-3 积压清理 + probe 策略
第 2 周   P0-4 insight 截断验证 → P0-5 计费验证 → P1-9 评分（顺手做掉）
第 3 周   P1-10 insight thinking/脚注 → P1-8 落地页
第 4 周   P1-11 搜索（最小版）→ P0-6 端到端走查 → P0-7 运维基线 → 上线
```

## 未决问题（需要用户拍板）

1. ~~Twitter 抓取的多用户策略~~ → 已定（2026-07-07）：用户自己设备跑 probe + 超时告知，见 [probe 超时机制](2026-07-07-probe-timeout-and-notify.md)
2. 上线范围里是否包含搜索（P1-11）？不含则可提前约一周上线。
3. 默认用量限额定多少（P0-5）？design 默认 $1.00/周期。
4. 域名 / 品牌名是否已定？（影响落地页与 R2 公开域名配置）
5. ~~生产 LLM 长期方案~~ → 已定（2026-07-07）：tc-sg-01 部署 LLM Gateway，统一转发 gemini/openai/anthropic 请求（见 TODO.md）
