/**
 * Pipeline: single source of truth for link processing logic.
 *
 * Pipeline steps: scrape → summarize → embed → related → insight → export
 *
 * Contains:
 *   - Step functions: scrapeStep / summarizeStep / embedStep / relatedStep / insightStep / exportStep
 *   - Absurd durable execution: task registration, worker lifecycle
 *   - Public API: processUrl, retryRecord, spawnProcessLink, spawnRefreshRelated, startWorker
 *   - Utilities: deleteRecordFull, refreshRelated
 */

import crypto from 'crypto';
import { Absurd } from 'absurd-sdk';
import {
  insertRecord,
  updateRecord,
  getRecord,
  getRecordByUrl,
  getAllAnalyzedRecords,
  deleteRecord,
  removeFromRelatedRecords,
  saveRelatedRecords,
  createProbeEvent,
  getProbeEventById,
  updateProbeEventStatus,
  type RecordEntry,
} from './db/index.js';
import type { ScrapeData } from '@linkmind/core';
import { scrapeUrl, isTwitterUrl, isScrapeContentValid, scrapeWithFallbackChain } from './scraper.js';
import { scrapeWithFirecrawl } from './scraper-firecrawl.js';
import { processTwitterMedia } from './media-handler.js';
import {
  generateSummary,
  generateInsight,
  generateNoteSummary,
  generateNoteTags,
  generateNoteInsight,
} from './agent.js';
import { createEmbedding } from './llm.js';
import { searchRelatedRecords, type RelatedRecordResult } from './search.js';
// File export disabled for cloud deployment; renderMarkdown kept in export.ts for future use
import { Sentry } from './sentry.js';
import { logger } from './logger.js';
import { AgentEventEmitter } from './agent-event-emitter.js';

const log = logger.child({ module: 'pipeline' });

/* ── Absurd infrastructure ── */

const QUEUE_NAME = 'linkmind';

let absurd: Absurd | null = null;

function getAbsurd(): Absurd {
  if (absurd) return absurd;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }

  absurd = new Absurd({
    db: connectionString,
    queueName: QUEUE_NAME,
  });

  return absurd;
}

/* ── Types ── */

export type { ScrapeData } from '@linkmind/core';

interface ProcessLinkParams {
  userId: number;
  url: string;
  recordId?: number; // set if re-processing existing record
  scrapeData?: ScrapeData; // provided by probe device
}

interface ProcessNoteParams {
  userId: number;
  recordId: number;
}

interface RefreshRelatedParams {
  recordId: number;
}

export interface SpawnProcessResult {
  taskId: string;
  recordId?: number;
}

/* ── Step functions (core business logic) ── */

interface ScrapeStepResult {
  title?: string;
  ogDescription?: string;
  siteName?: string;
  markdownLength: number;
  ocrTexts: string[];
}

/**
 * Step 1: Scrape a URL - fetch content via Playwright/Defuddle, process Twitter images + OCR.
 */
async function scrapeStep(recordId: number, url: string): Promise<ScrapeStepResult> {
  log.info({ recordId, url }, '[scrape] Starting');
  const result = await scrapeUrl(url);

  await updateRecord(recordId, {
    og_title: result.og.title,
    og_description: result.og.description,
    og_image: result.og.image,
    og_site_name: result.og.siteName,
    og_type: result.og.type,
    markdown: result.markdown,
    status: 'scraped',
  });

  log.info({ recordId, title: result.og.title, chars: result.markdown.length }, '[scrape] OK');

  // Process Twitter images → object storage + record_files
  let ocrTexts: string[] = [];
  if (isTwitterUrl(url) && result.rawMedia?.length) {
    try {
      const { results: mediaResults, ocrTexts: extractedOcr } = await processTwitterMedia(recordId, result.rawMedia);
      if (mediaResults.length > 0) {
        log.info({ recordId, count: mediaResults.length }, '[media] Twitter images stored');
      }
      ocrTexts = extractedOcr;
    } catch (imgErr) {
      log.warn(
        { recordId, err: imgErr instanceof Error ? imgErr.message : String(imgErr) },
        '[media] Failed (non-fatal)',
      );
      Sentry.captureException(imgErr, {
        level: 'warning',
        tags: { step: 'scrape', sub: 'twitter-images' },
        extra: { recordId },
      });
    }
  }

  return {
    title: result.og.title,
    ogDescription: result.og.description,
    siteName: result.og.siteName,
    markdownLength: result.markdown.length,
    ocrTexts,
  };
}

