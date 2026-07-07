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
| Record Files + 对象存储（S3/R2/MinIO/Local） | [2026-02-26-record-files-storage.md](2026-02-26-record-files-storage.md) | ✅ Phase 1-5 完成；**Phase 6 清理 + 生产部署清单未做** |
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
- [ ] 验证 Web 端图片展示正常（发一张带图记录实测）
- [ ] Phase 6 清理：删除 `image-handler.ts`、`backfill-images.ts`、`records.images` 字段（写新 migration）、旧 `/images` 静态路由、模板 fallback

#### 3. 清理积压数据 + Probe 可用性策略

- [x] 重跑 5 条 failed 记录 → **全部 analyzed 成功**（2026-07-07；抓取链修复生效，note.mowen.cn 也拿到了正文）
- [x] ~~决策：生产 LLM 长期方案~~ → **已定：在 tc-sg-01 部署 LLM Gateway**（gemini/openai/anthropic 请求统一经 gateway 发出），见 TODO.md 2026-07-07 条目。背景：Gemini 被 ali-hk-01 地理封锁，现临时跑 qwen-plus，详见 [审计结果](../notes/2026-07-07-prod-audit-findings.md)
- [ ] 落地 LLM Gateway：tc-sg-01 部署（deploy workspace）+ `llm.ts` 给 `GEMINI_API_BASE` 加 env 覆盖 + 生产切回 `LLM_PROVIDER=gemini`
- [x] ~~决策：多用户场景下 Twitter 抓取怎么办~~ → **已定（2026-07-07）：用户在自己设备上跑 probe 进程**，服务端不提供共享 probe；未处理的等待超时后明确告知失败
- [ ] 实施 [probe 超时机制 + 用户告知](2026-07-07-probe-timeout-and-notify.md)：超时清扫 cron、Bot waiting_probe 即时反馈（当前 bot 对该状态零处理，5 分钟后显示误导性"处理超时"）、probe 迟到结果的完成通知、probe 安装教程页
- [ ] 处理积压：31 条 pending probe_events / 24 条 `waiting_probe` records（审计实测全部属于 user 1，25 twitter + 6 browser，最早 2026-01-31）。reorx 本机跑 probe 消化 twitter 事件；6 条 browser 类型先 admin retry（Firecrawl 已修复）；残余靠超时清扫收尾

#### 4. Bug 验证：insight 截断

TODO.md Bugs 记录"insight 会被截断"。相关修复（`2b78b0a` 移除 maxTokens、`200c3c8` summary 改 XML 格式、`2629676` 记录 finishReason）已提交，但**未确认 insight 本身是否仍会截断**：

- [ ] 在生产日志/Sentry 中搜索非 STOP 的 finishReason 记录
- [ ] 跑几条真实链接验证 insight 完整性；若仍截断，参照 [2026-03-11-insight-thinking-footnotes.md](2026-03-11-insight-thinking-footnotes.md) 中的 prompt 调整一并处理

#### 5. 计费限额上线验证

Usage billing 代码已合入，但作为收费/限额的守门功能，上线前需实测（参照 [usage-billing-design.md](usage-billing-design.md) 的管理接口一节）：

- [ ] 确认 `checkAndGetBudget` 在 bot 和 API 两个入口都生效（发链接超限 → 收到拒绝提示）
- [ ] 确认 admin billing 页面数据正确（commit `4b477a6`）
- [ ] 补齐/确认 CLI 管理命令：`set-limit`、`usage-report`、`reset-cycle`、`reconcile-usage`（design 中列出，`server/src/cli/` 下目前未见对应文件——需实现或确认替代入口）
- [ ] 设定合理的默认限额 `DEFAULT_CYCLE_LIMIT_USD`

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

## 建议执行顺序

```
第 1 周   P0-1 生产审计 → P0-2 record files 收尾 → P0-3 积压清理 + probe 策略
第 2 周   P0-4 insight 截断验证 → P0-5 计费验证 → P1-9 评分（顺手做掉）
第 3 周   P1-10 insight thinking/脚注 → P1-8 落地页
第 4 周   P1-11 搜索（最小版）→ P0-6 端到端走查 → P0-7 运维基线 → 上线
```

> 以上排期为推测性估计（每周按业余时间投入折算），实际以 P0-1 审计结果为准——若生产环境偏离预期（如 migration 落后较多），第 1 周会拉长。

## 未决问题（需要用户拍板）

1. ~~Twitter 抓取的多用户策略~~ → 已定（2026-07-07）：用户自己设备跑 probe + 超时告知，见 [probe 超时机制](2026-07-07-probe-timeout-and-notify.md)
2. 上线范围里是否包含搜索（P1-11）？不含则可提前约一周上线。
3. 默认用量限额定多少（P0-5）？design 默认 $1.00/周期。
4. 域名 / 品牌名是否已定？（影响落地页与 R2 公开域名配置）
5. ~~生产 LLM 长期方案~~ → 已定（2026-07-07）：tc-sg-01 部署 LLM Gateway，统一转发 gemini/openai/anthropic 请求（见 TODO.md）
