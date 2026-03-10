---
created: 2026-03-10
tags:
  - llm
  - gemini
  - summary
  - pipeline
  - bug-fix
---

# 修复 Gemini summary JSON 截断问题，改用 XML 标签输出格式

## 概要

linkmind bot 处理微信文章时报错 `Unterminated string in JSON at position 145`。排查发现 Gemini `gemini-3-flash-preview` 在生成 summary 时返回截断的 JSON，`generateObject` 的 `JSON.parse` 失败（重试 2 次仍然失败）。根本原因是 JSON 格式对 LLM 输出截断极其脆弱——一个引号没闭合整个响应就无法解析。

修复分两步：(1) Gemini provider 加 `finishReason` 检查和日志；(2) summary 输出格式从 JSON 改为 XML 标签 + 纯文本，用正则解析，即使输出截断也能拿到前面已完成的字段。

## 排查过程

1. SSH 到 hh-hk-01 查看 `linkmind-server-1` Docker 日志
2. 定位到处理微信文章 `mp.weixin.qq.com/s/gBd3cPV6rI3g316om-P_iA`（智谱 AutoClaw 相关）
3. 确认微信抓取 fallback 机制正常工作：Crawlee 只拿到 37 字符 → 判定无效 → Playwright fallback 成功拿到 3989 字符
4. 核心问题是 Gemini `gemini-3-flash-preview` 两次返回截断 JSON，`generateObject` 的重试也无法修复
5. 发现 Gemini provider 未检查 `finishReason`，截断原因不可见

## 修改的文件

**修改文件：**
- `server/src/llm.ts` — Gemini provider 的 `chat` 方法提取 `candidate.finishReason`，非 `STOP` 时打 warn 日志（含 textPreview 前 500 字符），正常完成时 info 日志也带 finishReason
- `server/src/prompts.ts` — `SUMMARY_SYSTEM_PROMPT` 和 `HN_SUMMARY_SYSTEM_PROMPT` 输出格式从 JSON 改为 XML 标签 + 纯文本
- `server/src/agent.ts` — 新增 `parseSummaryOutput()` 函数用正则解析 XML 标签；`generateSummary` 和 `generateHNSummary` 改用普通 `chat()` + 正则解析，不再依赖 `generateObject`
- `server/src/__tests__/pipeline.test.ts` — mock 的 chat 返回按 label 区分，summary 返回 XML 标签格式

## 新的 summary 输出格式

```
<valid_content>true 或 false</valid_content>
<tags>tag1, tag2, tag3</tags>

摘要正文直接写在标签下方，使用纯文本（支持 markdown 格式）。
```

解析逻辑：正则提取 `<valid_content>` 和 `<tags>` 标签内容，剩余文本作为 summary。即使 LLM 输出在 summary 部分被截断，`valid_content` 和 `tags`（位于最前面）大概率已经完整。

## Commits

- `2629676` feat(llm): log Gemini finishReason, warn on non-STOP finishes
- `200c3c8` refactor(summary): replace JSON output with XML-tag format
