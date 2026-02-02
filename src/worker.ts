/**
 * Absurd durable execution worker for LinkMind pipeline tasks.
 *
 * Registers tasks:
 *   - process-link: scrape → analyze → export (3 checkpointed steps)
 *   - refresh-related: re-search related content for a link
 *
 * Each step is checkpointed — if the process crashes mid-way,
 * completed steps are skipped on retry.
 */

import { Absurd } from 'absurd-sdk';
import {
  updateLink,
  getLink,
  getLinkByUrl,
  insertLink,
  type LinkRecord,
} from './db.js';
import { scrapeUrl } from './scraper.js';
import { analyzeArticle, findRelatedAndInsight } from './agent.js';
import { exportLinkMarkdown, qmdIndexQueue } from './export.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'worker' });

const QUEUE_NAME = 'linkmind';

let absurd: Absurd | null = null;

export function getAbsurd(): Absurd {
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

/* ── Task: process-link ── */

interface ProcessLinkParams {
  userId: number;
  url: string;
  linkId?: number; // set if re-processing existing link
}

interface RefreshRelatedParams {
  linkId: number;
}

function registerTasks(): void {
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
  const scrapeResult = await ctx.step('scrape', async () => {
    log.info({ linkId, url }, '[scrape] Starting');
    const result = await scrapeUrl(url);

    await updateLink(linkId!, {
      og_title: result.og.title,
      og_description: result.og.description,
      og_image: result.og.image,
      og_site_name: result.og.siteName,
      og_type: result.og.type,
      markdown: result.markdown,
      status: 'scraped',
    });

    log.info({ linkId, title: result.og.title, chars: result.markdown.length }, '[scrape] OK');

    // Return only what's needed for next steps (keep checkpoint small)
    return {
      title: result.og.title,
      ogDescription: result.og.description,
      siteName: result.og.siteName,
      markdownLength: result.markdown.length,
    };
  });

  // Step 2: Analyze
  await ctx.step('analyze', async () => {
    // Re-read markdown from DB (not stored in checkpoint to save space)
    const link = await getLink(linkId!);
    if (!link?.markdown) throw new Error('Link markdown not found after scrape');

    log.info({ linkId, title: scrapeResult.title }, '[analyze] Starting');
    const analysis = await analyzeArticle({
      url,
      title: scrapeResult.title,
      ogDescription: scrapeResult.ogDescription,
      siteName: scrapeResult.siteName,
      markdown: link.markdown,
      linkId,
    });

    await updateLink(linkId!, {
      summary: analysis.summary,
      insight: analysis.insight,
      tags: JSON.stringify(analysis.tags),
      related_notes: JSON.stringify(analysis.relatedNotes),
      related_links: JSON.stringify(analysis.relatedLinks),
      status: 'analyzed',
    });

    log.info({ linkId, tags: analysis.tags.length }, '[analyze] OK');
    return { tags: analysis.tags.length };
  });

  // Step 3: Export
  await ctx.step('export', async () => {
    const fullLink = await getLink(linkId!);
    if (!fullLink) throw new Error('Link not found for export');

    const exportPath = exportLinkMarkdown(fullLink);
    log.info({ linkId, path: exportPath }, '[export] OK');

    qmdIndexQueue.requestUpdate().catch(() => {});
    return { path: exportPath };
  });

  log.info({ linkId, url, title: scrapeResult.title }, '[process-link] Complete');
  return { linkId, title: scrapeResult.title, status: 'analyzed' };
  });

  /* ── Task: refresh-related ── */

  app.registerTask({ name: 'refresh-related' }, async (params: RefreshRelatedParams, ctx) => {
    const { linkId } = params;
  const link = await getLink(linkId);
  if (!link) throw new Error(`Link ${linkId} not found`);
  if (!link.summary || !link.markdown) throw new Error(`Link ${linkId} missing summary/markdown`);

  const title = link.og_title || link.url;
  log.info({ linkId, title }, '[refresh-related] Starting');

  const related = await ctx.step('find-related', async () => {
    return await findRelatedAndInsight(
      { url: link.url, title: link.og_title, markdown: link.markdown!, linkId },
      link.summary!,
    );
  });

  await ctx.step('update-and-export', async () => {
    await updateLink(linkId, {
      related_notes: JSON.stringify(related.relatedNotes),
      related_links: JSON.stringify(related.relatedLinks),
      insight: related.insight,
    });

    const updatedLink = await getLink(linkId);
    if (updatedLink) {
      exportLinkMarkdown(updatedLink);
    }

    qmdIndexQueue.requestUpdate().catch(() => {});
  });

    log.info({ linkId, title, notes: related.relatedNotes.length, links: related.relatedLinks.length }, '[refresh-related] Complete');
    return { linkId, relatedNotes: related.relatedNotes.length, relatedLinks: related.relatedLinks.length };
  });
} // end registerTasks

/* ── Public API: spawn tasks ── */

export interface SpawnProcessResult {
  taskId: string;
  linkId?: number;
}

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
