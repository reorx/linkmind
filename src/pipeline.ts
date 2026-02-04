/**
 * Pipeline: shared link processing logic (scrape → analyze → export).
 */

import {
  insertLink,
  updateLink,
  getLink,
  getLinkByUrl,
  getAllAnalyzedLinks,
  deleteLink,
  removeFromRelatedLinks,
  type LinkRecord,
} from './db.js';
import { scrapeUrl, isTwitterUrl } from './scraper.js';
import { processTwitterImages } from './image-handler.js';
import { analyzeArticle, findRelatedAndInsight } from './agent.js';
import { exportLinkMarkdown, deleteLinkExport, qmdIndexQueue } from './export.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'pipeline' });

export interface ProcessResult {
  linkId: number;
  title: string;
  url: string;
  status: 'analyzed' | 'error';
  error?: string;
  duplicate?: boolean;
}

export type ProgressCallback = (stage: string) => void | Promise<void>;

/**
 * Process a URL through the full pipeline: scrape → analyze → export.
 * If the URL already exists, re-processes the existing link instead of creating a new one.
 * Returns { ...result, duplicate: true } when re-processing an existing link.
 */
export async function processUrl(userId: number, url: string, onProgress?: ProgressCallback): Promise<ProcessResult> {
  const existing = await getLinkByUrl(userId, url);
  if (existing && existing.id) {
    log.info({ url, linkId: existing.id }, '[start] URL already exists, re-processing');
    await updateLink(existing.id, { status: 'pending', error_message: undefined });
    const result = await runPipeline(existing.id, url, onProgress);
    return { ...result, duplicate: true };
  }

  const linkId = await insertLink(userId, url);
  log.info({ url, linkId }, '[start] Processing URL');
  return runPipeline(linkId, url, onProgress);
}

/**
 * Retry a link: re-run the full pipeline from scratch (scrape → analyze → export).
 */
export async function retryLink(linkId: number): Promise<ProcessResult> {
  const link = await getLink(linkId);
  if (!link) {
    return { linkId, title: '', url: '', status: 'error', error: 'Link not found' };
  }

  log.info({ url: link.url, linkId, prevStatus: link.status }, '[retry] Retrying link');

  // Reset status
  await updateLink(linkId, { status: 'pending', error_message: undefined });

  return runPipeline(linkId, link.url);
}

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

/**
 * Core pipeline logic. Always runs the full pipeline: scrape → analyze → export.
 * Idempotent — re-running on the same linkId overwrites previous results.
 */
async function runPipeline(linkId: number, url: string, onProgress?: ProgressCallback): Promise<ProcessResult> {
  // ── Stage 1: Scrape ──
  let title: string | undefined;
  let markdown: string | undefined;
  let ogDescription: string | undefined;
  let siteName: string | undefined;
  let ocrTexts: string[] = [];

  try {
    await onProgress?.('scraping');
    const scrapeResult = await scrapeUrl(url);

    await updateLink(linkId, {
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

    // ── Process Twitter images ──
    if (isTwitterUrl(url) && scrapeResult.rawMedia?.length) {
      try {
        await onProgress?.('downloading images');
        const images = await processTwitterImages(linkId, scrapeResult.rawMedia);
        if (images.length > 0) {
          await updateLink(linkId, { images: JSON.stringify(images) });
          log.info({ linkId, count: images.length }, '[images] Downloaded and processed');

          // Collect OCR text for LLM analysis
          ocrTexts = images.filter((img) => img.ocr_text).map((img) => img.ocr_text!);
          if (ocrTexts.length > 0) {
            log.info({ linkId, ocrCount: ocrTexts.length }, '[ocr] Extracted text from images');
          }
        }
      } catch (imgErr) {
        // Image processing failure is non-fatal
        log.warn(
          { linkId, err: imgErr instanceof Error ? imgErr.message : String(imgErr) },
          '[images] Failed (non-fatal)',
        );
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error({ url, linkId, err: errMsg, stack: err instanceof Error ? err.stack : undefined }, '[scrape] Failed');
    try {
      await updateLink(linkId, { status: 'error', error_message: `[scrape] ${errMsg}` });
    } catch {}
    return { linkId, title: url, url, status: 'error', error: `[scrape] ${errMsg}` };
  }

  // ── Stage 2: Analyze (LLM) ──
  try {
    await onProgress?.('analyzing');

    // Append OCR text to markdown for LLM context
    let markdownForAnalysis = markdown!;
    if (ocrTexts.length > 0) {
      markdownForAnalysis += '\n\n---\n**图片文字 (OCR):**\n' + ocrTexts.join('\n\n');
    }

    const analysis = await analyzeArticle({
      url,
      title,
      ogDescription,
      siteName,
      markdown: markdownForAnalysis,
      linkId,
    });

    await updateLink(linkId, {
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
      await updateLink(linkId, { status: 'error', error_message: `[analyze] ${errMsg}` });
    } catch {}
    return { linkId, title: title || url, url, status: 'error', error: `[analyze] ${errMsg}` };
  }

  // ── Stage 3: Export + QMD Index ──
  const fullLink = await getLink(linkId);
  if (fullLink) {
    try {
      const exportPath = exportLinkMarkdown(fullLink);
      log.info({ path: exportPath }, '[export] OK');

      // Fire-and-forget: queue QMD re-index (serialized, won't block pipeline)
      qmdIndexQueue.requestUpdate().catch(() => {});
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ err: errMsg }, '[export] Failed (non-fatal)');
    }
  }

  log.info({ linkId, title: title || url }, '[done] Processing complete');

  return { linkId, title: title || url, url, status: 'analyzed' };
}

export interface RefreshResult {
  linkId: number;
  title: string;
  relatedNotes: number;
  relatedLinks: number;
  error?: string;
}

/**
 * Refresh related content (notes + links + insight) for a single link or all analyzed links.
 * Does NOT re-scrape or re-summarize — only re-searches and re-generates insight.
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
      if (!link.summary || !link.markdown) {
        log.warn({ linkId: id, title }, '[refresh] Skipped (missing summary or markdown)');
        results.push({ linkId: id, title, relatedNotes: 0, relatedLinks: 0, error: 'missing summary/markdown' });
        continue;
      }

      log.info({ linkId: id, title }, '[refresh] Finding related content...');
      const related = await findRelatedAndInsight(
        { url: link.url, title: link.og_title, markdown: link.markdown, linkId: id },
        link.summary,
      );

      await updateLink(id, {
        related_notes: JSON.stringify(related.relatedNotes),
        related_links: JSON.stringify(related.relatedLinks),
        insight: related.insight,
      });

      // Re-export markdown with updated related info
      const updatedLink = await getLink(id);
      if (updatedLink) {
        exportLinkMarkdown(updatedLink);
      }

      log.info(
        { linkId: id, title, notes: related.relatedNotes.length, links: related.relatedLinks.length },
        '[refresh] Done',
      );
      results.push({
        linkId: id,
        title,
        relatedNotes: related.relatedNotes.length,
        relatedLinks: related.relatedLinks.length,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ linkId: id, title, err: errMsg }, '[refresh] Failed');
      results.push({ linkId: id, title, relatedNotes: 0, relatedLinks: 0, error: errMsg });
    }
  }

  // Trigger one qmd index update at the end
  qmdIndexQueue.requestUpdate().catch(() => {});

  log.info({ total: results.length, errors: results.filter((r) => r.error).length }, '[refresh] Complete');
  return results;
}
