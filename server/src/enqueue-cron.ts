/**
 * Cron job to process enqueued links.
 * Runs every minute, picks up to `perUser` enqueued links per user,
 * and spawns the pipeline for each.
 */

import { getEnqueuedRecords, updateRecord } from './db.js';
import { spawnProcessLink } from './pipeline.js';
import { Sentry } from './sentry.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'enqueue-cron' });

const DEFAULT_PER_USER = 2;
const INTERVAL_MS = 60 * 1000; // 1 minute

let timer: ReturnType<typeof setInterval> | null = null;

export function startEnqueueCron(perUser?: number): void {
  const limit = perUser ?? parseInt(process.env.ENQUEUE_PER_USER ?? String(DEFAULT_PER_USER), 10);

  log.info({ perUser: limit, intervalMs: INTERVAL_MS }, 'Enqueue cron started');

  timer = setInterval(async () => {
    try {
      const records = await getEnqueuedRecords(limit);
      if (records.length === 0) return;

      log.info({ count: records.length }, 'Processing enqueued records');

      for (const record of records) {
        try {
          // Update status to pending before spawning
          await updateRecord(record.id!, { status: 'pending' });
          await spawnProcessLink(record.user_id, record.url!, record.id!);
          log.info({ recordId: record.id, url: record.url, userId: record.user_id }, 'Spawned enqueued record');
        } catch (err) {
          log.error(
            { recordId: record.id, err: err instanceof Error ? err.message : String(err) },
            'Failed to spawn enqueued record',
          );
        }
      }
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Enqueue cron tick failed');
      Sentry.captureException(err, { tags: { source: 'enqueue-cron' } });
    }
  }, INTERVAL_MS);
}

export function stopEnqueueCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info('Enqueue cron stopped');
  }
}
