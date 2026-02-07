/**
 * Web scraper: Playwright + defuddle for content extraction.
 * Twitter/X URLs are handled via the `bird` CLI tool.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import playwright from 'playwright';
import { Defuddle } from 'defuddle/node';

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

/**
 * Check if a URL is a Twitter/X tweet URL.
 */
export function isTwitterUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.hostname === 'twitter.com' ||
        u.hostname === 'www.twitter.com' ||
        u.hostname === 'x.com' ||
        u.hostname === 'www.x.com') &&
      /\/status\/\d+/.test(u.pathname)
    );
  } catch {
    return false;
  }
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

/**
 * Simple HTML to Markdown conversion (no external dependency).
 */
function htmlToSimpleMarkdown(html: string): string {
  if (!html) return '';

  let md = html;

  // Handle headings
  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n');
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n');
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n');
  md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n');
  md = md.replace(/<h5[^>]*>(.*?)<\/h5>/gi, '##### $1\n\n');
  md = md.replace(/<h6[^>]*>(.*?)<\/h6>/gi, '###### $1\n\n');

  // Handle paragraphs and line breaks
  md = md.replace(/<p[^>]*>/gi, '\n\n');
  md = md.replace(/<\/p>/gi, '');
  md = md.replace(/<br\s*\/?>/gi, '\n');

  // Handle bold and italic
  md = md.replace(/<(strong|b)[^>]*>(.*?)<\/(strong|b)>/gi, '**$2**');
  md = md.replace(/<(em|i)[^>]*>(.*?)<\/(em|i)>/gi, '*$2*');

  // Handle links
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');

  // Handle code
  md = md.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');
  md = md.replace(/<pre[^>]*>(.*?)<\/pre>/gis, '\n```\n$1\n```\n');

  // Handle lists
  md = md.replace(/<li[^>]*>/gi, '- ');
  md = md.replace(/<\/li>/gi, '\n');
  md = md.replace(/<\/?[uo]l[^>]*>/gi, '\n');

  // Handle blockquote
  md = md.replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gis, (_, content) => {
    return content
      .split('\n')
      .map((line: string) => `> ${line}`)
      .join('\n');
  });

  // Handle images
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, '![$2]($1)');
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, '![]($1)');

  // Strip remaining HTML tags
  md = md.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  md = md.replace(/&amp;/g, '&');
  md = md.replace(/&lt;/g, '<');
  md = md.replace(/&gt;/g, '>');
  md = md.replace(/&quot;/g, '"');
  md = md.replace(/&#39;/g, "'");
  md = md.replace(/&nbsp;/g, ' ');

  // Clean up excessive whitespace
  md = md.replace(/\n{3,}/g, '\n\n');
  md = md.trim();

  return md;
}