/**
 * Step 1 (with fallback): Playwright → retry Playwright → Firecrawl → Probe.
 * Returns null when falling back to probe (record enters waiting_probe state).
 */
async function scrapeStepWithFallback(
  recordId: number,
  url: string,
  userId: number,
  options?: { skipPlaywright?: boolean },
): Promise<ScrapeStepResult | null> {
  const chainResult = await scrapeWithFallbackChain(url, options);

  log.info(
    { recordId, source: chainResult.source, trace: chainResult.trace },
    '[scrape] Fallback chain completed',
  );

  if (chainResult.data && chainResult.source) {
    // A step succeeded — update record with the result
    const data = chainResult.data;
    await updateRecord(recordId, {
      og_title: data.og.title,
      og_description: data.og.description,
      og_image: data.og.image,
      og_site_name: data.og.siteName,
      og_type: data.og.type,
      markdown: data.markdown,
      status: 'scraped',
    });

    log.info({ recordId, source: chainResult.source, chars: data.markdown.length }, '[scrape] OK');

    // Process Twitter images if applicable
    let ocrTexts: string[] = [];
    if (isTwitterUrl(url) && data.rawMedia?.length) {
      try {
        const { results: mediaResults, ocrTexts: extractedOcr } = await processTwitterMedia(recordId, data.rawMedia);
        if (mediaResults.length > 0) {
          log.info({ recordId, count: mediaResults.length }, '[media] Twitter images stored');
        }
        ocrTexts = extractedOcr;
      } catch (imgErr) {
        log.warn(
          { recordId, err: imgErr instanceof Error ? imgErr.message : String(imgErr) },
          '[media] Failed (non-fatal)',
        );
        Sentry.captureException(imgErr, {
          level: 'warning',
          tags: { step: 'scrape', sub: 'twitter-images' },
          extra: { recordId },
        });
      }
    }

    return {
      title: data.og.title,
      ogDescription: data.og.description,
      siteName: data.og.siteName,
      markdownLength: data.markdown.length,
      ocrTexts,
    };
  }

  // All server-side methods failed — fallback to probe
  log.info({ recordId, url }, '[scrape] All server-side methods failed, falling back to probe');
  const { pushEventToProbe } = await import('./web.js');
  const eventId = crypto.randomBytes(8).toString('hex');
  await createProbeEvent(eventId, userId, recordId, url, 'browser');
  await updateRecord(recordId, { status: 'waiting_probe' });

  pushEventToProbe(userId, 'scrape_request', {
    event_id: eventId,
    url,
    url_type: 'browser',
    link_id: recordId,
  });

  log.info({ recordId, url, eventId }, '[scrape] Waiting for probe (browser), returning early');
  return null;
}

/**
 * Helper: check if a record was ingested with content (skip scrape on process/reprocess).
 */
async function isIngestedWithContent(recordId: number): Promise<boolean> {
  const record = await getRecord(recordId);
  return !!record?.ingested_with_content;
}

/**
 * Helper: get markdown from a record (used by fallback chain to check content validity).
 */
async function getRecordMarkdown(recordId: number): Promise<string> {
  const record = await getRecord(recordId);
  return record?.markdown || '';
}

interface SummarizeStepResult {
  validContent: boolean;
  summary: string;
  tags: string[];
}

/**
 * Step 2: Summarize - generate summary and tags via LLM.
 */
async function summarizeStep(
  recordId: number,
  url: string,
  scrapeData: ScrapeStepResult,
): Promise<SummarizeStepResult> {
  const record = await getRecord(recordId);
  if (!record?.markdown) throw new Error('Record markdown not found after scrape');

  log.info({ recordId, title: scrapeData.title }, '[summarize] Starting');

  // Append OCR text to markdown for LLM context
  let markdownForSummary = record.markdown;
  if (scrapeData.ocrTexts.length > 0) {
    markdownForSummary += '\n\n---\n**图片文字 (OCR):**\n' + scrapeData.ocrTexts.join('\n\n');
  }

  const result = await generateSummary({
    url,
    title: scrapeData.title,
    ogDescription: scrapeData.ogDescription,
    markdown: markdownForSummary,
  });

  await updateRecord(recordId, {
    summary: result.summary,
    tags: JSON.stringify(result.tags),
  });

  log.info({ recordId, tags: result.tags.length, validContent: result.validContent }, '[summarize] OK');
  return result;
}

/**
 * Step 3: Embed - generate embedding vector for summary only.
 */
