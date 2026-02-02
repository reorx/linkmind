/**
 * Pipeline: shared link processing logic (scrape → analyze → export).
 */

import { insertLink, updateLink, getLink, getLinkByUrl } from './db.js';
import { scrapeUrl } from './scraper.js';
import { analyzeArticle } from './agent.js';
import { exportLinkMarkdown } from './export.js';

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
 * Returns the result with linkId and status.
 */
export async function processUrl(url: string, onProgress?: ProgressCallback): Promise<ProcessResult> {
  // Step 1: Insert into DB
  const linkId = insertLink(url);
  console.log(`[pipeline] Processing URL: ${url} (id=${linkId})`);

  try {
    // Step 2: Scrape
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

    console.log(`[pipeline] Scraped: ${scrapeResult.og.title || url} (${scrapeResult.markdown.length} chars)`);

    // Step 3: Analyze
    await onProgress?.('analyzing');
    const analysis = await analyzeArticle({
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

    console.log(`[pipeline] Analyzed: ${scrapeResult.og.title || url}`);

    // Step 4: Export markdown for qmd
    const fullLink = getLink(linkId);
    if (fullLink) {
      try {
        exportLinkMarkdown(fullLink);
      } catch (exportErr) {
        console.error(`[pipeline] Export failed:`, exportErr);
      }
    }

    return {
      linkId,
      title: scrapeResult.og.title || url,
      url,
      status: 'analyzed',
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[pipeline] Error processing ${url}:`, errMsg);

    try {
      updateLink(linkId, { status: 'error', error_message: errMsg });
    } catch {}

    return {
      linkId,
      title: url,
      url,
      status: 'error',
      error: errMsg,
    };
  }
}
