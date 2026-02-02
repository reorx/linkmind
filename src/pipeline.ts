/**
 * Pipeline: shared link processing logic (scrape → analyze → export).
 */

import { insertLink, updateLink, getLink, type LinkRecord } from './db.js';
import { scrapeUrl, type ScrapeResult } from './scraper.js';
import { analyzeArticle } from './agent.js';
import { exportLinkMarkdown } from './export.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'pipeline' });

export interface ProcessResult {
  linkId: number;
  title: string;
  url: string;
  status: 'analyzed' | 'error';
  error?: string;
}

export type ProgressCallback = (stage: string) => void | Promise<void>;

/**
 * Process a URL through the full pipeline: scrape → analyze → export.
 */
export async function processUrl(url: string, onProgress?: ProgressCallback): Promise<ProcessResult> {
  const linkId = insertLink(url);
  log.info({ url, linkId }, '[start] Processing URL');
  return runPipeline(linkId, url, onProgress);
}

/**
 * Retry a failed link: resume from the appropriate stage based on existing data.
 */
export async function retryLink(linkId: number): Promise<ProcessResult> {
  const link = getLink(linkId);
  if (!link) {
    return { linkId, title: '', url: '', status: 'error', error: 'Link not found' };
  }

  log.info({ url: link.url, linkId, prevStatus: link.status }, '[retry] Retrying link');

  // Reset status
  updateLink(linkId, { status: 'pending', error_message: undefined });

  return runPipeline(linkId, link.url, undefined, link);
}

/**
 * Core pipeline logic. If `existingLink` is provided and already has scraped data,
 * skip the scrape stage.
 */
async function runPipeline(
  linkId: number,
  url: string,
  onProgress?: ProgressCallback,
  existingLink?: LinkRecord,
): Promise<ProcessResult> {
  // ── Stage 1: Scrape ──
  // Skip if we already have scraped content
  let title: string | undefined;
  let markdown: string | undefined;
  let ogDescription: string | undefined;
  let siteName: string | undefined;

  if (existingLink?.markdown && existingLink.markdown.length > 0) {
    log.info({ linkId }, '[scrape] Skipped (already have content)');
    title = existingLink.og_title;
    markdown = existingLink.markdown;
    ogDescription = existingLink.og_description;
    siteName = existingLink.og_site_name;
  } else {
    try {
      await onProgress?.('scraping');
      const scrapeResult = await scrapeUrl(url);

      updateLink(linkId, {
        og_title: scrapeResult.og.title,
        og_description: scrapeResult.og.description,
        og_image: scrapeResult.og.image,
        og_site_name: scrapeResult.og.siteName,
        og_type: scrapeResult.og.type,
        markdown: scrapeResult.markdown,
        status: 'scraped',
      });

      title = scrapeResult.og.title;
      markdown = scrapeResult.markdown;
      ogDescription = scrapeResult.og.description;
      siteName = scrapeResult.og.siteName;

      log.info({ title: title || url, chars: markdown.length }, '[scrape] OK');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ url, linkId, err: errMsg, stack: err instanceof Error ? err.stack : undefined }, '[scrape] Failed');
      try {
        updateLink(linkId, { status: 'error', error_message: `[scrape] ${errMsg}` });
      } catch {}
      return { linkId, title: url, url, status: 'error', error: `[scrape] ${errMsg}` };
    }
  }

  // ── Stage 2: Analyze (LLM) ──
  try {
    await onProgress?.('analyzing');
    const analysis = await analyzeArticle({
      url,
      title,
      ogDescription,
      siteName,
      markdown: markdown!,
    });

    updateLink(linkId, {
      summary: analysis.summary,
      insight: analysis.insight,
      tags: JSON.stringify(analysis.tags),
      related_notes: JSON.stringify(analysis.relatedNotes),
      related_links: JSON.stringify(analysis.relatedLinks),
      status: 'analyzed',
    });

    log.info({ title: title || url, tags: analysis.tags.length }, '[analyze] OK');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error({ url, linkId, err: errMsg, stack: err instanceof Error ? err.stack : undefined }, '[analyze] Failed');
    try {
      updateLink(linkId, { status: 'error', error_message: `[analyze] ${errMsg}` });
    } catch {}
    return { linkId, title: title || url, url, status: 'error', error: `[analyze] ${errMsg}` };
  }

  // ── Stage 3: Export ──
  const fullLink = getLink(linkId);
  if (fullLink) {
    try {
      const exportPath = exportLinkMarkdown(fullLink);
      log.info({ path: exportPath }, '[export] OK');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ err: errMsg }, '[export] Failed (non-fatal)');
    }
  }

  log.info({ linkId, title: title || url }, '[done] Processing complete');

  return { linkId, title: title || url, url, status: 'analyzed' };
}