async function embedStep(recordId: number): Promise<number[]> {
  const record = await getRecord(recordId);
  if (!record?.summary) throw new Error('Record summary not found for embedding');

  log.info({ recordId, title: record.og_title }, '[embed] Starting');

  const embedding = await createEmbedding(record.summary);

  // Store embedding as PostgreSQL vector format
  const vectorStr = `[${embedding.join(',')}]`;
  await updateRecord(recordId, { summary_embedding: vectorStr } as any);

  log.info({ recordId, dimensions: embedding.length }, '[embed] OK');
  return embedding;
}

const RELATED_SCORE_THRESHOLD = 0.65; // Minimum score to save relation
const RELATED_MAX_COUNT = 5; // Maximum related links to save

/**
 * Step 4: Related - search for related links based on summary embedding.
 * Filters by score threshold and saves to link_relations table.
 */
async function relatedStep(recordId: number, userId: number, embedding: number[]): Promise<RelatedRecordResult[]> {
  log.info({ recordId }, '[related] Starting');

  // Search more than we need, then filter by threshold
  const searchResults = await searchRelatedRecords(embedding, userId, recordId, 10);

  // Filter by threshold and take top N
  const relatedRecords = searchResults.filter((r) => r.score >= RELATED_SCORE_THRESHOLD).slice(0, RELATED_MAX_COUNT);

  // Save to link_relations table
  await saveRelatedRecords(
    recordId,
    relatedRecords.map((r) => ({ relatedRecordId: r.id, score: r.score })),
  );

  // Also update JSON field for backward compat (can remove later)
  await updateRecord(recordId, {
    related_links: JSON.stringify(relatedRecords),
    related_notes: JSON.stringify([]),
  });

  log.info(
    { recordId, searched: searchResults.length, saved: relatedRecords.length, threshold: RELATED_SCORE_THRESHOLD },
    '[related] OK',
  );
  return relatedRecords;
}

/**
 * Step 5: Insight - generate insight with related links context.
 */
async function insightStep(
  recordId: number,
  url: string,
  title: string | undefined,
  summary: string,
  relatedIds: number[],
): Promise<void> {
  log.info({ recordId, relatedCount: relatedIds.length }, '[insight] Starting');

  const insight = await generateInsight({ url, title }, summary, relatedIds);

  await updateRecord(recordId, {
    insight,
    status: 'analyzed',
  });

  log.info({ recordId }, '[insight] OK');
}

/**
 * Step 6: Export - export link to markdown file + trigger QMD re-index.
 * Currently disabled for cloud deployment.
 */
async function exportStep(_recordId: number): Promise<void> {
  // File export disabled; renderMarkdown kept in export.ts for future use
}

/* ── Absurd task registration ── */

