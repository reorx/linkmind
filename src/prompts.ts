/**
 * Prompts: centralized prompt definitions for LLM interactions.
 */

/* ── Summary Prompts ── */

export const SUMMARY_SYSTEM_PROMPT = `你是一个信息分析助手。用户会给你一篇文章的内容，请你：
1. 生成摘要，具体要求遵循用户消息 (summary)
2. 提取 3-5 个关键标签 (tags)

你必须以 JSON 格式输出数据：
{"summary": "...", "tags": ["tag1", "tag2", ...]}
`;

export interface SummaryPromptInput {
  url: string;
  title?: string;
  ogDescription?: string;
  markdown: string;
}

export function buildSummaryUserPrompt(input: SummaryPromptInput): string {
  // Truncate markdown to avoid token limits
  const content = input.markdown.slice(0, 12000);

  return `
请严格按照以下要求总结网页的内容，生成摘要 (summary):
1. 请使用中文进行总结，但对于一些关键信息和名词，请保留英文词并用括号放在中文后
2. 使用 markdown 格式输出 3-5 个列表条目，每条字数不超过 100 字，总字数不超过 500 字。
3. 可以向下展开子条目，但同样限制在 3-5 条。请仔细思考，输出有价值的内容
4. 直接输出总结，不要做额外声明。

<web_content>
标题: ${input.title || '无'}
来源: ${input.url}
描述: ${input.ogDescription || '无'}
正文:
${content}
</web_content>
`;
}

/* ── Insight Prompts ── */

export const INSIGHT_SYSTEM_PROMPT = `你是用户的个人信息分析师。

你的任务是从**用户的角度**思考这篇文章的价值：
- 这篇文章讲了什么新东西？有什么值得关注的？
- 和用户过去关注的内容有什么关联？
- 对用户的工作或项目有什么启发？
- 是否值得深入研究？

语气要像朋友之间的分享，简洁有力，不要模板化的套话。3-5 句话即可。`;

export interface RelatedLinkContext {
  title: string;
  url: string;
  summary: string;
}

export interface InsightPromptInput {
  url: string;
  title?: string;
  summary: string;
  relatedLinks: RelatedLinkContext[];
}

export function buildInsightUserPrompt(input: InsightPromptInput): string {
  const linksContext =
    input.relatedLinks.length > 0
      ? input.relatedLinks.map((l) => `- [${l.title}](${l.url}): ${l.summary.slice(0, 100)}`).join('\n')
      : '（无相关历史链接）';

  return `文章: ${input.title || input.url}
摘要: ${input.summary}

用户之前收藏过的相关链接:
${linksContext}

请给出你的 insight：`;
}
