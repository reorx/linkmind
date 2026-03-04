---
created: 2026-03-04
tags:
  - hn
  - extractor
  - substance
  - summarize
  - pipeline
---

# 为 LinkMind 添加 Hacker News 讨论解析和专用摘要

## 概要

将 vibe-reader-hn 项目中的 HN 评论解析逻辑移植到 linkmind，作为 Substance Extractor 集成到现有的 scrape 流程中。HN URL（`news.ycombinator.com/item?id=xxx`）会自动走 HNExtractor 解析评论树并渲染为结构化 markdown，然后使用专门设计的 HN 讨论分析提示词进行 summarize，提取讨论中的关键反驳、个人经验、技术修正和争论等洞察，而不是像普通文章一样做内容摘要。

## 修改的文件

- `core/src/scraper-utils.ts` — 新增 `isHNUrl()` 函数，匹配 HN 讨论页 URL
- `server/src/extractors/hn.ts` — **新建** HNExtractor，从 vibe-reader-hn 移植评论解析（`parseComments` → `buildCommentTree` → `renderMarkdown`），支持长线程自动 condense，通过 Substance 的 `content.markdown` 回调直接产出 markdown
- `server/src/scraper-substance.ts` — 注册 HNExtractor 到 extractors 数组
- `server/src/prompts.ts` — 新增 `HN_SUMMARY_SYSTEM_PROMPT` 和 `buildHNSummaryUserPrompt()`，参考 hnread skill 的分析框架，按类别（反驳、经验、技术细节、争论）提取讨论洞察
- `server/src/agent.ts` — 新增 `generateHNSummary()` 函数，使用 HN 专用 prompt，maxTokens 4096
- `server/src/pipeline.ts` — 在 `summarizeStep` 中加入 `isHNUrl()` 分支，HN URL 调用 `generateHNSummary()` 而不是通用的 `generateSummary()`

## Git 提交记录

- `570576b` feat: add HN discussion extractor and specialized summarize prompts

## 注意事项

- **Substance Extractor 是添加新站点支持的标准方式**：fetch 走统一的 Playwright 流程，只在 HTML 解析阶段分流。新增站点只需在 `server/src/extractors/` 下创建 Extractor 并注册到 `scraper-substance.ts`
- **`content.markdown` 回调可以完全绕过 turndown**：对于 HN 这种需要自定义 markdown 格式的场景，直接在回调中产出 markdown，不走 HTML → turndown 转换
- **长线程 condense 策略**：当评论 markdown 超过 12000 字符时，自动删除低权重叶子节点（权重 = 后代数 × 文本长度），压缩到 60%，确保不超出 LLM context
- **HN 评论解析逻辑来自 vibe-reader-hn**：如果上游 hn-parser 有 bug fix，记得同步到 `extractors/hn.ts`
