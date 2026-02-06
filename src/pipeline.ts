/**
 * Pipeline: single source of truth for link processing logic.
 *
 * Pipeline steps: scrape → summarize → embed → related → insight → export
 *
 * Contains:
 *   - Step functions: scrapeStep / summarizeStep / embedStep / relatedStep / insightStep / exportStep
 *   - Absurd durable execution: task registration, worker lifecycle
 *   - Public API: processUrl, retryLink, spawnProcessLink, spawnRefreshRelated, startWorker
 *   - Utilities: deleteLinkFull, refreshRelated
 */

import { Absurd } from 'absurd-sdk';
import {
  insertLink,
  updateLink,
  getLink,
  getLinkByUrl,
  getAllAnalyzedLinks,
  deleteLink,
  removeFromRelatedLinks,
  saveRelatedLinks,
  type LinkRecord,
} from './db.js';
import { scrapeUrl, isTwitterUrl } from './scraper.js';
import { processTwitterImages } from './image-handler.js';
import { generateSummary, generateInsight } from './agent.js';
import { createEmbedding } from './llm.js';
import { searchRelatedLinks, type RelatedLinkResult } from './search.js';
import { exportLinkMarkdown, deleteLinkExport, qmdIndexQueue } from './export.js';
import { logger } from './logger.js';

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

interface ProcessLinkParams {
  userId: number;
  url: string;
  linkId?: number; // set if re-processing existing link
}

interface RefreshRelatedParams {
  linkId: number;
}

