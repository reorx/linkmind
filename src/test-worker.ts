/**
 * Minimal integration test: Absurd worker + pipeline.
 *
 * Starts the Absurd worker (no Telegram bot / web server),
 * spawns a process-link task for a given URL, polls the link
 * record until it reaches a terminal state, and prints the result.
 *
 * Usage:
 *   npx tsx src/test-worker.ts <url>
 *   npx tsx src/test-worker.ts https://example.com/article
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { initLogger, logger } from './logger.js';
initLogger();

import { startWorker, spawnProcessLink } from './pipeline.js';
import { getLink, getLinkByUrl } from './db.js';

const url = process.argv[2];
if (!url) {
  console.error('Usage: npx tsx src/test-worker.ts <url>');
  process.exit(1);
}

const TEST_USER_ID = 1;
const POLL_INTERVAL_MS = 1000;
const TIMEOUT_MS = 120_000; // 2 min max

async function main() {
  console.log('\n━━━ ABSURD WORKER INTEGRATION TEST ━━━\n');
  console.log(`URL: ${url}`);
  console.log(`User ID: ${TEST_USER_ID}\n`);

  // 1. Start worker (registers tasks + begins polling)
  console.log('⏳ Starting Absurd worker...');
  await startWorker();
  console.log('✅ Worker started\n');

  // 2. Spawn process-link task
  console.log('⏳ Spawning process-link task...');
  const { taskId } = await spawnProcessLink(TEST_USER_ID, url);
  console.log(`✅ Task spawned: ${taskId}\n`);

  // 3. Poll for link creation + completion
  const startTime = Date.now();
  let linkId: number | null = null;
  let lastStatus = '';

  console.log('⏳ Waiting for task to create link and complete pipeline...\n');

  while (Date.now() - startTime < TIMEOUT_MS) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Wait for the link record to appear
    if (!linkId) {
      const link = await getLinkByUrl(TEST_USER_ID, url);
      if (link?.id) {
        linkId = link.id;
        console.log(`  [${elapsed}s] 📎 Link created: ID=${linkId}`);
      } else {
        process.stdout.write(`  [${elapsed}s] waiting for link record...\r`);
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }
    }

    const current = await getLink(linkId);
    if (!current) {
      console.error('❌ Link record disappeared');
      break;
    }

    if (current.status !== lastStatus) {
      console.log(`  [${elapsed}s] status: ${lastStatus || '(init)'} → ${current.status}`);
      lastStatus = current.status!;
    }

    if (current.status === 'analyzed') {
      console.log(`\n✅ Pipeline completed in ${elapsed}s\n`);
      console.log('━━━ LINK DETAILS ━━━');
      console.log(`  ID:       ${current.id}`);
      console.log(`  Title:    ${current.og_title}`);
      console.log(`  Site:     ${current.og_site_name || '(none)'}`);
      console.log(`  Status:   ${current.status}`);
      console.log(`  Summary:  ${(current.summary || '').slice(0, 300)}`);
      console.log(`  Insight:  ${(current.insight || '').slice(0, 300)}`);
      console.log(`  Tags:     ${current.tags}`);
      break;
    }

    if (current.status === 'error') {
      console.error(`\n❌ Pipeline failed after ${elapsed}s`);
      console.error(`  Error: ${current.error_message}`);
      break;
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (Date.now() - startTime >= TIMEOUT_MS) {
    console.error(`\n❌ Timed out after ${TIMEOUT_MS / 1000}s`);
  }

  console.log('\n━━━ DONE ━━━\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
