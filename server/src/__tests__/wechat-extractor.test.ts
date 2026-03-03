import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExtractManager, matchExtractor } from '@substancejs/common';
import { WechatExtractor } from '../extractors/wechat.js';
import { extractWithSubstance, hasSubstanceExtractor } from '../scraper-substance.js';

const TEST_HTML_PATH = join(import.meta.dirname, '../../test-data/weixin-Gul8WUEvRvcDuRsFehfL3w.html');
const TEST_URL = 'https://mp.weixin.qq.com/s/Gul8WUEvRvcDuRsFehfL3w';
const TEST_HTML_PATH_LWCRAB = join(
  import.meta.dirname,
  '../../test-data/weixin-LWcRabPmQy6kd1qqv9MmXA.html',
);
const TEST_URL_LWCRAB = 'https://mp.weixin.qq.com/s/LWcRabPmQy6kd1qqv9MmXA';

describe('WechatExtractor', () => {
  const html = readFileSync(TEST_HTML_PATH, 'utf-8');

  it('should match WeChat article URLs', () => {
    expect(matchExtractor(WechatExtractor, html, TEST_URL)).toBe(true);
  });

  it('should not match non-WeChat URLs', () => {
    expect(matchExtractor(WechatExtractor, html, 'https://example.com/article')).toBe(false);
  });

  it('should extract title', () => {
    const em = new ExtractManager(WechatExtractor);
    const result = em.extract(html, TEST_URL);
    expect(result.title).toContain('2026新年建议');
  });

  it('should extract article content as markdown', () => {
    const em = new ExtractManager(WechatExtractor);
    const result = em.extract(html, TEST_URL);
    expect(result.contentMarkdown.length).toBeGreaterThan(500);
    // Should contain article content
    expect(result.contentMarkdown).toContain('瑞秋');
    expect(result.contentMarkdown).toContain('操心');
  });

  it('should extract extra data (account info)', () => {
    const em = new ExtractManager(WechatExtractor);
    const result = em.extract(html, TEST_URL);
    expect(result.extraData.accountName).toBe('瑞秋三思');
    expect(result.extraData.accountAlias).toBe('Racheland3kids');
    expect(result.extraData.isOriginal).toBe(true);
  });

  it('should keep promotional content by default', () => {
    const em = new ExtractManager(WechatExtractor);
    const result = em.extract(html, TEST_URL);
    expect(result.contentMarkdown).toContain('好物推荐');
  });
});

describe('scraper-substance integration', () => {
  it('hasSubstanceExtractor should detect WeChat URLs', () => {
    expect(hasSubstanceExtractor(TEST_URL)).toBe(true);
    expect(hasSubstanceExtractor('https://example.com')).toBe(false);
  });

  it('extractWithSubstance should return ScrapeResult for WeChat', () => {
    const html = readFileSync(TEST_HTML_PATH, 'utf-8');
    const result = extractWithSubstance(html, TEST_URL);
    expect(result).not.toBeNull();
    expect(result!.title).toContain('2026新年建议');
    expect(result!.markdown.length).toBeGreaterThan(500);
    expect(result!.author).toBeTruthy();
    expect(result!.og.siteName).toBeTruthy();
  });

  it('should extract full content from LWcRabPmQy6kd1qqv9MmXA instead of empty markdown', () => {
    const html = readFileSync(TEST_HTML_PATH_LWCRAB, 'utf-8');
    const em = new ExtractManager(WechatExtractor);
    const emResult = em.extract(html, TEST_URL_LWCRAB);
    expect(emResult.contentMarkdown.length).toBeGreaterThan(2000);
    expect(emResult.contentMarkdown).toContain('情绪劳动');

    const result = extractWithSubstance(html, TEST_URL_LWCRAB);
    expect(result).not.toBeNull();
    expect(result!.title).toContain('为什么我们总觉得陪小孩特别累');
    expect(result!.markdown.length).toBeGreaterThan(2000);
    expect(result!.markdown).toContain('情绪劳动');
  });
});