export function registerTasks(): void {
  const app = getAbsurd();

  app.registerTask({ name: 'process-link' }, async (params: ProcessLinkParams, ctx) => {
    const { userId, url } = params;

    // Resolve or create recordId, and reset status to pending
    let recordId = params.recordId;
    if (recordId) {
      // Existing record passed directly - reset status
      await updateRecord(recordId, { status: 'pending', error_message: null as any });
    } else {
      const existing = await getRecordByUrl(userId, url);
      if (existing?.id) {
        recordId = existing.id;
        await updateRecord(recordId, { status: 'pending', error_message: null as any });
      } else {
        recordId = await insertRecord(userId, { url });
      }
    }

    const emitter = new AgentEventEmitter({ refType: 'record', refId: String(recordId), agentName: 'process-link' });
    await emitter.startSession();
    await emitter.emitMessage('Pipeline starting', { recordId, url, taskId: ctx.taskID });

    try {
      // Step 1: Scrape (or use probe data, or defer to probe)
      let scrapeData: ScrapeStepResult;

      if (params.scrapeData) {
        // Probe provided scrape data — populate record directly
        const scrapeStart = Date.now();
        await emitter.emitStepStart('scrape', { url, source: 'probe' });
        scrapeData = await ctx.step('scrape', async () => {
          const sd = params.scrapeData!;
          await updateRecord(recordId!, {
            og_title: sd.og_title,
            og_description: sd.og_description,
            og_image: sd.og_image,
            og_site_name: sd.og_site_name,
            og_type: sd.og_type,
            markdown: sd.markdown,
            status: 'scraped',
          });

          log.info({ recordId, title: sd.og_title, chars: sd.markdown.length }, '[scrape] OK (from probe)');

          // Process images if provided
          let ocrTexts: string[] = [];
          if (isTwitterUrl(url) && sd.raw_media?.length) {
            try {
              const { results: mediaResults, ocrTexts: extractedOcr } = await processTwitterMedia(recordId!, sd.raw_media);
              if (mediaResults.length > 0) {
                log.info({ recordId, count: mediaResults.length }, '[media] Twitter images stored (from probe)');
              }
              ocrTexts = extractedOcr;
            } catch (imgErr) {
              log.warn(
                { recordId, err: imgErr instanceof Error ? imgErr.message : String(imgErr) },
                '[media] Failed (non-fatal)',
              );
              Sentry.captureException(imgErr, {
                level: 'warning',
                tags: { step: 'scrape', sub: 'twitter-images' },
                extra: { recordId },
              });
            }
          }

          return {
            title: sd.og_title,
            ogDescription: sd.og_description,
            siteName: sd.og_site_name,
            markdownLength: sd.markdown.length,
            ocrTexts,
          } satisfies ScrapeStepResult;
        });
        await emitter.emitStepEnd(
          'scrape',
          { source: 'probe', chars: scrapeData.markdownLength },
          Date.now() - scrapeStart,
        );
      } else if (await isIngestedWithContent(recordId!)) {
        // Content provided at ingest time (e.g. forwarded Telegram channel message) — skip scrape
        const scrapeStart = Date.now();
        await emitter.emitStepStart('scrape', { url, source: 'ingest' });
        const record = await getRecord(recordId!);
        scrapeData = {
          title: record?.og_title || undefined,
          ogDescription: record?.og_description || undefined,
          siteName: record?.og_site_name || undefined,
          markdownLength: record?.markdown?.length || 0,
          ocrTexts: [],
        };
        await updateRecord(recordId!, { status: 'scraped' });
        await emitter.emitStepEnd(
          'scrape',
          { source: 'ingest', chars: scrapeData.markdownLength },
          Date.now() - scrapeStart,
        );
      } else if (isTwitterUrl(url)) {
        // Twitter URL without probe data — create probe event and wait
        const { pushEventToProbe } = await import('./web.js');
        const eventId = crypto.randomBytes(8).toString('hex');
        await createProbeEvent(eventId, userId, recordId!, url, 'twitter');
        await updateRecord(recordId!, { status: 'waiting_probe' });

        pushEventToProbe(userId, 'scrape_request', {
          event_id: eventId,
          url,
          url_type: 'twitter',
          link_id: recordId,
        });

        await emitter.emitMessage('Waiting for probe (twitter), pipeline suspended', { eventId, urlType: 'twitter' });
        return { recordId, title: undefined, status: 'waiting_probe' };
      } else {
        // Normal scrape with fallback chain: Playwright → retry Playwright → Firecrawl → Probe
        const scrapeStart = Date.now();
        await emitter.emitStepStart('scrape', { url });
        const scrapeResult = await ctx.step('scrape', async () => {
          return await scrapeStepWithFallback(recordId!, url, userId);
        });

        // scrapeStepWithFallback returns null when falling back to probe (waiting_probe)
        if (scrapeResult === null) {
          await emitter.emitStepEnd('scrape', { status: 'waiting_probe' });
          await emitter.emitMessage('Falling back to probe, pipeline suspended', {});
          return { recordId, title: undefined, status: 'waiting_probe' };
        }
        await emitter.emitStepEnd('scrape', { chars: scrapeResult.markdownLength }, Date.now() - scrapeStart);
        scrapeData = scrapeResult;
      }

      // Check if this is a derived link (added_by_user=false) — stop at scraped
      const currentRecord = await getRecord(recordId!);
      if (currentRecord && !currentRecord.added_by_user) {
        await emitter.emitMessage('Derived link, stopping at scraped', {});
        await emitter.endSession('completed');
        return { recordId, title: scrapeData.title, status: 'scraped' };
      }

      // Step 2: Summarize
      let stepStart = Date.now();
      await emitter.emitStepStart('summarize');
      let summaryData = await ctx.step('summarize', async () => {
        return await summarizeStep(recordId!, url, scrapeData);
      });
      await emitter.emitStepEnd(
        'summarize',
        { validContent: summaryData.validContent, tags: summaryData.tags.length },
        Date.now() - stepStart,
      );

      // Step 2.5: If LLM determined content is invalid, re-scrape via Firecrawl/Probe and re-summarize
      if (!summaryData.validContent) {
        await emitter.emitMessage('Summary flagged invalid content, re-scraping', {});

        stepStart = Date.now();
        await emitter.emitStepStart('re-scrape', { skipPlaywright: true });
        const reScrapeResult = await ctx.step('re-scrape', async () => {
          return await scrapeStepWithFallback(recordId!, url, userId, { skipPlaywright: true });
        });

        if (reScrapeResult === null) {
          await emitter.emitStepEnd('re-scrape', { status: 'waiting_probe' });
          await emitter.emitMessage('Re-scrape falling back to probe, pipeline suspended', {});
          return { recordId, title: scrapeData.title, status: 'waiting_probe' };
        }
        await emitter.emitStepEnd('re-scrape', { chars: reScrapeResult.markdownLength }, Date.now() - stepStart);
        scrapeData = reScrapeResult;

        stepStart = Date.now();
        await emitter.emitStepStart('re-summarize');
        summaryData = await ctx.step('re-summarize', async () => {
          return await summarizeStep(recordId!, url, scrapeData);
        });
        await emitter.emitStepEnd(
          're-summarize',
          { validContent: summaryData.validContent, tags: summaryData.tags.length },
          Date.now() - stepStart,
        );
      }

      // Step 3: Embed (summary only)
      stepStart = Date.now();
      await emitter.emitStepStart('embed');
      const embedding = await ctx.step('embed', async () => {
        return await embedStep(recordId!);
      });
      await emitter.emitStepEnd('embed', { dimensions: embedding.length }, Date.now() - stepStart);

      // Step 4: Related records
      stepStart = Date.now();
      await emitter.emitStepStart('related');
      const relatedRecords = await ctx.step('related', async () => {
        return await relatedStep(recordId!, userId, embedding);
      });
      await emitter.emitStepEnd('related', { count: relatedRecords.length }, Date.now() - stepStart);

      // Step 5: Insight
      stepStart = Date.now();
      await emitter.emitStepStart('insight');
      await ctx.step('insight', async () => {
        const relatedIds = relatedRecords.map((r) => r.id);
        await insightStep(recordId!, url, scrapeData.title, summaryData.summary, relatedIds);
      });
      await emitter.emitStepEnd('insight', {}, Date.now() - stepStart);

      // Step 6: Export
      await ctx.step('export', async () => {
        await exportStep(recordId!);
      });

      await emitter.endSession('completed');
      return { recordId, title: scrapeData.title, status: 'analyzed' };
    } catch (err) {
      // Update record status to error with error message
      const errorMessage = err instanceof Error ? err.message : String(err);
      await emitter.endSession('failed', errorMessage);
      await updateRecord(recordId!, { status: 'error', error_message: errorMessage.slice(0, 1000) });

      // Check if this is a permanent error that should not be retried
      const permanentErrors = [
        'Download is starting', // PDF or other downloadable files
        'net::ERR_ABORTED', // Download triggered
        'Navigation failed because page was closed', // Page closed during download
      ];
      const isPermanent = permanentErrors.some((pe) => errorMessage.includes(pe));

      // Only report to Sentry on final attempt or permanent error
      const task = (ctx as any).task;
      const isLastAttempt = task && task.attempt >= (task.max_attempts || 3);
      if (isPermanent || isLastAttempt) {
        Sentry.captureException(err, {
          tags: { task: 'process-link' },
          extra: { recordId, url, userId, attempt: task?.attempt, maxAttempts: task?.max_attempts },
        });
      }

      if (isPermanent) {
        log.info({ recordId, url }, '[process-link] Permanent error, not retrying');
        // Return without throwing to prevent Absurd from retrying
        return { recordId, title: undefined, status: 'error' };
      }

      // Re-throw to let Absurd handle retry logic for transient errors
      throw err;
    }
  });

  /* ── Task: refresh-related ── */

  app.registerTask({ name: 'refresh-related' }, async (params: RefreshRelatedParams, ctx) => {
    const { recordId } = params;
    const record = await getRecord(recordId);
    if (!record) throw new Error(`Record ${recordId} not found`);
    if (!record.summary) throw new Error(`Record ${recordId} missing summary`);

    const title = record.og_title || record.url;
    const emitter = new AgentEventEmitter({ refType: 'record', refId: String(recordId), agentName: 'refresh-related' });
    await emitter.startSession();
    await emitter.emitMessage('Refresh starting', { recordId, title });

    try {
      // Re-embed if needed
      let embedding: number[];
      if (record.summary_embedding) {
        embedding = JSON.parse(record.summary_embedding);
      } else {
        let stepStart = Date.now();
        await emitter.emitStepStart('embed');
        embedding = await ctx.step('embed', async () => {
          return await embedStep(recordId);
        });
        await emitter.emitStepEnd('embed', { dimensions: embedding.length }, Date.now() - stepStart);
      }

      // Search related
      let stepStart = Date.now();
      await emitter.emitStepStart('related');
      const relatedRecords = await ctx.step('related', async () => {
        return await relatedStep(recordId, record.user_id, embedding);
      });
      await emitter.emitStepEnd('related', { count: relatedRecords.length }, Date.now() - stepStart);

      // Regenerate insight
      stepStart = Date.now();
      await emitter.emitStepStart('insight');
      await ctx.step('insight', async () => {
        const relatedIds = relatedRecords.map((r) => r.id);
        await insightStep(recordId, record.url!, record.og_title, record.summary!, relatedIds);
      });
      await emitter.emitStepEnd('insight', {}, Date.now() - stepStart);

      // Re-export
      await ctx.step('export', async () => {
        await exportStep(recordId);
      });

      await emitter.endSession('completed');
      return { recordId, relatedRecords: relatedRecords.length };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await emitter.endSession('failed', errorMessage);
      const task = (ctx as any).task;
      const isLastAttempt = task && task.attempt >= (task.max_attempts || 2);
      if (isLastAttempt) {
        Sentry.captureException(err, {
          tags: { task: 'refresh-related' },
          extra: { recordId, attempt: task?.attempt },
        });
      }
      throw err;
    }
  });

  /* ── Task: process-note ── */

  app.registerTask({ name: 'process-note' }, async (params: ProcessNoteParams, ctx) => {
    const { userId, recordId } = params;
    const record = await getRecord(recordId);
    if (!record?.content) throw new Error(`Note ${recordId} content not found`);

    const emitter = new AgentEventEmitter({ refType: 'record', refId: String(recordId), agentName: 'process-note' });
    await emitter.startSession();
    await emitter.emitMessage('Note processing starting', {
      recordId,
      contentLength: record.content.length,
      taskId: ctx.taskID,
    });

    try {
      // Step 1: Summarize (conditional on content length)
      let stepStart = Date.now();
      await emitter.emitStepStart('summarize');
      const summaryData = await ctx.step('summarize', async () => {
        return await noteSummarizeStep(recordId, record.content!);
      });
      await emitter.emitStepEnd('summarize', { tags: summaryData.tags.length }, Date.now() - stepStart);

      // Step 2: Embed (summary only)
      stepStart = Date.now();
      await emitter.emitStepStart('embed');
      const embedding = await ctx.step('embed', async () => {
        return await embedStep(recordId);
      });
      await emitter.emitStepEnd('embed', { dimensions: embedding.length }, Date.now() - stepStart);

      // Step 3: Related records
      stepStart = Date.now();
      await emitter.emitStepStart('related');
      const relatedRecords = await ctx.step('related', async () => {
        return await relatedStep(recordId, userId, embedding);
      });
      await emitter.emitStepEnd('related', { count: relatedRecords.length }, Date.now() - stepStart);

      // Step 4: Insight
      stepStart = Date.now();
      await emitter.emitStepStart('insight');
      await ctx.step('insight', async () => {
        const relatedIds = relatedRecords.map((r) => r.id);
        await noteInsightStep(recordId, record.content!, summaryData.summary, relatedIds);
      });
      await emitter.emitStepEnd('insight', {}, Date.now() - stepStart);

      await updateRecord(recordId, { status: 'analyzed' });

      await emitter.endSession('completed');
      return { recordId, status: 'analyzed' };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await emitter.endSession('failed', errorMessage);
      await updateRecord(recordId, { status: 'error', error_message: errorMessage.slice(0, 1000) });

      const task = (ctx as any).task;
      const isLastAttempt = task && task.attempt >= (task.max_attempts || 3);
      if (isLastAttempt) {
        Sentry.captureException(err, {
          tags: { task: 'process-note' },
          extra: { recordId, userId, attempt: task?.attempt },
        });
      }

      throw err;
    }
  });
}

