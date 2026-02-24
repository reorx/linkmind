/**
 * Web scraper: Playwright + defuddle for content extraction.
 * Twitter/X URLs are handled via the `bird` CLI tool.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import playwright from 'playwright';
import { Defuddle } from 'defuddle/node';
import { isTwitterUrl, htmlToSimpleMarkdown } from '@linkmind/core/scraper-utils';

const execFileAsync = promisify(execFile);

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
  const browser = await playwright.chromium.launch({
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

    // Extract content with defuddle
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
    };
  } catch (err) {
    await browser.close();
    throw err;
  }
}
