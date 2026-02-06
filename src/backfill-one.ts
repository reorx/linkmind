/**
 * Backfill a single link by ID.
 * Usage: npx tsx src/backfill-one.ts <linkId>
 */
import 'dotenv/config';
import { Absurd } from 'absurd-sdk';
import { getLink, updateLink } from './db.js';
import { initLogger } from './logger.js';

initLogger();

// Spawn task directly to the queue (worker will pick it up)
async function spawnTask(userId: number, url: string, linkId: number): Promise<string> {
  const absurd = new Absurd({
    db: process.env.DATABASE_URL!,
    queueName: 'linkmind',
  });
  
  const result = await absurd.spawn('process-link', { userId, url, linkId }, {
    queue: 'linkmind',
    maxAttempts: 3,
    retryStrategy: { kind: 'exponential', baseSeconds: 10, factor: 2, maxSeconds: 300 },
  });
  
  return result.taskID;
}

const linkId = parseInt(process.argv[2], 10);
if (!linkId || isNaN(linkId)) {
  console.error('Usage: npx tsx src/backfill-one.ts <linkId>');
  process.exit(1);
}

async function main() {
  const link = await getLink(linkId);
  if (!link) {
    console.error(`Link #${linkId} not found`);
    process.exit(1);
  }

  console.log(`📦 Backfilling link #${linkId}: ${link.og_title || link.url}`);
  
  // Reset status
  await updateLink(linkId, { status: 'pending', error_message: undefined });
  
  // Spawn task
  const taskId = await spawnTask(link.user_id, link.url, linkId);
  console.log(`✅ Spawned task: ${taskId}`);
  console.log(`\n🔗 View result at: https://linkmind.reorx.com/link/${linkId}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