/* ── Note step functions ── */

interface NoteSummarizeResult {
  summary: string;
  tags: string[];
}

/**
 * Summarize a note: if content > 200 chars, generate full summary + tags via LLM.
 * Otherwise, copy content as summary and only generate tags.
 */
async function noteSummarizeStep(recordId: number, content: string): Promise<NoteSummarizeResult> {
  log.info({ recordId, contentLength: content.length }, '[note-summarize] Starting');

  if (content.length > 200) {
    // Long note: full summarize + tags via LLM
    const result = await generateNoteSummary(content);
    await updateRecord(recordId, {
      summary: result.summary,
      tags: JSON.stringify(result.tags),
    });
    log.info({ recordId, tags: result.tags.length }, '[note-summarize] OK (full)');
    return result;
  } else {
    // Short note: content IS the summary, only generate tags
    const tags = await generateNoteTags(content);
    await updateRecord(recordId, {
      summary: content,
      tags: JSON.stringify(tags),
    });
    log.info({ recordId, tags: tags.length }, '[note-summarize] OK (short, tags only)');
    return { summary: content, tags };
  }
}

/**
 * Generate insight for a note based on its content and related records.
 */
async function noteInsightStep(
  recordId: number,
  content: string,
  summary: string,
  relatedIds: number[],
): Promise<void> {
  log.info({ recordId, relatedCount: relatedIds.length }, '[note-insight] Starting');

  const insight = await generateNoteInsight(content, summary, relatedIds);

  await updateRecord(recordId, { insight });

  log.info({ recordId }, '[note-insight] OK');
}

