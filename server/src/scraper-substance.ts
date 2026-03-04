/**
 * Substance-based scraper for sites with dedicated extractors.
 *
 * Currently supports:
 * - WeChat Official Account articles (mp.weixin.qq.com)
 * - Hacker News discussions (news.ycombinator.com) — via @substancejs/common built-in
 */

import { load } from 'cheerio';
import { ExtractManager, matchExtractor, HNExtractor, type Extractor } from '@substancejs/common';

import { WechatExtractor } from './extractors/wechat.js';
import type { ScrapeResult } from './scraper.js';
import { getHNSummaryMarkdownCharLimit } from './hn-limits.js';

/** Registry of all Substance extractors */
const extractors: Extractor[] = [WechatExtractor, HNExtractor];
const HN_CONDENSE_MAX_ATTEMPTS = 8;
const HN_TRUNCATION_NOTICE = '\n\n...（内容过长，已按长度限制截断剩余评论）';

function isSubstanceDebugEnabled(): boolean {
  return process.env.LINKMIND_SUBSTANCE_DEBUG === '1' || process.env.SUBSTANCE_DEBUG === '1';
}

function debugSubstance(message: string, details?: Record<string, unknown>): void {
  if (!isSubstanceDebugEnabled()) return;
  if (details) {
    console.info(`[substance] ${message}`, details);
    return;
  }
  console.info(`[substance] ${message}`);
}

/**
 * Check if a URL has a matching Substance extractor.
 */
export function hasSubstanceExtractor(url: string): boolean {
  // Quick domain check before loading HTML
  try {
    const hostname = new URL(url).hostname;
    return extractors.some((ext) => {
      if (!ext.match.domain) return false;
      if (typeof ext.match.domain === 'string') return ext.match.domain === hostname;
      return ext.match.domain.test(hostname);
    });
  } catch {
    return false;
  }
}

/**
 * Find the matching extractor for a given URL and HTML.
 */
function findExtractor(html: string, url: string): Extractor | null {
  for (const ext of extractors) {
    const matched = matchExtractor(ext, html, url);
    debugSubstance('extractor match check', {
      url,
      extractorDomain: typeof ext.match.domain === 'string' ? ext.match.domain : ext.match.domain?.toString(),
      matched,
    });
    if (matched) {
      return ext;
    }
  }
  return null;
}

function truncateHNMarkdown(markdown: string, limit: number): string {
  if (markdown.length <= limit) return markdown;

  // Prefer cutting at comment boundary to keep markdown structure readable.
  const boundary = markdown.lastIndexOf('\n- @', limit);
  const cutAt = boundary > Math.floor(limit * 0.6) ? boundary : limit;

  const roomForNotice = Math.max(0, limit - HN_TRUNCATION_NOTICE.length);
  const trimmed = markdown.slice(0, Math.min(cutAt, roomForNotice)).trimEnd();
  return (trimmed + HN_TRUNCATION_NOTICE).slice(0, limit);
}

/**
 * Extract content from HTML using a Substance extractor.
 * Returns null if no extractor matches the URL/HTML.
 *
 * Note: Substance's ExtractManager doesn't process `author` and `publishedDate`
 * property handlers, so we extract them manually from the HTML using cheerio.
 */
export function extractWithSubstance(html: string, url: string): ScrapeResult | null {
  debugSubstance('starting extraction', {
    url,
    htmlLength: html.length,
  });

  const extractor = findExtractor(html, url);
  if (!extractor) {
    debugSubstance('no extractor matched', { url });
    return null;
  }

  const em = new ExtractManager(extractor);
  let result = em.extract(html, url);
  let markdown = result.contentMarkdown || '';

  // HN threads can be extremely long. Keep markdown within summarize budget:
  // uncondensed -> condenseComments=true -> repeat check; if no further shrink, hard-cap.
  if (extractor === HNExtractor) {
    const charLimit = getHNSummaryMarkdownCharLimit();
    let attempts = 0;
    let useCondense = false;
    let previousLength = markdown.length;

    while (markdown.length > charLimit && attempts < HN_CONDENSE_MAX_ATTEMPTS) {
      attempts += 1;
      useCondense = true;

      const next = em.extract(html, url, { condenseComments: true });
      const nextMarkdown = next.contentMarkdown || '';

      debugSubstance('hn markdown over limit, retry with condense', {
        attempt: attempts,
        previousLength,
        nextLength: nextMarkdown.length,
        charLimit,
      });

      result = next;
      markdown = nextMarkdown;

      if (markdown.length <= charLimit) break;

      if (markdown.length >= previousLength) {
        markdown = truncateHNMarkdown(markdown, charLimit);
        break;
      }

      previousLength = markdown.length;
    }

    if (useCondense && markdown.length > charLimit) {
      markdown = truncateHNMarkdown(markdown, charLimit);
    }
  }

  result.contentMarkdown = markdown;
  debugSubstance('extract manager completed', {
    url,
    contentLength: result.content?.length ?? 0,
    markdownLength: markdown.length,
  });

  // Manually extract author and publishedDate since Substance doesn't process them
  const $ = load(html, undefined, false);

  let author: string | undefined;
  if (extractor.author?.selectors) {
    for (const sel of extractor.author.selectors) {
      const text = $(sel).text().trim();
      if (text) {
        author = text;
        break;
      }
    }
  }

  let published: string | undefined;
  if (extractor.publishedDate?.selectors) {
    for (const sel of extractor.publishedDate.selectors) {
      const text = $(sel).text().trim();
      if (text) {
        published = text;
        break;
      }
    }
  }

  // Build siteName from extraData or URL hostname
  let siteName: string | undefined;
  if (result.extraData?.accountName) {
    siteName = result.extraData.accountName as string;
  } else {
    try {
      siteName = new URL(url).hostname;
    } catch {
      // ignore
    }
  }

  return {
    url,
    og: {
      title: result.title || undefined,
      description: (result.extraData?.accountSignature as string) || undefined,
      siteName,
    },
    title: result.title || undefined,
    author: author || result.author || undefined,
    published: published || result.publishedDate || undefined,
    markdown,
  };
}
