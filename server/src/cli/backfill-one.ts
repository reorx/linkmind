/**
 * Backfill a single link by ID.
 * Usage: npx tsx src/backfill-one.ts <linkId>
 */
import { getRecord } from '../db/index.js';
import { registerTasks, spawnProcessLink } from '../pipeline.js';
import { initLogger } from '../logger.js';

initLogger();
registerTasks();

const linkId = parseInt(process.argv[2], 10);
if (!linkId || isNaN(linkId)) {
  console.error('Usage: npx tsx src/backfill-one.ts <linkId>');
  process.exit(1);
}

async function main() {
  const link = await getRecord(linkId);
  if (!link) {
    console.error(`Link #${linkId} not found`);
    process.exit(1);
  }

  console.log(`📦 Backfilling link #${linkId}: ${link.og_title || link.url}`);

  // Spawn task (pipeline will reset status to pending)
  const { taskId } = await spawnProcessLink(link.user_id, link.url!, linkId);
  console.log(`✅ Spawned task: ${taskId}`);
  console.log(`\n🔗 View result at: https://linkmind.reorx.com/link/${linkId}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