/* ── Public API: spawn tasks ── */

/**
 * Spawn a process-link task via Absurd.
 * Returns immediately — the worker will pick it up.
 */
export async function spawnProcessLink(
  userId: number,
  url: string,
  recordId?: number,
  scrapeData?: ScrapeData,
): Promise<SpawnProcessResult> {
  const result = await getAbsurd().spawn(
    'process-link',
    { userId, url, recordId, scrapeData } satisfies ProcessLinkParams,
    {
      maxAttempts: 3,
      retryStrategy: { kind: 'exponential', baseSeconds: 10, factor: 2, maxSeconds: 300 },
    },
  );
  log.info({ taskId: result.taskID, url, userId }, 'Spawned process-link task');
  return { taskId: result.taskID, recordId };
}

/**
 * Spawn a process-note task via Absurd.
 */
export async function spawnProcessNote(userId: number, recordId: number): Promise<SpawnProcessResult> {
  const result = await getAbsurd().spawn('process-note', { userId, recordId } satisfies ProcessNoteParams, {
    maxAttempts: 3,
    retryStrategy: { kind: 'exponential', baseSeconds: 10, factor: 2, maxSeconds: 300 },
  });
  log.info({ taskId: result.taskID, recordId, userId }, 'Spawned process-note task');
  return { taskId: result.taskID, recordId };
}

