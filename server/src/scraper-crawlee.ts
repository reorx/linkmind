/**
 * Crawlee-based scraper: uses PlaywrightCrawler with automatic browser fingerprint
 * rotation for better anti-bot evasion than raw Playwright + stealth plugin.
 *
 * Designed for single-URL scraping, not crawling.
 */

import { PlaywrightCrawler, Configuration } from 'crawlee';
import { Defuddle } from 'defuddle/node';
import { htmlToSimpleMarkdown } from '@linkmind/core/scraper-utils';
import { logger } from './logger.js';

const log = logger.child({ module: 'crawlee' });

export interface CrawleeResult {
  url: string;
  og: {
    title?: string;
    description?: string;
    image?: string;
    siteName?: string;
    type?: string;
  };
  title?: string;
  author?: string;
  published?: string;
  markdown: string;
  rawHtml?: string;
}

/**
 * Scrape a single URL using Crawlee's PlaywrightCrawler.
 * Benefits: automatic browser fingerprinting, session rotation, better anti-detection.
 */
export async function scrapeWithCrawlee(url: string): Promise<CrawleeResult> {
  let result: CrawleeResult | null = null;
  let crawlError: Error | null = null;

  // Use in-memory config to avoid writing to disk (no storage directory needed)
  const config = new Configuration({
    persistStorage: false,
    purgeOnStart: true,
  });

  const crawler = new PlaywrightCrawler(
    {
      // Single URL, no need for retries at crawler level (we handle retries in fallback chain)
      maxRequestRetries: 0,
      requestHandlerTimeoutSecs: 30,
      headless: true,
      navigationTimeoutSecs: 30,
      browserPoolOptions: {
        useFingerprints: true,
      },
      launchContext: {
        launchOptions: {
          args: ['--disable-blink-features=AutomationControlled'],
        },
      },
      async requestHandler({ page, request }) {
        // Wait a bit for JS rendering
        await page.waitForTimeout(2000);

        // Extract OG metadata + preprocessed HTML
        const { og, html } = (await page.evaluate(`(() => {
          const getMeta = (prop) => {
            const el = document.querySelector('meta[property="' + prop + '"]') ||
              document.querySelector('meta[name="' + prop + '"]');
            return el ? el.getAttribute("content") : undefined;
          };

          const og = {
            title: getMeta("og:title") || document.title,
            description: getMeta("og:description") || getMeta("description"),
            image: getMeta("og:image"),
            siteName: getMeta("og:site_name"),
            type: getMeta("og:type"),
          };

          // Preprocess DOM
          document.querySelectorAll("script, style, link[rel='stylesheet']").forEach(el => el.remove());
          document.querySelectorAll("nav, footer, aside").forEach(el => el.remove());
          document.querySelectorAll("header").forEach(el => {
            if (!el.closest("article") && !el.closest("main")) el.remove();
          });
          document.querySelectorAll('[role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="search"]').forEach(el => el.remove());
          document.querySelectorAll('[class*="cookie-banner"], [id*="cookie-banner"], [class*="cookie-consent"], [class*="share-buttons"], [class*="social-share"], [class*="comment-section"], [id*="comments"]').forEach(el => el.remove());
          document.querySelectorAll('[hidden], [aria-hidden="true"]').forEach(el => el.remove());

          return { og, html: document.documentElement.outerHTML };
        })()`)) as { og: CrawleeResult['og']; html: string };

        // Extract content with Defuddle
        const _origLog = console.log;
        console.log = (msg: unknown, ...args: unknown[]) => {
          if (typeof msg === 'string' && msg.includes('Initial parse returned very little content')) return;
          _origLog(msg, ...args);
        };
        const defuddled = await Defuddle(html, request.loadedUrl || url);
        console.log = _origLog;

        const markdown = htmlToSimpleMarkdown(defuddled.content);

        result = {
          url: request.loadedUrl || url,
          og,
          title: defuddled.title || og.title,
          author: defuddled.author || undefined,
          published: defuddled.published || undefined,
          markdown,
          rawHtml: html,
        };
      },
      async failedRequestHandler({ request }, error) {
        crawlError = error instanceof Error ? error : new Error(String(error));
        log.error({ url: request.url, err: crawlError.message }, '[crawlee] Request failed');
      },
    },
    config,
  );

  log.info({ url }, '[crawlee] Starting');

  try {
    await crawler.run([url]);
  } finally {
    // Ensure crawler resources are cleaned up
    await crawler.teardown();
  }

  if (crawlError) {
    throw crawlError;
  }

  if (!result) {
    throw new Error('Crawlee returned no result');
  }

  log.info({ url, markdownLength: (result as CrawleeResult).markdown.length }, '[crawlee] OK');
  return result;
}
