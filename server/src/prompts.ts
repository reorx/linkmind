/**
 * Prompts: centralized prompt definitions for LLM interactions.
 */

/* ── Tag Format ── */

const TAG_FORMAT_INSTRUCTION = `标签格式要求：全部使用小写英文字母，单词之间用横杠 (-) 连接。
示例：machine-learning, open-source, real-time-search, api-design, developer-tools`;

/* ── Summary Prompts ── */

export const SUMMARY_SYSTEM_PROMPT = `你是一个信息分析助手。用户会给你一篇文章的内容，请你：
1. 生成摘要，具体要求遵循用户消息 (summary)
2. 提取 3-5 个关键标签 (tags)

${TAG_FORMAT_INSTRUCTION}

重要规则：
- 只基于实际提供的正文内容进行总结，绝对不要编造、推测或脑补原文中没有的信息
- 如果正文内容明显不完整（如只有导航栏、占位符、"继续滑动"等提示文字），请在 summary 中如实说明"原文内容未能完整获取"，并只基于标题和描述做简要说明
- 宁可输出较短的诚实摘要，也不要输出看似丰富但实际编造的内容

你还需要判断正文内容是否有意义 (valid_content)：
- 如果正文是真实的文章/帖子/讨论内容，与标题相关，有实质信息 → valid_content: true
- 如果正文只是页面导航、占位符、无关碎片、登录提示等无意义文字，或内容极少且与标题无关 → valid_content: false

你必须以 JSON 格式输出数据：
{"valid_content": true, "summary": "...", "tags": ["machine-learning", "api-design", ...]}
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

重要规则：
- 只基于提供的摘要和相关链接信息来生成 insight，不要编造原文中没有提到的内容
- 如果摘要信息明显不足或标注了"内容未能完整获取"，请诚实说明信息不足，不要强行生成 insight
- 不要把相关链接的内容混入当前文章的 insight 中，除非是在做明确的对比关联

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

/* ── Note Prompts ── */

export const NOTE_SUMMARY_SYSTEM_PROMPT = `你是一个信息分析助手。用户会给你一段笔记内容，请你：
1. 生成摘要，具体要求遵循用户消息 (summary)
2. 提取 3-5 个关键标签 (tags)

${TAG_FORMAT_INSTRUCTION}

你必须以 JSON 格式输出数据：
{"summary": "...", "tags": ["machine-learning", "api-design", ...]}
`;

export function buildNoteSummaryUserPrompt(content: string): string {
  const truncated = content.slice(0, 12000);

  return `
请严格按照以下要求总结这段笔记的内容，生成摘要 (summary):
1. 请使用中文进行总结，但对于一些关键信息和名词，请保留英文词并用括号放在中文后
2. 使用 markdown 格式输出 3-5 个列表条目，每条字数不超过 100 字，总字数不超过 500 字。
3. 可以向下展开子条目，但同样限制在 3-5 条。请仔细思考，输出有价值的内容
4. 直接输出总结，不要做额外声明。

<note_content>
${truncated}
</note_content>
`;
}

export const NOTE_TAGS_SYSTEM_PROMPT = `你是一个信息分析助手。用户会给你一段短文本，请你提取 3-5 个关键标签 (tags)。

${TAG_FORMAT_INSTRUCTION}

你必须以 JSON 格式输出数据：
{"tags": ["machine-learning", "api-design", ...]}
`;

export function buildNoteTagsUserPrompt(content: string): string {
  return `请为以下内容提取 3-5 个关键标签：

${content}
`;
}

export const NOTE_INSIGHT_SYSTEM_PROMPT = `你是用户的个人信息分析师。

你的任务是从**用户的角度**思考这段笔记的价值：
- 这段笔记记录了什么？有什么值得关注的？
- 和用户过去关注的内容有什么关联？
- 对用户的工作或项目有什么启发？
- 有没有值得进一步探索的方向？

语气要像朋友之间的分享，简洁有力，不要模板化的套话。3-5 句话即可。`;

export interface NoteInsightPromptInput {
  content: string;
  summary: string;
  relatedLinks: RelatedLinkContext[];
}

export function buildNoteInsightUserPrompt(input: NoteInsightPromptInput): string {
  const linksContext =
    input.relatedLinks.length > 0
      ? input.relatedLinks.map((l) => `- [${l.title}](${l.url}): ${l.summary.slice(0, 100)}`).join('\n')
      : '（无相关历史内容）';

  return `笔记内容: ${input.content.slice(0, 2000)}
摘要: ${input.summary}

用户之前收藏过的相关内容:
${linksContext}

请给出你的 insight：`;
}
