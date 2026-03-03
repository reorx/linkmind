/**
 * Substance-based scraper for sites with dedicated extractors.
 *
 * Currently supports:
 * - WeChat Official Account articles (mp.weixin.qq.com)
 */

import { load } from 'cheerio';
// @ts-expect-error - @substancejs/common exports .ts source, no compiled type declarations
import { ExtractManager, matchExtractor, type Extractor } from '@substancejs/common';

import { WechatExtractor } from './extractors/wechat.js';
import type { ScrapeResult } from './scraper.js';

/** Registry of all Substance extractors */
const extractors: Extractor[] = [WechatExtractor];

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
    if (matchExtractor(ext, html, url)) {
      return ext;
    }
  }
  return null;
}

/**
 * Extract content from HTML using a Substance extractor.
 * Returns null if no extractor matches the URL/HTML.
 *
 * Note: Substance's ExtractManager doesn't process `author` and `publishedDate`
 * property handlers, so we extract them manually from the HTML using cheerio.
 */
export function extractWithSubstance(
  html: string,
  url: string,
): ScrapeResult | null {
  const extractor = findExtractor(html, url);
  if (!extractor) return null;

  const em = new ExtractManager(extractor);
  const result = em.extract(html, url);

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

  return {
    url,
    og: {
      title: result.title || undefined,
      description: result.extraData?.accountSignature || undefined,
      siteName: result.extraData?.accountName || 'WeChat',
    },
    title: result.title || undefined,
    author: author || result.author || undefined,
    published: published || result.publishedDate || undefined,
    markdown: result.contentMarkdown,
  };
}
