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

import { getLLM, generateObject, type UsageInfo } from './llm.js';

/* ── XML-tag parser for summary output ── */

function parseSummaryOutput(text: string): SummaryResult {
  // Extract <valid_content>...</valid_content>
  const validContentMatch = text.match(/<valid_content>\s*(true|false)\s*<\/valid_content>/i);
  const validContent = validContentMatch ? validContentMatch[1].toLowerCase() === 'true' : true;

  // Extract <tags>...</tags>
  const tagsMatch = text.match(/<tags>([\s\S]*?)<\/tags>/);
  const tags = tagsMatch
    ? tagsMatch[1]
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

  // Everything after the last closing tag is the summary
  let summary = text;
  const lastTagEnd = Math.max(
    text.lastIndexOf('</valid_content>') + '</valid_content>'.length,
    text.lastIndexOf('</tags>') + '</tags>'.length,
  );
  if (lastTagEnd > 0) {
    summary = text.slice(lastTagEnd).trim();
  }

  return {
    validContent,
    summary: summary || '无法生成摘要',
    tags,
  };
}
import { getRecord } from './db/index.js';
import { logger } from './logger.js';
import {
  SUMMARY_SYSTEM_PROMPT,
  HN_SUMMARY_SYSTEM_PROMPT,
  INSIGHT_SYSTEM_PROMPT,
  NOTE_SUMMARY_SYSTEM_PROMPT,
  NOTE_TAGS_SYSTEM_PROMPT,
  NOTE_INSIGHT_SYSTEM_PROMPT,
  buildSummaryUserPrompt,
  buildHNSummaryUserPrompt,
  buildInsightUserPrompt,
  buildNoteSummaryUserPrompt,
  buildNoteTagsUserPrompt,
  buildNoteInsightUserPrompt,
  type SummaryPromptInput,
  type HNSummaryPromptInput,
  type RelatedLinkContext,
} from './prompts.js';

const log = logger.child({ module: 'agent' });

export interface SummaryResult {
  validContent: boolean;
  summary: string;
  tags: string[];
}

export interface WithUsage<T> {
  result: T;
  usage?: UsageInfo;
}

/**
 * Generate summary and extract tags from article content.
 * Uses XML-tag format instead of JSON for robustness against LLM output truncation.
 */
export async function generateSummary(input: SummaryPromptInput): Promise<WithUsage<SummaryResult>> {
  const userPrompt = buildSummaryUserPrompt(input);
  log.debug({ promptPreview: userPrompt.slice(0, 500) }, 'summary prompt (first 500 chars)');

  const chatResult = await getLLM().chat(
    [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { label: 'summary', temperature: 0.1 },
  );

  const result = parseSummaryOutput(chatResult.text);
  log.debug(
    { validContent: result.validContent, tags: result.tags, summaryLength: result.summary.length },
    'summary parsed',
  );

  return { result, usage: chatResult.usage };
}

/**
 * Generate summary for a Hacker News discussion thread.
 * Uses HN-specific prompts that focus on extracting discussion insights.
 */
export async function generateHNSummary(input: HNSummaryPromptInput): Promise<WithUsage<SummaryResult>> {
  const userPrompt = buildHNSummaryUserPrompt(input);
  log.debug({ promptPreview: userPrompt.slice(0, 500) }, 'HN summary prompt (first 500 chars)');

  const chatResult = await getLLM().chat(
    [
      { role: 'system', content: HN_SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { label: 'hn-summary', temperature: 0.1 },
  );

  const result = parseSummaryOutput(chatResult.text);
  log.debug(
    { validContent: result.validContent, tags: result.tags, summaryLength: result.summary.length },
    'HN summary parsed',
  );

  return { result, usage: chatResult.usage };
}

/**
 * Generate insight based on article content and related links.
 * @param input - Article metadata
 * @param summary - Generated summary
 * @param relatedRecords - Related records with scores found via embedding search
 */
export async function generateInsight(
  input: { url: string; title?: string },
  summary: string,
  relatedRecords: Array<{ id: number; score: number }>,
): Promise<WithUsage<string>> {
  // Fetch related records details
  const relatedLinks: RelatedLinkContext[] = [];
  for (const rel of relatedRecords) {
    const record = await getRecord(rel.id);
    if (record) {
      relatedLinks.push({
        title: record.og_title || record.url || record.summary || 'Untitled',
        url: record.url || '',
        summary: record.summary || '',
        score: rel.score,
      });
    }
  }

  const userPrompt = buildInsightUserPrompt({
    url: input.url,
    title: input.title,
    summary,
    relatedLinks,
  });

  const chatResult = await getLLM().chat(
    [
      { role: 'system', content: INSIGHT_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { label: 'insight', temperature: 0.1 },
  );

  return { result: chatResult.text || '无法生成 insight', usage: chatResult.usage };
}

/**
 * Generate summary and tags from note content (for notes > 200 chars).
 */
export async function generateNoteSummary(content: string): Promise<WithUsage<SummaryResult>> {
  const userPrompt = buildNoteSummaryUserPrompt(content);
  log.debug({ promptPreview: userPrompt.slice(0, 500) }, 'note summary prompt (first 500 chars)');

  return generateObject<SummaryResult>(
    [
      { role: 'system', content: NOTE_SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    {
      label: 'note-summary',
      parse: (raw: any) => ({
        validContent: true, // Notes are always user-created, content is valid
        summary: raw.summary || '无法生成摘要',
        tags: Array.isArray(raw.tags) ? raw.tags : [],
      }),
    },
  );
}

/**
 * Generate only tags from short note content (for notes <= 200 chars).
 */
export async function generateNoteTags(content: string): Promise<WithUsage<string[]>> {
  const userPrompt = buildNoteTagsUserPrompt(content);

  return generateObject<string[]>(
    [
      { role: 'system', content: NOTE_TAGS_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    {
      label: 'note-tags',
      parse: (raw: any) => (Array.isArray(raw.tags) ? raw.tags : []),
    },
  );
}

/**
 * Generate insight for a note based on its content and related records.
 */
export async function generateNoteInsight(
  content: string,
  summary: string,
  relatedRecords: Array<{ id: number; score: number }>,
): Promise<WithUsage<string>> {
  const relatedLinks: RelatedLinkContext[] = [];
  for (const rel of relatedRecords) {
    const record = await getRecord(rel.id);
    if (record) {
      relatedLinks.push({
        title: record.og_title || record.url || record.summary || 'Untitled',
        url: record.url || '',
        summary: record.summary || '',
        score: rel.score,
      });
    }
  }

  const userPrompt = buildNoteInsightUserPrompt({
    content,
    summary,
    relatedLinks,
  });

  const chatResult = await getLLM().chat(
    [
      { role: 'system', content: NOTE_INSIGHT_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { label: 'note-insight' },
  );

  return { result: chatResult.text || '无法生成 insight', usage: chatResult.usage };
}
