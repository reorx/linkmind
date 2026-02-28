/**
 * Crawler API key management: round-robin key selection, usage tracking, exhaustion handling.
 */

import { sql } from 'kysely';
import { getDb } from './db/index.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'crawler-keys' });

export interface CrawlerApiKey {
  id: number;
  crawler_type: string;
  label: string;
  api_key: string;
  total_credits: number;
  used_credits: number;
  exhausted: boolean;
  enabled: boolean;
}

/** In-process round-robin index per crawler type */
const lastUsedIndex = new Map<string, number>();

/**
 * Get the next available API key for a crawler type (round-robin, skipping exhausted/disabled).
 * Returns null if no keys are available.
 */
export async function getNextCrawlerKey(type: string): Promise<CrawlerApiKey | null> {
  const db = getDb();
  const keys = await db
    .selectFrom('crawler_api_keys')
    .select(['id', 'crawler_type', 'label', 'api_key', 'total_credits', 'used_credits', 'exhausted', 'enabled'])
    .where('crawler_type', '=', type)
    .where('enabled', '=', true)
    .where('exhausted', '=', false)
    .execute();

  if (keys.length === 0) {
    log.info({ type }, '[crawler-keys] No available keys');
    return null;
  }

  const lastIdx = lastUsedIndex.get(type) ?? -1;
  const nextIdx = (lastIdx + 1) % keys.length;
  lastUsedIndex.set(type, nextIdx);

  return keys[nextIdx] as CrawlerApiKey;
}

/**
 * Atomically add usage credits to a key.
 */
export async function addKeyUsage(keyId: number, credits: number): Promise<void> {
  const db = getDb();
  await db
    .updateTable('crawler_api_keys')
    .set({
      used_credits: sql`used_credits + ${credits}`,
      updated_at: sql`NOW()`,
    } as any)
    .where('id', '=', keyId)
    .execute();
}

/**
 * Mark a key as exhausted (e.g., received 402 from API).
 */
export async function markKeyExhausted(keyId: number): Promise<void> {
  const db = getDb();
  await db
    .updateTable('crawler_api_keys')
    .set({ exhausted: true, updated_at: sql`NOW()` } as any)
    .where('id', '=', keyId)
    .execute();
  log.warn({ keyId }, '[crawler-keys] Key marked as exhausted');
}

/**
 * Get all crawler keys, optionally filtered by type. For admin UI.
 */
export async function getCrawlerKeys(type?: string): Promise<CrawlerApiKey[]> {
  const db = getDb();
  let query = db
    .selectFrom('crawler_api_keys')
    .select(['id', 'crawler_type', 'label', 'api_key', 'total_credits', 'used_credits', 'exhausted', 'enabled'])
    .orderBy('id', 'asc');

  if (type) {
    query = query.where('crawler_type', '=', type);
  }

  return (await query.execute()) as CrawlerApiKey[];
}
