// @ts-nocheck — Substance's Extractor callback signatures use untyped parameters.
/**
 * WeChat Official Account (微信公众号) article extractor for Substance.
 *
 * Handles mp.weixin.qq.com article pages — extracts title, author, publish date,
 * and article body with proper image handling and noise removal.
 */

import type { Extractor } from '@substancejs/common';

function isSubstanceDebugEnabled(): boolean {
  return process.env.LINKMIND_SUBSTANCE_DEBUG === '1' || process.env.SUBSTANCE_DEBUG === '1';
}

function debugWechat(message: string, details?: Record<string, unknown>): void {
  if (!isSubstanceDebugEnabled()) return;
  if (details) {
    console.info(`[substance:wechat] ${message}`, details);
    return;
  }
  console.info(`[substance:wechat] ${message}`);
}

export const WechatExtractor: Extractor = {
  match: {
    domain: /^mp\.weixin\.qq\.com$/,
    selectors: ['#js_content'],
  },

  options: {
    removeImages: {
      help: 'Remove all images from the output',
      default: false,
    },
    removePromotions: {
      help: 'Remove promotional sections at the end (好物推荐, 近期好文, etc.)',
      default: true,
    },
  },

  content: {
    selectors: ['#js_content'],

    clean: [
      // WeChat profile cards
      'mp-common-profile',
      // Mini-program embeds
      'mp-miniprogram',
      // Style type markers
      'mp-style-type',
      // Hidden elements
      '[style*="display: none"]',
      '[style*="display:none"]',
      // Empty SVG decorations (used for visual ornaments in WeChat editor)
      'svg[role="img"][aria-label="插图"]',
      'svg[viewBox="0 0 1 1"]',
    ],

    // Extract profile data from raw HTML before cheerio parsing strips custom elements.
    // cheerio's parser drops <mp-common-profile> custom tags, so we use regex on raw HTML.
    preprocess: (_$, _$content, state) => {
      const html = state.html;
      const profileMatch = html.match(/<mp-common-profile[^>]*>/);
      if (profileMatch) {
        const tag = profileMatch[0];
        const getAttr = (name: string) => {
          const m = tag.match(new RegExp(`${name}="([^"]*)"`));
          return m ? m[1] : undefined;
        };
        state.sharedData._profileData = {
          accountName: getAttr('data-nickname'),
          accountAlias: getAttr('data-alias'),
          accountSignature: getAttr('data-signature'),
        };
      }
    },

    transforms: {
      // Handle lazy-loaded images: data-src → src
      'img[data-src]': ($el) => {
        const dataSrc = $el.attr('data-src');
        if (dataSrc) {
          $el.attr('src', dataSrc);
        }
        // Clean up WeChat-specific attributes
        $el.removeAttr('data-src');
        $el.removeAttr('data-ratio');
        $el.removeAttr('data-type');
        $el.removeAttr('data-w');
        $el.removeAttr('data-s');
        $el.removeAttr('data-fail');
        $el.removeAttr('data-index');
        $el.removeAttr('data-original-style');
        $el.removeAttr('data-cropselx1');
        $el.removeAttr('data-cropselx2');
        $el.removeAttr('data-cropsely1');
        $el.removeAttr('data-cropsely2');
        $el.removeAttr('data-report-img-idx');
        $el.removeAttr('data-aistatus');
        $el.removeAttr('_width');
        $el.removeAttr('class');
        $el.removeAttr('style');
      },

      // Convert inline bold spans to <strong>
      'span[textstyle]': ($el) => {
        const style = $el.attr('textstyle') || '';
        if (style.includes('font-weight: bold') || style.includes('font-weight:bold')) {
          $el.replaceWith(`<strong>${$el.html()}</strong>`);
        }
      },
    },

    processElement: ($, $content, state) => {
      // Remove images if option set
      if (state.options.removeImages) {
        $content.find('img').remove();
      }

      // Remove promotional sections at the end if option is enabled
      if (state.options.removePromotions) {
        const promotionKeywords = ['好物推荐', '近期好文', '往期精选', '推荐阅读', '相关推荐'];
        const htmlBeforePromotionCleanup = $content.html() || '';
        const textBeforePromotionCleanup = $content.text().replace(/\s+/g, ' ').trim();
        let matchedPromotionKeyword: string | undefined;
        let matchedPromotionText: string | undefined;

        // WeChat articles are deeply nested sections. We need to find the
        // promotion marker and remove it + all subsequent siblings at the
        // appropriate nesting level — NOT the top-level container.
        let done = false;
        $content.find('p, span').each((_, el) => {
          if (done) return;
          const $el = $(el);
          const text = $el.text().trim();
          for (const keyword of promotionKeywords) {
            if (text.includes(keyword) && text.length < 50) {
              done = true;
              matchedPromotionKeyword = keyword;
              matchedPromotionText = text;
              // Walk up from the matched element, but stop BEFORE the direct
              // child of $content (which often wraps the entire article).
              // Instead, find the closest ancestor that has siblings after it.
              let target = $el;
              const parents = $el.parentsUntil($content);
              // Try each ancestor level (innermost to outermost), stop at the
              // one whose removal doesn't wipe the whole article.
              for (let j = 0; j < parents.length; j++) {
                const ancestor = $(parents[j]);
                // If this ancestor has preceding siblings, it's safe to remove
                // it and everything after it at this level.
                if (ancestor.prev().length > 0) {
                  target = ancestor;
                  break;
                }
                // If it's the only child (no prev siblings), going up more
                // would delete the whole article. Stay at current level.
                if (j === parents.length - 1) {
                  // We're at the top-level child of $content — don't remove it.
                  // Instead, remove from the matched element's immediate parent.
                  target = $(parents[0]);
                  break;
                }
              }
              target.nextAll().remove();
              target.remove();
              return;
            }
          }
        });

        if (done) {
          const textAfterPromotionCleanup = $content.text().replace(/\s+/g, ' ').trim();

          debugWechat('promotion cleanup applied', {
            matchedPromotionKeyword,
            matchedPromotionText,
            beforeTextLength: textBeforePromotionCleanup.length,
            afterTextLength: textAfterPromotionCleanup.length,
          });

          // Guard against aggressive cleanup wiping the entire article body.
          if (textBeforePromotionCleanup.length > 500 && textAfterPromotionCleanup.length < 200) {
            $content.html(htmlBeforePromotionCleanup);
            debugWechat('promotion cleanup rolled back due to over-removal', {
              matchedPromotionKeyword,
              beforeTextLength: textBeforePromotionCleanup.length,
              afterTextLength: textAfterPromotionCleanup.length,
            });
          }
        }
      }

      // Remove empty paragraphs that only contain <br> or whitespace
      $content.find('p').each((_, el) => {
        const $el = $(el);
        const text = $el.text().trim();
        const html = $el.html()?.trim() || '';
        if (!text && (html === '<br>' || html === '<br/>' || html === '' || html === '<br >')) {
          $el.remove();
        }
      });
    },

    turndown: {
      options: {
        headingStyle: 'atx' as const,
        hr: '---',
        bulletListMarker: '-',
        codeBlockStyle: 'fenced' as const,
        emDelimiter: '_',
      },
      customize: (_$, turndownService) => {
        // Keep tables
        turndownService.keep((node) => {
          return node.nodeName === 'TABLE';
        });
      },
    },
  },

  title: {
    selectors: ['#activity-name', 'meta[property="og:title"]'],
  },

  author: {
    selectors: ['#js_name', 'meta[property="og:article:author"]'],
  },

  publishedDate: {
    selectors: ['#publish_time'],
  },

  extraData: ($, state) => {
    const extraData: Record<string, unknown> = {};

    // Use profile data saved in preprocess (before clean removed elements)
    const profileData = state.sharedData._profileData;
    if (profileData) {
      extraData.accountName = profileData.accountName;
      extraData.accountAlias = profileData.accountAlias;
      extraData.accountSignature = profileData.accountSignature;
    }

    // Fallback: try elements still in the DOM
    if (!extraData.accountName) {
      const profileEl = $('mp-common-profile').first();
      if (profileEl.length) {
        extraData.accountName = profileEl.attr('data-nickname') || undefined;
      }
    }
    if (!extraData.accountName) {
      const jsName = $('#js_name').text().trim();
      if (jsName) {
        extraData.accountName = jsName;
      }
    }

    // Get original/repost flag
    const copyright = $('#copyright_logo');
    if (copyright.length && copyright.text().trim()) {
      extraData.isOriginal = true;
    }

    // Get IP location
    const ipWording = $('#js_ip_wording_wrp');
    if (ipWording.length) {
      const location = ipWording.attr('aria-label') || ipWording.text().trim();
      if (location) {
        extraData.ipLocation = location;
      }
    }

    return extraData;
  },
};