export interface SpawnProcessResult {
  taskId: string;
  linkId?: number;
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
async function scrapeStep(linkId: number, url: string): Promise<ScrapeStepResult> {
  log.info({ linkId, url }, '[scrape] Starting');
  const result = await scrapeUrl(url);

  await updateLink(linkId, {
    og_title: result.og.title,
    og_description: result.og.description,
    og_image: result.og.image,
    og_site_name: result.og.siteName,
    og_type: result.og.type,
    markdown: result.markdown,
    status: 'scraped',
  });

  log.info({ linkId, title: result.og.title, chars: result.markdown.length }, '[scrape] OK');

  // Process Twitter images + OCR
  let ocrTexts: string[] = [];
  if (isTwitterUrl(url) && result.rawMedia?.length) {
    try {
      const images = await processTwitterImages(linkId, result.rawMedia);
      if (images.length > 0) {
        await updateLink(linkId, { images: JSON.stringify(images) });
        log.info({ linkId, count: images.length }, '[images] Downloaded and processed');

        ocrTexts = images.filter((img) => img.ocr_text).map((img) => img.ocr_text!);
        if (ocrTexts.length > 0) {
          log.info({ linkId, ocrCount: ocrTexts.length }, '[ocr] Extracted text from images');
        }
      }
    } catch (imgErr) {
      log.warn(
        { linkId, err: imgErr instanceof Error ? imgErr.message : String(imgErr) },
        '[images] Failed (non-fatal)',
      );
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

interface SummarizeStepResult {
  summary: string;
  tags: string[];
}

/**
 * Step 2: Summarize - generate summary and tags via LLM.
 */
async function summarizeStep(linkId: number, url: string, scrapeData: ScrapeStepResult): Promise<SummarizeStepResult> {
  const link = await getLink(linkId);
  if (!link?.markdown) throw new Error('Link markdown not found after scrape');

  log.info({ linkId, title: scrapeData.title }, '[summarize] Starting');

  // Append OCR text to markdown for LLM context
  let markdownForSummary = link.markdown;
  if (scrapeData.ocrTexts.length > 0) {
    markdownForSummary += '\n\n---\n**图片文字 (OCR):**\n' + scrapeData.ocrTexts.join('\n\n');
  }

  const result = await generateSummary({
    url,
    title: scrapeData.title,
    ogDescription: scrapeData.ogDescription,
    markdown: markdownForSummary,
  });

  await updateLink(linkId, {
    summary: result.summary,
    tags: JSON.stringify(result.tags),
  });

  log.info({ linkId, tags: result.tags.length }, '[summarize] OK');
  return result;
}

/**
 * Step 3: Embed - generate embedding vector for summary only.
 */
async function embedStep(linkId: number): Promise<number[]> {
  const link = await getLink(linkId);
  if (!link?.summary) throw new Error('Link summary not found for embedding');

  log.info({ linkId, title: link.og_title }, '[embed] Starting');

  const embedding = await createEmbedding(link.summary);

  // Store embedding as PostgreSQL vector format
  const vectorStr = `[${embedding.join(',')}]`;
  await updateLink(linkId, { summary_embedding: vectorStr } as any);

  log.info({ linkId, dimensions: embedding.length }, '[embed] OK');
  return embedding;
}

const RELATED_SCORE_THRESHOLD = 0.65; // Minimum score to save relation
const RELATED_MAX_COUNT = 5; // Maximum related links to save

/**
 * Step 4: Related - search for related links based on summary embedding.
 * Filters by score threshold and saves to link_relations table.
 */
async function relatedStep(linkId: number, userId: number, embedding: number[]): Promise<RelatedLinkResult[]> {
  log.info({ linkId }, '[related] Starting');

  // Search more than we need, then filter by threshold
  const searchResults = await searchRelatedLinks(embedding, userId, linkId, 10);

  // Filter by threshold and take top N
  const relatedLinks = searchResults
    .filter((r) => r.score >= RELATED_SCORE_THRESHOLD)
    .slice(0, RELATED_MAX_COUNT);

  // Save to link_relations table
  await saveRelatedLinks(
    linkId,
    relatedLinks.map((r) => ({ relatedLinkId: r.id, score: r.score })),
  );

  // Also update JSON field for backward compat (can remove later)
  await updateLink(linkId, {
    related_links: JSON.stringify(relatedLinks),
    related_notes: JSON.stringify([]),
  });

  log.info(
    { linkId, searched: searchResults.length, saved: relatedLinks.length, threshold: RELATED_SCORE_THRESHOLD },
    '[related] OK',
  );
  return relatedLinks;
}

/**
 * Step 5: Insight - generate insight with related links context.
 */
async function insightStep(
  linkId: number,
  url: string,
  title: string | undefined,
  summary: string,
  relatedIds: number[],
): Promise<void> {
  log.info({ linkId, relatedCount: relatedIds.length }, '[insight] Starting');

  const insight = await generateInsight({ url, title }, summary, relatedIds);

  await updateLink(linkId, {
    insight,
    status: 'analyzed',
  });

  log.info({ linkId }, '[insight] OK');
}

/**
 * Step 6: Export - export link to markdown file + trigger QMD re-index.
 */
async function exportStep(linkId: number): Promise<void> {
  const fullLink = await getLink(linkId);
  if (!fullLink) throw new Error('Link not found for export');

  const exportPath = exportLinkMarkdown(fullLink);
  log.info({ linkId, path: exportPath }, '[export] OK');

  qmdIndexQueue.requestUpdate().catch(() => {});
}

/* ── Absurd task registration ── */

export function registerTasks(): void {
  const app = getAbsurd();

  app.registerTask({ name: 'process-link' }, async (params: ProcessLinkParams, ctx) => {
    const { userId, url } = params;

    // Resolve or create linkId
    let linkId = params.linkId;
    if (!linkId) {
      const existing = await getLinkByUrl(userId, url);
      if (existing?.id) {
        linkId = existing.id;
        await updateLink(linkId, { status: 'pending', error_message: undefined });
      } else {
        linkId = await insertLink(userId, url);
      }
    }

    log.info({ linkId, url, taskId: ctx.taskID }, '[process-link] Starting');

    // Step 1: Scrape
    const scrapeData = await ctx.step('scrape', async () => {
      return await scrapeStep(linkId!, url);
    });

    // Step 2: Summarize
    const summaryData = await ctx.step('summarize', async () => {
      return await summarizeStep(linkId!, url, scrapeData);
    });

    // Step 3: Embed (summary only)
    const embedding = await ctx.step('embed', async () => {
      return await embedStep(linkId!);
    });

    // Step 4: Related links
    const relatedLinks = await ctx.step('related', async () => {
      return await relatedStep(linkId!, userId, embedding);
    });

    // Step 5: Insight
    await ctx.step('insight', async () => {
      const relatedIds = relatedLinks.map((r) => r.id);
      await insightStep(linkId!, url, scrapeData.title, summaryData.summary, relatedIds);
    });

    // Step 6: Export
    await ctx.step('export', async () => {
      await exportStep(linkId!);
    });

    log.info({ linkId, url, title: scrapeData.title }, '[process-link] Complete');
    return { linkId, title: scrapeData.title, status: 'analyzed' };
  });

  /* ── Task: refresh-related ── */

  app.registerTask({ name: 'refresh-related' }, async (params: RefreshRelatedParams, ctx) => {
    const { linkId } = params;
    const link = await getLink(linkId);
    if (!link) throw new Error(`Link ${linkId} not found`);
    if (!link.summary) throw new Error(`Link ${linkId} missing summary`);

    const title = link.og_title || link.url;
    log.info({ linkId, title }, '[refresh-related] Starting');

    // Re-embed if needed
    let embedding: number[];
    if (link.summary_embedding) {
      embedding = JSON.parse(link.summary_embedding);
    } else {
      embedding = await ctx.step('embed', async () => {
        return await embedStep(linkId);
      });
    }

    // Search related
    const relatedLinks = await ctx.step('related', async () => {
      return await relatedStep(linkId, link.user_id, embedding);
    });

    // Regenerate insight
    await ctx.step('insight', async () => {
      const relatedIds = relatedLinks.map((r) => r.id);
      await insightStep(linkId, link.url, link.og_title, link.summary!, relatedIds);
    });

    // Re-export
    await ctx.step('export', async () => {
      await exportStep(linkId);
    });

    log.info({ linkId, title, relatedCount: relatedLinks.length }, '[refresh-related] Complete');
    return { linkId, relatedLinks: relatedLinks.length };
  });
}

/* ── Public API: spawn tasks ── */

/**
 * Spawn a process-link task via Absurd.
 * Returns immediately — the worker will pick it up.
 */
export async function spawnProcessLink(userId: number, url: string, linkId?: number): Promise<SpawnProcessResult> {
  const result = await getAbsurd().spawn('process-link', { userId, url, linkId } satisfies ProcessLinkParams, {
    maxAttempts: 3,
    retryStrategy: { kind: 'exponential', baseSeconds: 10, factor: 2, maxSeconds: 300 },
  });
  log.info({ taskId: result.taskID, url, userId }, 'Spawned process-link task');
  return { taskId: result.taskID, linkId };
}

/**
 * Spawn a refresh-related task via Absurd.
 */
export async function spawnRefreshRelated(linkId: number): Promise<string> {
  const result = await getAbsurd().spawn('refresh-related', { linkId } satisfies RefreshRelatedParams, {
    maxAttempts: 2,
    retryStrategy: { kind: 'fixed', baseSeconds: 30 },
  });
  log.info({ taskId: result.taskID, linkId }, 'Spawned refresh-related task');
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

/* ── Public API: processUrl / retryLink ── */

/**
 * Process a URL: upsert link record, then spawn the durable task.
 * Returns spawn result (taskId). Callers poll the DB for completion.
 */
export async function processUrl(userId: number, url: string): Promise<SpawnProcessResult> {
  const existing = await getLinkByUrl(userId, url);
  if (existing && existing.id) {
    log.info({ url, linkId: existing.id }, '[start] URL already exists, re-processing');
    await updateLink(existing.id, { status: 'pending', error_message: undefined });
    return spawnProcessLink(userId, url, existing.id);
  }

  const linkId = await insertLink(userId, url);
  log.info({ url, linkId }, '[start] Processing URL');
  return spawnProcessLink(userId, url, linkId);
}

/**
 * Retry a link: reset status and spawn a new process-link task.
 * Returns spawn result (taskId). Async — does not wait for completion.
 */
export async function retryLink(linkId: number): Promise<SpawnProcessResult> {
  const link = await getLink(linkId);
  if (!link) {
    throw new Error(`Link ${linkId} not found`);
  }

  log.info({ url: link.url, linkId, prevStatus: link.status }, '[retry] Retrying link');
  await updateLink(linkId, { status: 'pending', error_message: undefined });
  return spawnProcessLink(link.user_id, link.url, linkId);
}

/* ── Delete ── */

export interface DeleteResult {
  linkId: number;
  url: string;
  relatedLinksUpdated: number;
  exportDeleted: boolean;
}

/**
 * Delete a link and clean up all references:
 * 1. Remove from other links' related_links
 * 2. Delete exported markdown file
 * 3. Delete from database
 * 4. Trigger qmd re-index
 */
export async function deleteLinkFull(linkId: number): Promise<DeleteResult> {
  const link = await getLink(linkId);
  if (!link) {
    throw new Error(`Link ${linkId} not found`);
  }

  log.info({ linkId, url: link.url }, '[delete] Starting');

  // 1. Remove from other links' related_links
  const relatedLinksUpdated = await removeFromRelatedLinks(linkId);
  log.info({ linkId, relatedLinksUpdated }, '[delete] Cleaned up related_links references');

  // 2. Delete exported markdown
  let exportDeleted = false;
  if (link.status === 'analyzed') {
    exportDeleted = deleteLinkExport(link);
  }

  // 3. Delete from database
  await deleteLink(linkId);
  log.info({ linkId }, '[delete] Deleted from database');

  // 4. Trigger qmd re-index
  qmdIndexQueue.requestUpdate().catch(() => {});

  return { linkId, url: link.url, relatedLinksUpdated, exportDeleted };
}

/* ── Refresh related ── */

export interface RefreshResult {
  linkId: number;
  title: string;
  relatedLinks: number;
  error?: string;
}

/**
 * Refresh related links + insight for a single link or all analyzed links.
 * Does NOT re-scrape or re-summarize.
 */
export async function refreshRelated(linkId?: number): Promise<RefreshResult[]> {
  const links = linkId ? ([await getLink(linkId)].filter(Boolean) as LinkRecord[]) : await getAllAnalyzedLinks();

  if (links.length === 0) {
    log.warn({ linkId }, '[refresh] No links found');
    return [];
  }

  log.info({ count: links.length, linkId: linkId ?? 'all' }, '[refresh] Starting');
  const results: RefreshResult[] = [];

  for (const link of links) {
    const id = link.id!;
    const title = link.og_title || link.url;

    try {
      if (!link.summary) {
        log.warn({ linkId: id, title }, '[refresh] Skipped (missing summary)');
        results.push({ linkId: id, title, relatedLinks: 0, error: 'missing summary' });
        continue;
      }

      // Get or create embedding
      let embedding: number[];
      if (link.summary_embedding) {
        embedding = JSON.parse(link.summary_embedding);
      } else {
        log.info({ linkId: id, title }, '[refresh] Generating embedding...');
        embedding = await embedStep(id);
      }

      // Search related
      log.info({ linkId: id, title }, '[refresh] Searching related links...');
      const relatedLinks = await relatedStep(id, link.user_id, embedding);

      // Regenerate insight
      log.info({ linkId: id, title }, '[refresh] Generating insight...');
      const relatedIds = relatedLinks.map((r) => r.id);
      await insightStep(id, link.url, link.og_title, link.summary, relatedIds);

      // Re-export
      const updatedLink = await getLink(id);
      if (updatedLink) {
        exportLinkMarkdown(updatedLink);
      }

      log.info({ linkId: id, title, relatedCount: relatedLinks.length }, '[refresh] Done');
      results.push({ linkId: id, title, relatedLinks: relatedLinks.length });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ linkId: id, title, err: errMsg }, '[refresh] Failed');
      results.push({ linkId: id, title, relatedLinks: 0, error: errMsg });
    }
  }

  // Trigger one qmd index update at the end
  qmdIndexQueue.requestUpdate().catch(() => {});

  log.info({ total: results.length, errors: results.filter((r) => r.error).length }, '[refresh] Complete');
  return results;
}
