/**
 * Backfill: re-process all analyzed links through the new pipeline.
 * 
 * Usage:
 *   npx tsx src/backfill-all.ts           # backfill all
 *   npx tsx src/backfill-all.ts --dry-run # show what would be done
 */
import 'dotenv/config';
import { getAllAnalyzedLinks, updateLink } from './db.js';
import { spawnProcessLink } from './pipeline.js';
import { initLogger } from './logger.js';

initLogger();

const dryRun = process.argv.includes('--dry-run');

async function main() {
  console.log('📦 Fetching all analyzed links...');
  const links = await getAllAnalyzedLinks();
  console.log(`Found ${links.length} links to backfill\n`);

  if (dryRun) {
    console.log('🔍 DRY RUN - would process:');
    for (const link of links) {
      console.log(`  #${link.id} ${link.og_title?.slice(0, 50) || link.url}`);
    }
    console.log(`\nRun without --dry-run to actually backfill.`);
    return;
  }

  console.log('🚀 Spawning backfill tasks...\n');
  
  for (const link of links) {
    const title = link.og_title?.slice(0, 50) || link.url;
    try {
      // Reset status to pending
      await updateLink(link.id!, { status: 'pending', error_message: undefined });
      
      // Spawn the task
      const { taskId } = await spawnProcessLink(link.user_id, link.url, link.id);
      console.log(`✅ #${link.id} ${title} → task ${taskId}`);
    } catch (err) {
      console.error(`❌ #${link.id} ${title} → ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\n📋 Spawned ${links.length} tasks. Worker will process them.`);
  console.log('Monitor progress with: tail -f data/linkmind.log | pino-pretty');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
