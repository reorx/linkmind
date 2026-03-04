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

  it('should extract via ExtractManager without throwing', () => {
    const em = new ExtractManager(HNExtractor);
    const result = em.extract(html, TEST_URL);
    expect(result.contentMarkdown.length).toBeGreaterThan(500);
    expect(result.title).toBeTruthy();
  });

  it('should produce structured markdown with comment tree', () => {
    const em = new ExtractManager(HNExtractor);
    const result = em.extract(html, TEST_URL);
    // Should contain post title
    expect(result.contentMarkdown).toContain('MacBook Pro');
    // Should contain comment markers (@ prefix for authors)
    expect(result.contentMarkdown).toMatch(/@\w+/);
    // Should contain multiple comments
    const commentCount = (result.contentMarkdown.match(/- @\w+/g) || []).length;
    expect(commentCount).toBeGreaterThan(10);
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

  it('extractWithSubstance should return ScrapeResult for HN', () => {
    const result = extractWithSubstance(html, TEST_URL);
    expect(result).not.toBeNull();
    expect(result!.title).toContain('MacBook Pro');
    expect(result!.markdown.length).toBeGreaterThan(500);
    expect(result!.og.siteName).toBeTruthy();
  });

  it('should produce markdown that passes content validity check', () => {
    const result = extractWithSubstance(html, TEST_URL);
    expect(result).not.toBeNull();
    // Must be >= 200 chars to pass isScrapeContentValid
    expect(result!.markdown.trim().length).toBeGreaterThanOrEqual(200);
  });
});
