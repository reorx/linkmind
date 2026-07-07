/**
 * Decoupled notification channel: pipeline / cron code notifies Telegram users
 * without importing bot.ts (which would create a circular dependency).
 *
 * bot.ts registers the actual sender via setNotifier() at startup.
 */

import { getRecord, getRelatedRecords } from './db/index.js';
import { formatResultTelegram, type RelatedRecordInfo } from './telegram-render.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'notify' });

export interface NotifyOptions {
  recordUrl?: string; // adds a "查看详情" button
  html?: boolean; // text is Telegram HTML (default: plain text)
}

export type Notifier = (chatId: number, text: string, opts?: NotifyOptions) => Promise<void>;

let notifier: Notifier | null = null;

export function setNotifier(fn: Notifier | null): void {
  notifier = fn;
}

/**
 * Send a message to a Telegram chat via the registered notifier.
 * Logs and drops the message when no notifier is registered; never throws.
 */
export async function notifyUser(chatId: number, text: string, opts?: NotifyOptions): Promise<void> {
  if (!notifier) {
    log.warn({ chatId }, 'Notifier not registered, notification dropped');
    return;
  }
  try {
    await notifier(chatId, text, opts);
  } catch (err) {
    log.error({ chatId, err: err instanceof Error ? err.message : String(err) }, 'notifyUser failed');
  }
}

export function getWebBaseUrl(): string {
  const webPort = parseInt(process.env.WEB_PORT ?? '3456', 10);
  return process.env.WEB_BASE_URL ?? `http://localhost:${webPort}`;
}

function safeParseJson(s?: string): any[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Fetch related records from record_relations table with their details.
 */
export async function fetchRelatedRecordsInfo(recordId: number, webBaseUrl: string): Promise<RelatedRecordInfo[]> {
  const relatedData = await getRelatedRecords(recordId);
  const results: RelatedRecordInfo[] = [];

  for (const item of relatedData) {
    const related = await getRecord(item.relatedRecordId);
    if (related) {
      results.push({
        recordId: item.relatedRecordId,
        title: related.og_title || related.url || related.summary || 'Untitled',
        sourceUrl: related.url || '',
        internalUrl: `${webBaseUrl}/link/${item.relatedRecordId}`,
      });
    }
  }

  return results;
}

/**
 * Notify the record's Telegram chat that processing has completed,
 * with the same result message format the bot polling uses.
 * No-op when the record has no telegram_chat_id.
 */
export async function notifyRecordProcessed(recordId: number): Promise<void> {
  const record = await getRecord(recordId);
  if (!record?.telegram_chat_id) return;

  const webBaseUrl = getWebBaseUrl();
  const permanentLink = `${webBaseUrl}/link/${recordId}`;
  const relatedRecords = await fetchRelatedRecordsInfo(recordId, webBaseUrl);

  const text = formatResultTelegram({
    title: record.og_title || record.url || '',
    url: record.url || '',
    summary: record.summary || '',
    insight: record.insight || '',
    tags: safeParseJson(record.tags),
    relatedNotes: safeParseJson(record.related_notes),
    relatedRecords,
    permanentLink,
  });

  await notifyUser(Number(record.telegram_chat_id), text, { recordUrl: permanentLink, html: true });
  log.info({ recordId, chatId: record.telegram_chat_id }, 'Record processed notification sent');
}
