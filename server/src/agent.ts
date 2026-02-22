/**
 * Agent: LLM-powered content analysis.
 *
 * Provides:
 * - generateSummary: Generate summary and tags from article content
 * - generateInsight: Generate insight with related links context
 * - generateNoteSummary: Generate summary and tags from note content
 * - generateNoteTags: Generate only tags from short note content
 * - generateNoteInsight: Generate insight for a note
 */

import { getLLM } from './llm.js';
import { getRecord } from './db/index.js';
import { logger } from './logger.js';
import {
  SUMMARY_SYSTEM_PROMPT,
  INSIGHT_SYSTEM_PROMPT,
  NOTE_SUMMARY_SYSTEM_PROMPT,
  NOTE_TAGS_SYSTEM_PROMPT,
  NOTE_INSIGHT_SYSTEM_PROMPT,
  buildSummaryUserPrompt,
  buildInsightUserPrompt,
  buildNoteSummaryUserPrompt,
  buildNoteTagsUserPrompt,
  buildNoteInsightUserPrompt,
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
 * @param relatedRecordIds - IDs of related records found via embedding search
 */
export async function generateInsight(
  input: { url: string; title?: string },
  summary: string,
  relatedRecordIds: number[],
): Promise<string> {
  // Fetch related records details
  const relatedLinks: RelatedLinkContext[] = [];
  for (const id of relatedRecordIds) {
    const record = await getRecord(id);
    if (record) {
      relatedLinks.push({
        title: record.og_title || record.url || record.summary || 'Untitled',
        url: record.url || '',
        summary: record.summary || '',
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

/**
 * Generate summary and tags from note content (for notes > 200 chars).
 */
export async function generateNoteSummary(content: string): Promise<SummaryResult> {
  const userPrompt = buildNoteSummaryUserPrompt(content);
  log.debug({ promptPreview: userPrompt.slice(0, 500) }, 'note summary prompt (first 500 chars)');

  const text = await getLLM().chat(
    [
      { role: 'system', content: NOTE_SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { maxTokens: 2048, jsonMode: true, label: 'note-summary' },
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
 * Generate only tags from short note content (for notes <= 200 chars).
 */
export async function generateNoteTags(content: string): Promise<string[]> {
  const userPrompt = buildNoteTagsUserPrompt(content);

  const text = await getLLM().chat(
    [
      { role: 'system', content: NOTE_TAGS_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { maxTokens: 512, jsonMode: true, label: 'note-tags' },
  );

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.tags) ? parsed.tags : [];
  } catch {
    return [];
  }
}

/**
 * Generate insight for a note based on its content and related records.
 */
export async function generateNoteInsight(
  content: string,
  summary: string,
  relatedRecordIds: number[],
): Promise<string> {
  const relatedLinks: RelatedLinkContext[] = [];
  for (const id of relatedRecordIds) {
    const record = await getRecord(id);
    if (record) {
      relatedLinks.push({
        title: record.og_title || record.url || record.summary || 'Untitled',
        url: record.url || '',
        summary: record.summary || '',
      });
    }
  }

  const userPrompt = buildNoteInsightUserPrompt({
    content,
    summary,
    relatedLinks,
  });

  const text = await getLLM().chat(
    [
      { role: 'system', content: NOTE_INSIGHT_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { maxTokens: 1024, label: 'note-insight' },
  );

  return text || '无法生成 insight';
}
