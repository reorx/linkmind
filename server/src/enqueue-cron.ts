/**
 * Cron job to process enqueued links.
 * Runs every minute, picks up to `perUser` enqueued links per user,
 * and spawns the pipeline for each.
 */

import { getEnqueuedLinks, updateLink } from './db.js';
import { spawnProcessLink } from './pipeline.js';
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
      const links = await getEnqueuedLinks(limit);
      if (links.length === 0) return;

      log.info({ count: links.length }, 'Processing enqueued links');

      for (const link of links) {
        try {
          // Update status to pending before spawning
          await updateLink(link.id!, { status: 'pending' });
          await spawnProcessLink(link.user_id, link.url, link.id!);
          log.info({ linkId: link.id, url: link.url, userId: link.user_id }, 'Spawned enqueued link');
        } catch (err) {
          log.error(
            { linkId: link.id, err: err instanceof Error ? err.message : String(err) },
            'Failed to spawn enqueued link',
          );
        }
      }
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Enqueue cron tick failed');
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