/**
 * Spawn a refresh-related task via Absurd.
 */
export async function spawnRefreshRelated(recordId: number): Promise<string> {
  const result = await getAbsurd().spawn('refresh-related', { recordId } satisfies RefreshRelatedParams, {
    maxAttempts: 2,
    retryStrategy: { kind: 'fixed', baseSeconds: 30 },
  });
  log.info({ taskId: result.taskID, recordId }, 'Spawned refresh-related task');
  return result.taskID;
}

/**
 * Start the Absurd worker. Call once at app startup.
 */
export async function startWorker(): Promise<void> {
  registerTasks();

  const worker = await getAbsurd().startWorker({
    concurrency: 2,
    claimTimeout: 300, // 5 min per step batch (LLM calls can be slow)
    pollInterval: 1,
    onError: (err) => {
      log.error({ err: err.message, stack: err.stack }, 'Worker task error');
      Sentry.captureException(err, { tags: { source: 'absurd-worker' } });
    },
  });

  log.info('Absurd worker started (queue: linkmind, concurrency: 2)');

  // Graceful shutdown
  const shutdown = async () => {
    log.info('Shutting down worker...');
    await worker.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/* ── Public API: processUrl / retryRecord ── */

/**
 * Process a URL: upsert record, then spawn the durable task.
 * Returns spawn result (taskId). Callers poll the DB for completion.
 */
export async function processUrl(userId: number, url: string): Promise<SpawnProcessResult> {
  const existing = await getRecordByUrl(userId, url);
  if (existing && existing.id) {
    log.info({ url, recordId: existing.id }, '[start] URL already exists, re-processing');
    // Status reset happens inside task handler
    return spawnProcessLink(userId, url, existing.id);
  }

  const recordId = await insertRecord(userId, { url });
  log.info({ url, recordId }, '[start] Processing URL');
  return spawnProcessLink(userId, url, recordId);
}

/**
 * Retry a record: reset status and spawn a new process-link task.
 * Returns spawn result (taskId). Async — does not wait for completion.
 */
export async function retryRecord(recordId: number): Promise<SpawnProcessResult> {
  const record = await getRecord(recordId);
  if (!record) {
    throw new Error(`Record ${recordId} not found`);
  }

  log.info({ url: record.url, recordId, prevStatus: record.status }, '[retry] Retrying record');
  // Status reset happens inside task handler
  return spawnProcessLink(record.user_id, record.url!, recordId);
}

/* ── Delete ── */

export interface DeleteResult {
  recordId: number;
  url: string;
  relatedRecordsUpdated: number;
}

/**
 * Delete a record and clean up all references:
 * 1. Remove from other records' related_links
 * 2. Delete from database
 */
export async function deleteRecordFull(recordId: number): Promise<DeleteResult> {
  const record = await getRecord(recordId);
  if (!record) {
    throw new Error(`Record ${recordId} not found`);
  }

  log.info({ recordId, url: record.url }, '[delete] Starting');

  // 1. Remove from other records' related_links
  const relatedRecordsUpdated = await removeFromRelatedRecords(recordId);
  log.info({ recordId, relatedRecordsUpdated }, '[delete] Cleaned up related_links references');

  // 2. Delete from database
  await deleteRecord(recordId);
  log.info({ recordId }, '[delete] Deleted from database');

  return { recordId, url: record.url || '', relatedRecordsUpdated };
}

/* ── Refresh related ── */

export interface RefreshResult {
  recordId: number;
  title: string;
  relatedRecords: number;
  error?: string;
}

/**
 * Refresh related records + insight for a single record or all analyzed records.
 * Does NOT re-scrape or re-summarize.
 */
export async function refreshRelated(recordId?: number): Promise<RefreshResult[]> {
  const records = recordId
    ? ([await getRecord(recordId)].filter(Boolean) as RecordEntry[])
    : await getAllAnalyzedRecords();

  if (records.length === 0) {
    log.warn({ recordId }, '[refresh] No records found');
    return [];
  }

  log.info({ count: records.length, recordId: recordId ?? 'all' }, '[refresh] Starting');
  const results: RefreshResult[] = [];

  for (const record of records) {
    const id = record.id!;
    const title = record.og_title || record.url || '';

    try {
      if (!record.summary) {
        log.warn({ recordId: id, title }, '[refresh] Skipped (missing summary)');
        results.push({ recordId: id, title, relatedRecords: 0, error: 'missing summary' });
        continue;
      }

      // Get or create embedding
      let embedding: number[];
      if (record.summary_embedding) {
        embedding = JSON.parse(record.summary_embedding);
      } else {
        log.info({ recordId: id, title }, '[refresh] Generating embedding...');
        embedding = await embedStep(id);
      }

      // Search related
      log.info({ recordId: id, title }, '[refresh] Searching related records...');
      const relatedRecords = await relatedStep(id, record.user_id, embedding);

      // Regenerate insight
      log.info({ recordId: id, title }, '[refresh] Generating insight...');
      const relatedIds = relatedRecords.map((r) => r.id);
      await insightStep(id, record.url!, record.og_title, record.summary, relatedIds);

      log.info({ recordId: id, title, relatedCount: relatedRecords.length }, '[refresh] Done');
      results.push({ recordId: id, title, relatedRecords: relatedRecords.length });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ recordId: id, title, err: errMsg }, '[refresh] Failed');
      results.push({ recordId: id, title, relatedRecords: 0, error: errMsg });
    }
  }

  log.info({ total: results.length, errors: results.filter((r) => r.error).length }, '[refresh] Complete');
  return results;
}

/* ── Probe result handler ── */

/**
 * Handle a scrape result received from a probe device.
 * Looks up the probe event, finds the associated record, and resumes processing.
 */
export async function handleProbeResult(eventId: string, scrapeData: ScrapeData): Promise<void> {
  const event = await getProbeEventById(eventId);
  if (!event) throw new Error(`Probe event ${eventId} not found`);

  const recordId = event.link_id;
  if (!recordId) throw new Error(`Probe event ${eventId} has no link_id`);

  const record = await getRecord(recordId);
  if (!record) throw new Error(`Record ${recordId} not found for probe event ${eventId}`);

  log.info({ eventId, recordId, url: event.url }, '[probe-result] Resuming pipeline with probe data');

  // Spawn a new process-link task with the probe scrape data
  await spawnProcessLink(record.user_id, event.url, recordId, scrapeData);
}
