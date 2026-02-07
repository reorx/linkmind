/**
 * Unified scraper: Twitter via bird CLI, web via Playwright + Defuddle.
 * Returns ScrapeData matching the server's interface.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import playwright from 'playwright';
import { Defuddle } from 'defuddle/node';
import type { ScrapeData } from '@linkmind/core';
import { htmlToSimpleMarkdown } from '@linkmind/core/scraper-utils';

const execFileAsync = promisify(execFile);

/**
 * Scrape a Twitter/X tweet using the bird CLI.
 */
export async function scrapeTwitter(url: string): Promise<ScrapeData> {
  const { stdout } = await execFileAsync('bird', ['read', '--json', '--cookie-source', 'chrome', url], {
    timeout: 60000,
  });

  const tweet = JSON.parse(stdout);
  return formatTweet(tweet);
}

function formatTweet(tweet: any): ScrapeData {
  const author = tweet.author || {};
  const authorName = author.name || '';
  const authorUsername = author.username || '';
  const text = tweet.text || '';
  const media: Array<{ type: string; url: string }> = tweet.media || [];
  const quoted = tweet.quotedTweet;

  // Build markdown (matches server's scraper.ts format)
  const parts: string[] = [];
  parts.push(text);

  if (quoted) {
    const qtAuthor = quoted.author || {};
    const qtName = qtAuthor.name || '';
    const qtUsername = qtAuthor.username || '';
    const qtAuthorStr = qtName ? `${qtName} (@${qtUsername})` : qtUsername || 'Unknown';

    parts.push('');
    parts.push(`> **${qtAuthorStr}:**`);
    for (const line of (quoted.text || '').split('\n')) {
      parts.push(`> ${line}`);
    }
  }

  if (media.length) {
    parts.push('');
    for (const m of media) {
      if (m.type === 'photo') {
        parts.push(`![](${m.url})`);
      } else if (m.type === 'video') {
        parts.push(`video: ${m.url || '(embedded)'}`);
      }
    }
  }

  const likeCount = tweet.likeCount ?? 0;
  const retweetCount = tweet.retweetCount ?? 0;
  const replyCount = tweet.replyCount ?? 0;
  parts.push('');
  parts.push(`---\n${likeCount} likes \u00b7 ${retweetCount} retweets \u00b7 ${replyCount} replies`);

  const markdown = parts.join('\n');

  // Title
  const firstLine = text.split('\n')[0].slice(0, 80);
  const ellipsis = text.split('\n')[0].length >= 80 ? '\u2026' : '';
  const title = `${authorName || authorUsername || 'Tweet'}: ${firstLine}${ellipsis}`;

  // OG image: first photo
  const ogImage = media.find((m) => m.type === 'photo')?.url || '';

  return {
    title,
    markdown,
    og_title: title,
    og_description: text.slice(0, 200),
    og_image: ogImage,
    og_site_name: 'X (Twitter)',
    og_type: 'article',
    raw_media: media.length > 0 ? media : undefined,
  };
}

/**
 * Scrape a web URL using Playwright + Defuddle.
 * Copied and adapted from server/src/scraper.ts.
 */
export async function scrapeWeb(url: string): Promise<ScrapeData> {
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
    await page.waitForTimeout(2000);

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

      document.querySelectorAll("script, style, link[rel='stylesheet']").forEach(el => el.remove());
      document.querySelectorAll("nav, footer, aside").forEach(el => el.remove());
      document.querySelectorAll("header").forEach(el => {
        if (!el.closest("article") && !el.closest("main")) el.remove();
      });
      document.querySelectorAll('[role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="search"]').forEach(el => el.remove());
      document.querySelectorAll('[class*="cookie-banner"], [id*="cookie-banner"], [class*="cookie-consent"], [class*="share-buttons"], [class*="social-share"], [class*="comment-section"], [id*="comments"]').forEach(el => el.remove());
      document.querySelectorAll('[hidden], [aria-hidden="true"]').forEach(el => el.remove());

      return { og, html: document.documentElement.outerHTML };
    })()`)) as {
      og: { title?: string; description?: string; image?: string; siteName?: string; type?: string };
      html: string;
    };

    await browser.close();

    // Extract content with defuddle
    const _origLog = console.log;
    console.log = (msg: unknown, ...args: unknown[]) => {
      if (typeof msg === 'string' && msg.includes('Initial parse returned very little content')) return;
      _origLog(msg, ...args);
    };
    const result = await Defuddle(html, url);
    console.log = _origLog;

    const markdown = htmlToSimpleMarkdown(result.content);

    return {
      title: result.title || og.title,
      markdown,
      og_title: og.title,
      og_description: og.description,
      og_image: og.image,
      og_site_name: og.siteName,
      og_type: og.type,
    };
  } catch (err) {
    await browser.close();
    throw err;
  }
}
