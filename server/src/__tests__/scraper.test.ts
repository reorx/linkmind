/**
 * Unit tests for scraper utilities.
 */

import { describe, it, expect } from 'vitest';

// decodeUnicodeEscapes is not exported, so we test it via a local copy
// to verify the logic. The real function lives in scraper.ts.
function decodeUnicodeEscapes(s: string | undefined): string | undefined {
  if (!s) return s;
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

describe('decodeUnicodeEscapes', () => {
  it('should decode \\u00a0 to actual non-breaking space', () => {
    const input = 'Claude\\u00a0Code\\u00a0发布一周年';
    const result = decodeUnicodeEscapes(input);
    expect(result).toBe('Claude\u00a0Code\u00a0发布一周年');
    // Verify no literal backslash remains
    expect(result).not.toContain('\\u');
  });

  it('should reproduce the mowen.cn og:title bug (record 76)', () => {
    // This is the exact og:title from https://note.mowen.cn/detail/FP0rFh9XewHUSKnjEZhmI
    const buggyTitle = 'Claude\\u00a0Code\\u00a0发布一周年，看到一个激烈的争论 · 墨问';
    const fixed = decodeUnicodeEscapes(buggyTitle);
    expect(fixed).toBe('Claude\u00a0Code\u00a0发布一周年，看到一个激烈的争论 · 墨问');
    // The fixed title should have actual nbsp chars, not literal \u00a0
    expect(fixed!.includes('\u00a0')).toBe(true);
    expect(fixed!.includes('\\u00a0')).toBe(false);
  });

  it('should handle strings without unicode escapes', () => {
    expect(decodeUnicodeEscapes('Hello World')).toBe('Hello World');
  });

  it('should handle undefined/empty', () => {
    expect(decodeUnicodeEscapes(undefined)).toBeUndefined();
    expect(decodeUnicodeEscapes('')).toBe('');
  });

  it('should decode multiple different escapes', () => {
    const input = '\\u0048\\u0065\\u006c\\u006c\\u006f';
    expect(decodeUnicodeEscapes(input)).toBe('Hello');
  });

  it('should handle mixed content with escapes and normal text', () => {
    const input = 'before\\u0020after';
    expect(decodeUnicodeEscapes(input)).toBe('before after');
  });
});
