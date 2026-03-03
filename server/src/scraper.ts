/**
 * Web scraper: Playwright + defuddle for content extraction.
 * Twitter/X URLs are handled via the `bird` CLI tool.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Defuddle } from 'defuddle/node';

// Apply stealth plugin to avoid bot detection
chromium.use(StealthPlugin());
import { isTwitterUrl, htmlToSimpleMarkdown } from '@linkmind/core/scraper-utils';
import { hasSubstanceExtractor, extractWithSubstance } from './scraper-substance.js';

const execFileAsync = promisify(execFile);

export interface ScrapeTraceEntry {
  step: 'crawlee' | 'playwright' | 'playwright-retry' | 'jina' | 'firecrawl';
  success: boolean;
  elapsed_ms: number;
  markdown_length: number;
  reason?: string;
  error?: string;
}

export interface ScrapeChainResult {
  /** Final scrape data, null if all methods failed */
  data: ScrapeResult | null;
  /** Which step produced the final result */
  source: 'crawlee' | 'playwright' | 'playwright-retry' | 'jina' | 'firecrawl' | null;
  /** Debug trace of each attempted step */
  trace: ScrapeTraceEntry[];
}

export interface ScrapeResult {
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
  rawMedia?: Array<{ type: string; url: string }>; // Twitter media for image processing
}

export { isTwitterUrl } from '@linkmind/core/scraper-utils';

/**
 * Decode JS-style unicode escape sequences (\uXXXX) that appear as literal text.
 * Some sites (e.g. mowen.cn) incorrectly serialize JS escapes into HTML meta attributes,
 * producing literal "\u00a0" text instead of actual characters.
 */
