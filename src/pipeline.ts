/**
 * Pipeline: shared link processing logic (scrape → analyze → export).
 */

import { insertLink, updateLink, getLink } from './db.js';
import { scrapeUrl } from './scraper.js';
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

  // ── Stage 1: Scrape ──
  let scrapeResult;
  try {
    await onProgress?.('scraping');
    scrapeResult = await scrapeUrl(url);

    updateLink(linkId, {
      og_title: scrapeResult.og.title,
      og_description: scrapeResult.og.description,
      og_image: scrapeResult.og.image,
      og_site_name: scrapeResult.og.siteName,
      og_type: scrapeResult.og.type,
      markdown: scrapeResult.markdown,
      status: 'scraped',
    });

    log.info({ title: scrapeResult.og.title || url, chars: scrapeResult.markdown.length }, '[scrape] OK');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error({ url, linkId, err: errMsg, stack: err instanceof Error ? err.stack : undefined }, '[scrape] Failed');

    try {
      updateLink(linkId, { status: 'error', error_message: `[scrape] ${errMsg}` });
    } catch {}

    return { linkId, title: url, url, status: 'error', error: `[scrape] ${errMsg}` };
  }

  // ── Stage 2: Analyze (LLM) ──
  let analysis;
  try {
    await onProgress?.('analyzing');
    analysis = await analyzeArticle({
      url,
      title: scrapeResult.og.title,
      ogDescription: scrapeResult.og.description,
      siteName: scrapeResult.og.siteName,
      markdown: scrapeResult.markdown,
    });

    updateLink(linkId, {
      summary: analysis.summary,
      insight: analysis.insight,
      tags: JSON.stringify(analysis.tags),
      related_notes: JSON.stringify(analysis.relatedNotes),
      related_links: JSON.stringify(analysis.relatedLinks),
      status: 'analyzed',
    });

    log.info({ title: scrapeResult.og.title || url, tags: analysis.tags.length }, '[analyze] OK');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error({ url, linkId, err: errMsg, stack: err instanceof Error ? err.stack : undefined }, '[analyze] Failed');

    try {
      updateLink(linkId, { status: 'error', error_message: `[analyze] ${errMsg}` });
    } catch {}

    return {
      linkId,
      title: scrapeResult.og.title || url,
      url,
      status: 'error',
      error: `[analyze] ${errMsg}`,
    };
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

  log.info({ linkId, title: scrapeResult.og.title || url }, '[done] Processing complete');

  return {
    linkId,
    title: scrapeResult.og.title || url,
    url,
    status: 'analyzed',
  };
}
