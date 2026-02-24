/**
 * Firecrawl API scraper: fallback for when Playwright+Defuddle fails to extract content.
 *
 * API: POST https://api.firecrawl.dev/v2/scrape
 * Docs: https://docs.firecrawl.dev/api-reference/endpoint/scrape
 */

import { logger } from './logger.js';

const log = logger.child({ module: 'firecrawl' });

const FIRECRAWL_API_URL = 'https://api.firecrawl.dev/v2/scrape';

export interface FirecrawlResult {
  markdown: string;
  metadata: {
    title?: string;
    description?: string;
    ogImage?: string;
    siteName?: string;
    sourceURL?: string;
  };
}

/**
 * Scrape a URL using the Firecrawl API.
 * Returns null if FIRECRAWL_API_KEY is not configured.
 * Throws on API errors.
 */
export async function scrapeWithFirecrawl(url: string): Promise<FirecrawlResult | null> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    log.info('[firecrawl] Skipped — FIRECRAWL_API_KEY not configured');
    return null;
  }

  log.info({ url }, '[firecrawl] Starting');

  const response = await fetch(FIRECRAWL_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ['markdown'],
      onlyMainContent: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Firecrawl API error ${response.status}: ${body.slice(0, 500)}`);
  }

  const json = (await response.json()) as { success: boolean; data?: any; error?: string };

  if (!json.success) {
    throw new Error(`Firecrawl API returned success=false: ${json.error || 'unknown'}`);
  }

  const data = json.data;
  const result: FirecrawlResult = {
    markdown: data.markdown || '',
    metadata: {
      title: data.metadata?.title,
      description: data.metadata?.description || data.metadata?.ogDescription,
      ogImage: data.metadata?.ogImage,
      siteName: data.metadata?.ogSiteName,
      sourceURL: data.metadata?.sourceURL,
    },
  };

  log.info({ url, markdownLength: result.markdown.length }, '[firecrawl] OK');
  return result;
}
