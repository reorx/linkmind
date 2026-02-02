/**
 * Pipeline: shared link processing logic (scrape → analyze → export).
 */

import { insertLink, updateLink, getLink } from "./db.js";
import { scrapeUrl } from "./scraper.js";
import { analyzeArticle } from "./agent.js";
import { exportLinkMarkdown } from "./export.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "pipeline" });

export interface ProcessResult {
  linkId: number;
  title: string;
  url: string;
  status: "analyzed" | "error";
  error?: string;
}

export type ProgressCallback = (stage: string) => void | Promise<void>;

/**
 * Process a URL through the full pipeline: scrape → analyze → export.
 */
export async function processUrl(
  url: string,
  onProgress?: ProgressCallback,
): Promise<ProcessResult> {
  const linkId = insertLink(url);
  log.info({ url, linkId }, "Processing URL");

  try {
    // Scrape
    await onProgress?.("scraping");
    const scrapeResult = await scrapeUrl(url);

    updateLink(linkId, {
      og_title: scrapeResult.og.title,
      og_description: scrapeResult.og.description,
      og_image: scrapeResult.og.image,
      og_site_name: scrapeResult.og.siteName,
      og_type: scrapeResult.og.type,
      markdown: scrapeResult.markdown,
      status: "scraped",
    });

    log.info(
      { title: scrapeResult.og.title || url, chars: scrapeResult.markdown.length },
      "Scraped",
    );

    // Analyze
    await onProgress?.("analyzing");
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
      status: "analyzed",
    });

    log.info({ title: scrapeResult.og.title || url }, "Analyzed");

    // Export markdown
    const fullLink = getLink(linkId);
    if (fullLink) {
      try {
        const exportPath = exportLinkMarkdown(fullLink);
        log.info({ path: exportPath }, "Exported markdown");
      } catch (exportErr) {
        log.error({ err: exportErr }, "Export failed");
      }
    }

    return {
      linkId,
      title: scrapeResult.og.title || url,
      url,
      status: "analyzed",
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error({ url, linkId, err: errMsg }, "Processing failed");

    try {
      updateLink(linkId, { status: "error", error_message: errMsg });
    } catch {}

    return {
      linkId,
      title: url,
      url,
      status: "error",
      error: errMsg,
    };
  }
}
