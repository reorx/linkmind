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
import {
  SUMMARY_SYSTEM_PROMPT,
  INSIGHT_SYSTEM_PROMPT,
  buildSummaryUserPrompt,
  buildInsightUserPrompt,
  type SummaryPromptInput,
  type RelatedLinkContext,
} from './prompts.js';

const log = logger.child({ module: 'agent' });

export interface SummaryResult {
  summary: string;
  tags: string[];
}

/**
 * Generate summary and extract tags from article content.
 */
export async function generateSummary(input: SummaryPromptInput): Promise<SummaryResult> {
  const userPrompt = buildSummaryUserPrompt(input);
  log.debug({ promptPreview: userPrompt.slice(0, 500) }, 'summary prompt (first 500 chars)');

  const text = await getLLM().chat(
    [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
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
  const relatedLinks: RelatedLinkContext[] = [];
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

  const userPrompt = buildInsightUserPrompt({
    url: input.url,
    title: input.title,
    summary,
    relatedLinks,
  });

  const text = await getLLM().chat(
    [
      { role: 'system', content: INSIGHT_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { maxTokens: 1024, label: 'insight' },
  );

  return text || '无法生成 insight';
}
