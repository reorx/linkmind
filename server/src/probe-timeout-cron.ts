/**
 * Cron job to expire probe events that have waited too long.
 *
 * Every 10 minutes: probe_events in (pending, sent) older than PROBE_WAIT_TTL_HOURS
 * are marked `expired`; their records (if still waiting_probe) are marked `error`
 * and the user is notified via the notify channel.
 */

import { getExpiredProbeEvents, updateProbeEventStatus, getRecord, updateRecord } from './db/index.js';
import { notifyUser, getWebBaseUrl } from './notify.js';
import { Sentry } from './sentry.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'probe-timeout-cron' });

const DEFAULT_TTL_HOURS = 24;
const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

let timer: ReturnType<typeof setInterval> | null = null;

export function getProbeWaitTtlHours(): number {
  const v = parseFloat(process.env.PROBE_WAIT_TTL_HOURS ?? '');
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_HOURS;
}

/**
 * One sweep round. Returns the number of events expired.
 */
export async function sweepExpiredProbeEvents(ttlHours: number = getProbeWaitTtlHours()): Promise<number> {
  const events = await getExpiredProbeEvents(ttlHours);
  if (events.length === 0) return 0;

  log.info({ count: events.length, ttlHours }, 'Expiring probe events past TTL');

  for (const event of events) {
    await updateProbeEventStatus(event.id, 'expired');

    if (!event.link_id) continue;
    const record = await getRecord(event.link_id);
    // Record already moved on (probe replied earlier / re-processed) — only expire the event
    if (!record || record.status !== 'waiting_probe') continue;

    await updateRecord(event.link_id, {
      status: 'error',
      error_message: `等待本地 Probe 抓取超时（${ttlHours}h），请确认 probe 已安装并在线后重试`,
    });
    log.info({ eventId: event.id, recordId: event.link_id, url: event.url }, 'Record marked error (probe timeout)');

    if (record.telegram_chat_id) {
      const recordUrl = `${getWebBaseUrl()}/link/${event.link_id}`;
      await notifyUser(
        Number(record.telegram_chat_id),
        `⏰ 链接等待 Probe 抓取超时，已标记失败：${event.url}\n安装/启动 probe 后可在详情页 Rerun`,
        { recordUrl },
      );
    }
  }

  return events.length;
}

export function startProbeTimeoutCron(): void {
  log.info({ ttlHours: getProbeWaitTtlHours(), intervalMs: INTERVAL_MS }, 'Probe timeout cron started');

  timer = setInterval(async () => {
    try {
      await sweepExpiredProbeEvents();
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Probe timeout cron tick failed');
      Sentry.captureException(err, { tags: { source: 'probe-timeout-cron' } });
    }
  }, INTERVAL_MS);
}

export function stopProbeTimeoutCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info('Probe timeout cron stopped');
  }
}
