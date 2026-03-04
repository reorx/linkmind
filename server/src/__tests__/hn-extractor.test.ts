import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExtractManager, matchExtractor, HNExtractor } from '@substancejs/common';
import { extractWithSubstance, hasSubstanceExtractor } from '../scraper-substance.js';

const TEST_HTML_PATH = join(import.meta.dirname, '../../test-data/hn-47232453.html');
const TEST_URL = 'https://news.ycombinator.com/item?id=47232453';

describe('HNExtractor', () => {
  const html = readFileSync(TEST_HTML_PATH, 'utf-8');

  it('should match HN discussion URLs', () => {
    expect(matchExtractor(HNExtractor, html, TEST_URL)).toBe(true);
  });

  it('should not match non-HN URLs', () => {
    expect(matchExtractor(HNExtractor, html, 'https://example.com/article')).toBe(false);
  });

  it('should extract via ExtractManager and produce valid markdown', () => {
    const em = new ExtractManager(HNExtractor);
    const result = em.extract(html, TEST_URL);

    // First line should be the post title as a heading
    const firstLine = result.contentMarkdown.split('\n')[0];
    expect(firstLine).toBe('# MacBook Pro with M5 Pro and M5 Max');

    // Content should be substantial (well above 200-char validity threshold)
    expect(result.contentMarkdown.length).toBeGreaterThan(500);
    expect(result.title).toBeTruthy();
  });

  it('should extract extra data with comment count and points', () => {
    const em = new ExtractManager(HNExtractor);
    const result = em.extract(html, TEST_URL);
    expect(result.extraData.commentCount).toBeGreaterThan(0);
    expect(result.extraData.points).toBeGreaterThan(0);
    expect(result.extraData.author).toBeTruthy();
  });
});

describe('scraper-substance HN integration', () => {
  const html = readFileSync(TEST_HTML_PATH, 'utf-8');

  it('hasSubstanceExtractor should detect HN URLs', () => {
    expect(hasSubstanceExtractor(TEST_URL)).toBe(true);
    expect(hasSubstanceExtractor('https://example.com')).toBe(false);
  });

  it('extractWithSubstance should return valid ScrapeResult for HN', () => {
    const result = extractWithSubstance(html, TEST_URL);
    expect(result).not.toBeNull();

    // First line of markdown should be the title heading
    const firstLine = result!.markdown.split('\n')[0];
    expect(firstLine).toBe('# MacBook Pro with M5 Pro and M5 Max');

    // Must be >= 200 chars to pass isScrapeContentValid
    expect(result!.markdown.trim().length).toBeGreaterThanOrEqual(200);
    expect(result!.title).toContain('MacBook Pro');
    expect(result!.og.siteName).toBeTruthy();
  });

  it('should enforce markdown char limit for large HN output', () => {
    const oldLimit = process.env.HN_SUMMARY_MARKDOWN_CHAR_LIMIT;
    process.env.HN_SUMMARY_MARKDOWN_CHAR_LIMIT = '1200';

    try {
      const result = extractWithSubstance(html, TEST_URL);
      expect(result).not.toBeNull();
      expect(result!.markdown.length).toBeLessThanOrEqual(1200);
    } finally {
      if (oldLimit === undefined) {
        delete process.env.HN_SUMMARY_MARKDOWN_CHAR_LIMIT;
      } else {
        process.env.HN_SUMMARY_MARKDOWN_CHAR_LIMIT = oldLimit;
      }
    }
  });
});
