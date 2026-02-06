/**
 * Agent: LLM-powered content analysis.
 *
 * Provides:
 * - generateSummary: Generate summary and tags from article content
 * - generateInsight: Generate insight with related links context
 */

import { getLLM } from './llm.js';
import { getLink } from './db.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'agent' });

export interface SummaryResult {
  summary: string;
  tags: string[];
}

/**
 * Generate summary and extract tags from article content.
 */
export async function generateSummary(input: {
  url: string;
  title?: string;
  ogDescription?: string;
  markdown: string;
}): Promise<SummaryResult> {
  // Truncate markdown to avoid token limits
  const content = input.markdown.slice(0, 12000);

  const userPrompt = `标题: ${input.title || '无'}
来源: ${input.url}
描述: ${input.ogDescription || '无'}

正文:
${content}`;
  log.debug({ promptPreview: userPrompt.slice(0, 500) }, 'summary prompt (first 500 chars)');

  const text = await getLLM().chat(
    [
      {
        role: 'system',
        content: `你是一个信息分析助手。用户会给你一篇文章的内容，请你：
1. 用中文写一个简洁的摘要（3-5句话），抓住核心要点。无论原文是什么语言，摘要必须使用中文。
2. 提取 3-5 个关键标签（用于后续搜索关联内容）

以 JSON 格式输出：
{"summary": "...", "tags": ["tag1", "tag2", ...]}

注意：summary 字段必须是中文，不要使用英文。`,
      },
      {
        role: 'user',
        content: userPrompt,
      },
    ],
    { maxTokens: 2048, jsonMode: true, label: 'summary' },
  );

  try {
    const parsed = JSON.parse(text);
    return {
      summary: parsed.summary || '无法生成摘要',
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    };
  } catch {
    return { summary: text.slice(0, 500), tags: [] };
  }
}

/**
 * Generate insight based on article content and related links.
 * @param input - Article metadata
 * @param summary - Generated summary
 * @param relatedLinkIds - IDs of related links found via embedding search
 */
export async function generateInsight(
  input: { url: string; title?: string },
  summary: string,
  relatedLinkIds: number[],
): Promise<string> {
  // Fetch related links details
  const relatedLinks: { title: string; url: string; summary: string }[] = [];
  for (const id of relatedLinkIds) {
    const link = await getLink(id);
    if (link) {
      relatedLinks.push({
        title: link.og_title || link.url,
        url: link.url,
        summary: link.summary || '',
      });
    }
  }

  const linksContext =
    relatedLinks.length > 0
      ? relatedLinks.map((l) => `- [${l.title}](${l.url}): ${l.summary.slice(0, 100)}`).join('\n')
      : '（无相关历史链接）';

  const text = await getLLM().chat(
    [
      {
        role: 'system',
        content: `你是用户的个人信息分析师。用户是一个 web 开发者，关注 AI 工具、开发者工具和开源项目。

你的任务是从**用户的角度**思考这篇文章的价值：
- 这篇文章讲了什么新东西？有什么值得关注的？
- 和用户过去关注的内容有什么关联？
- 对用户的工作或项目有什么启发？
- 是否值得深入研究？

语气要像朋友之间的分享，简洁有力，不要模板化的套话。2-4 句话即可。`,
      },
      {
        role: 'user',
        content: `文章: ${input.title || input.url}
摘要: ${summary}

用户之前收藏过的相关链接:
${linksContext}

请给出你的 insight：`,
      },
    ],
    { maxTokens: 1024, label: 'insight' },
  );

  return text || '无法生成 insight';
}