function decodeUnicodeEscapes(s: string | undefined): string | undefined {
  if (!s) return s;
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

const MIN_CONTENT_CHARS = 200;

/**
 * Check if scraped markdown content is valid (non-empty and long enough to be meaningful article content).
 * Threshold: 200 chars — below this, content is likely navigation/placeholder, not real article body.
 */
export function isScrapeContentValid(markdown: string, minChars = MIN_CONTENT_CHARS): boolean {
  return markdown.trim().length >= minChars;
}

/**
 * Scrape a Twitter/X tweet using the `bird` CLI.
 */
async function scrapeTwitter(url: string): Promise<ScrapeResult> {
  // Read the tweet
  const { stdout } = await execFileAsync('bird', ['read', '--json', '--cookie-source', 'chrome', url], {
    timeout: 30000,
  });

  const tweet = JSON.parse(stdout);

  const author = tweet.author?.name
    ? `${tweet.author.name} (@${tweet.author.username})`
    : tweet.author?.username || 'Unknown';

  // Build markdown content
  const parts: string[] = [];
  parts.push(tweet.text || '');

  // Include quoted tweet if present
  if (tweet.quotedTweet) {
    const qt = tweet.quotedTweet;
    const qtAuthor = qt.author?.name ? `${qt.author.name} (@${qt.author.username})` : qt.author?.username || 'Unknown';
    parts.push('');
    parts.push(`> **${qtAuthor}:**`);
    for (const line of (qt.text || '').split('\n')) {
      parts.push(`> ${line}`);
    }
  }

  // Include media descriptions
  if (tweet.media?.length) {
    parts.push('');
    for (const m of tweet.media) {
      if (m.type === 'photo') {
        parts.push(`![](${m.url})`);
      } else if (m.type === 'video') {
        parts.push(`🎥 Video: ${m.url || '(embedded)'}`);
      }
    }
  }

  // Stats line
  parts.push('');
  parts.push(`---\n❤️ ${tweet.likeCount ?? 0} · 🔁 ${tweet.retweetCount ?? 0} · 💬 ${tweet.replyCount ?? 0}`);

  const markdown = parts.join('\n');

  // Parse date
  const published = tweet.createdAt || undefined;

  // Title: author + first line of text (truncated)
  const firstLine = (tweet.text || '').split('\n')[0].slice(0, 80);
  const title = `${tweet.author?.name || tweet.author?.username || 'Tweet'}: ${firstLine}${firstLine.length >= 80 ? '…' : ''}`;

  // OG image: use first media image or author avatar
  const ogImage = tweet.media?.find((m: any) => m.type === 'photo')?.url;

  return {
    url,
    og: {
      title,
      description: (tweet.text || '').slice(0, 200),
      image: ogImage,
      siteName: 'X (Twitter)',
      type: 'article',
    },
    title,
    author,
    published,
    markdown,
    rawMedia: tweet.media || undefined,
  };
}

/**
 * Scrape a URL: fetch with Playwright, extract OG metadata + article content as Markdown.
 * Twitter/X URLs are handled via the `bird` CLI.
 */
export async function scrapeUrl(url: string): Promise<ScrapeResult> {
  // Route Twitter/X URLs to bird CLI
  if (isTwitterUrl(url)) {
    return scrapeTwitter(url);
  }
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
  });

  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000); // Wait for JS rendering

    // Extract OpenGraph metadata + preprocessed HTML in a single evaluate call
    // Using a string template to avoid tsx __name decoration issues with page.evaluate
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
    })()`)) as { og: ScrapeResult['og']; html: string };

    await browser.close();

    // Decode unicode escapes in OG metadata (some sites emit literal \uXXXX in HTML attributes)
    og.title = decodeUnicodeEscapes(og.title);
    og.description = decodeUnicodeEscapes(og.description);
    og.siteName = decodeUnicodeEscapes(og.siteName);

    // Try Substance extractor first (for sites with dedicated extractors like WeChat)
    if (hasSubstanceExtractor(url)) {
      const substanceResult = extractWithSubstance(html, url);
      if (substanceResult && substanceResult.markdown.trim().length > 0) {
        // Merge OG metadata from Playwright (more reliable for images) with Substance result
        return {
          ...substanceResult,
          og: {
            ...substanceResult.og,
            image: og.image || substanceResult.og.image,
            description: og.description || substanceResult.og.description,
            type: og.type,
          },
          rawHtml: html,
        };
      }
    }

    // Extract content with defuddle (default path)
    const _origLog = console.log;
    console.log = (msg: unknown, ...args: unknown[]) => {
      if (typeof msg === 'string' && msg.includes('Initial parse returned very little content')) return;
      _origLog(msg, ...args);
    };
    const result = await Defuddle(html, url);
    console.log = _origLog;

    // Convert HTML content to simple Markdown
    const markdown = htmlToSimpleMarkdown(result.content);

    return {
      url,
      og,
      title: result.title || og.title,
      author: result.author || undefined,
      published: result.published || undefined,
      markdown,
      rawHtml: html,
    };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

/**
 * Run the full scrape fallback chain: Crawlee → Playwright → Playwright retry → Jina → Firecrawl.
 * Returns the result + a trace of every step attempted.
 * Does NOT touch the database or probe — pure scraping only.
 */
export async function scrapeWithFallbackChain(
  url: string,
  options?: { skipPlaywright?: boolean },
): Promise<ScrapeChainResult> {
  const { scrapeWithFirecrawl } = await import('./scraper-firecrawl.js');
  const trace: ScrapeTraceEntry[] = [];
  let finalData: ScrapeResult | null = null;
  let source: ScrapeChainResult['source'] = null;

  if (!options?.skipPlaywright) {
    // Attempt 0: Crawlee (PlaywrightCrawler with fingerprint rotation)
    {
      const { scrapeWithCrawlee } = await import('./scraper-crawlee.js');
      const t0 = Date.now();
      try {
        const crawleeResult = await scrapeWithCrawlee(url);
        const elapsed = Date.now() - t0;
        const valid = isScrapeContentValid(crawleeResult.markdown);
        trace.push({
          step: 'crawlee',
          success: valid,
          elapsed_ms: elapsed,
          markdown_length: crawleeResult.markdown.length,
          ...(!valid && { reason: `content too short (${crawleeResult.markdown.length} < ${MIN_CONTENT_CHARS})` }),
        });
        if (valid) {
          return {
            data: {
              url: crawleeResult.url,
              og: crawleeResult.og,
              title: crawleeResult.title,
              author: crawleeResult.author,
              published: crawleeResult.published,
              markdown: crawleeResult.markdown,
              rawHtml: crawleeResult.rawHtml,
            },
            source: 'crawlee',
            trace,
          };
        }
        // Keep metadata for fallback
        finalData = {
          url: crawleeResult.url,
          og: crawleeResult.og,
          title: crawleeResult.title,
          markdown: crawleeResult.markdown,
          rawHtml: crawleeResult.rawHtml,
        };
      } catch (err) {
        trace.push({
          step: 'crawlee',
          success: false,
          elapsed_ms: Date.now() - t0,
          markdown_length: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Attempt 1: Playwright + Defuddle
    {
      const t0 = Date.now();
      try {
        const result = await scrapeUrl(url);
        const elapsed = Date.now() - t0;
        const valid = isScrapeContentValid(result.markdown);
        trace.push({
          step: 'playwright',
          success: valid,
          elapsed_ms: elapsed,
          markdown_length: result.markdown.length,
          ...(!valid && { reason: `content too short (${result.markdown.length} < ${MIN_CONTENT_CHARS})` }),
        });
        if (valid) {
          return { data: result, source: 'playwright', trace };
        }
        finalData = result; // keep for metadata fallback
      } catch (err) {
        trace.push({
          step: 'playwright',
          success: false,
          elapsed_ms: Date.now() - t0,
          markdown_length: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Attempt 2: Playwright retry
    {
      const t0 = Date.now();
      try {
        const result = await scrapeUrl(url);
        const elapsed = Date.now() - t0;
        const valid = isScrapeContentValid(result.markdown);
        trace.push({
          step: 'playwright-retry',
          success: valid,
          elapsed_ms: elapsed,
          markdown_length: result.markdown.length,
          ...(!valid && { reason: `content too short (${result.markdown.length} < ${MIN_CONTENT_CHARS})` }),
        });
        if (valid) {
          return { data: result, source: 'playwright-retry', trace };
        }
        finalData = result;
      } catch (err) {
        trace.push({
          step: 'playwright-retry',
          success: false,
          elapsed_ms: Date.now() - t0,
          markdown_length: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Attempt 3: Jina Reader API (key rotation)
  {
    const { scrapeWithJina } = await import('./scraper-jina.js');
    const t0 = Date.now();
    try {
      const jinaResult = await scrapeWithJina(url);
      const elapsed = Date.now() - t0;
      if (jinaResult && isScrapeContentValid(jinaResult.markdown)) {
        trace.push({
          step: 'jina',
          success: true,
          elapsed_ms: elapsed,
          markdown_length: jinaResult.markdown.length,
        });
        const data: ScrapeResult = {
          url,
          og: {
            title: jinaResult.metadata.title || finalData?.og.title,
            description: jinaResult.metadata.description || finalData?.og.description,
            image: finalData?.og.image,
            siteName: jinaResult.metadata.siteName || finalData?.og.siteName,
          },
          title: jinaResult.metadata.title || finalData?.title,
          published: jinaResult.metadata.publishedTime || finalData?.published,
          markdown: jinaResult.markdown,
        };
        return { data, source: 'jina', trace };
      }

      const mdLen = jinaResult?.markdown.length ?? 0;
      trace.push({
        step: 'jina',
        success: false,
        elapsed_ms: elapsed,
        markdown_length: mdLen,
        reason: jinaResult ? `content too short (${mdLen} < ${MIN_CONTENT_CHARS})` : 'no Jina API keys available',
      });
    } catch (err) {
      trace.push({
        step: 'jina',
        success: false,
        elapsed_ms: Date.now() - t0,
        markdown_length: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Attempt 4: Firecrawl API
  {
    const t0 = Date.now();
    try {
      const fcResult = await scrapeWithFirecrawl(url);
      const elapsed = Date.now() - t0;
      if (fcResult && isScrapeContentValid(fcResult.markdown)) {
        trace.push({
          step: 'firecrawl',
          success: true,
          elapsed_ms: elapsed,
          markdown_length: fcResult.markdown.length,
        });
        // Build a ScrapeResult from Firecrawl data, using previous OG as fallback
        const data: ScrapeResult = {
          url,
          og: {
            title: fcResult.metadata.title || finalData?.og.title,
            description: fcResult.metadata.description || finalData?.og.description,
            image: fcResult.metadata.ogImage || finalData?.og.image,
            siteName: fcResult.metadata.siteName || finalData?.og.siteName,
          },
          title: fcResult.metadata.title || finalData?.title,
          markdown: fcResult.markdown,
        };
        return { data, source: 'firecrawl', trace };
      }

      const mdLen = fcResult?.markdown.length ?? 0;
      trace.push({
        step: 'firecrawl',
        success: false,
        elapsed_ms: elapsed,
        markdown_length: mdLen,
        reason: fcResult ? `content too short (${mdLen} < ${MIN_CONTENT_CHARS})` : 'FIRECRAWL_API_KEY not configured',
      });
    } catch (err) {
      trace.push({
        step: 'firecrawl',
        success: false,
        elapsed_ms: Date.now() - t0,
        markdown_length: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // All methods failed — return whatever we have (may be short content from Playwright)
  return { data: finalData, source: null, trace };
}
