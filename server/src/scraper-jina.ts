/**
 * Jina Reader API scraper: fallback for paywall-protected sites.
 *
 * API: GET https://r.jina.ai/<url>
 * Docs: https://docs.jina.ai/
 */

import { logger } from './logger.js';
import { getNextCrawlerKey, addKeyUsage, markKeyExhausted } from './crawler-keys.js';

const log = logger.child({ module: 'jina' });

const JINA_READER_BASE = 'https://r.jina.ai/';

export interface JinaResult {
  markdown: string;
  metadata: {
    title?: string;
    description?: string;
    ogImage?: string;
    siteName?: string;
    publishedTime?: string;
  };
  usage: {
    tokens: number;
  };
}

interface JinaApiResponse {
  code: number;
  data: {
    title?: string;
    description?: string;
    url?: string;
    content?: string;
    publishedTime?: string;
    usage?: { tokens: number };
  };
}

/**
 * Scrape a URL using the Jina Reader API with key rotation.
 * Tries all available keys before giving up.
 * Returns null if no keys are configured or all keys are exhausted.
 */
export async function scrapeWithJina(url: string): Promise<JinaResult | null> {
  const triedKeyIds = new Set<number>();

  while (true) {
    const key = await getNextCrawlerKey('jina');
    if (!key || triedKeyIds.has(key.id)) {
      if (triedKeyIds.size === 0) {
        log.info('[jina] Skipped — no Jina API keys configured');
      } else {
        log.warn({ triedKeys: triedKeyIds.size }, '[jina] All keys exhausted');
      }
      return null;
    }

    triedKeyIds.add(key.id);
    log.info({ url, keyLabel: key.label }, '[jina] Starting');

    try {
      const response = await fetch(`${JINA_READER_BASE}${url}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key.api_key}`,
          Accept: 'application/json',
        },
      });

      if (response.status === 402 || response.status === 429) {
        log.warn({ url, keyLabel: key.label, status: response.status }, '[jina] Key exhausted/rate-limited');
        await markKeyExhausted(key.id);
        continue; // try next key
      }

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Jina API error ${response.status}: ${body.slice(0, 500)}`);
      }

      const json = (await response.json()) as JinaApiResponse;

      if (json.code !== 200 || !json.data) {
        throw new Error(`Jina API returned code=${json.code}`);
      }

      const tokensUsed = json.data.usage?.tokens ?? 0;
      if (tokensUsed > 0) {
        // Fire-and-forget: don't block on usage tracking
        addKeyUsage(key.id, tokensUsed).catch((err) => {
          log.error({ keyId: key.id, err: err.message }, '[jina] Failed to update key usage');
        });
      }

      const result: JinaResult = {
        markdown: json.data.content || '',
        metadata: {
          title: json.data.title,
          description: json.data.description,
          publishedTime: json.data.publishedTime,
        },
        usage: { tokens: tokensUsed },
      };

      log.info(
        { url, keyLabel: key.label, markdownLength: result.markdown.length, tokensUsed },
        '[jina] OK',
      );
      return result;
    } catch (err) {
      log.error({ url, keyLabel: key.label, err: err instanceof Error ? err.message : String(err) }, '[jina] Failed');
      throw err;
    }
  }
}
