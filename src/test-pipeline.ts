/**
 * Integration test: full pipeline (scrape → analyze → export) via Absurd.
 *
 * Starts the Absurd worker in-process, spawns a process-link task,
 * polls until completion. Tests both new link creation and upsert
 * (re-processing an existing URL).
 *
 * Usage:
 *   npx tsx src/test-pipeline.ts <url>
 *   npx tsx src/test-pipeline.ts https://example.com/article
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { initLogger } from './logger.js';
initLogger();

import { startWorker, spawnProcessLink } from './pipeline.js';
import { getLink, getLinkByUrl } from './db.js';

const url = process.argv[2];
if (!url) {
  console.error('Usage: npx tsx src/test-pipeline.ts <url>');
  process.exit(1);
}

const TEST_USER_ID = 1;
const POLL_INTERVAL_MS = 1000;
const TIMEOUT_MS = 120_000; // 2 min max

interface RunResult {
  linkId: number;
  title: string;
  summary: string;
  tags: string;
  status: string;
}

/**
 * Spawn a process-link task and poll until terminal state.
 */
async function runPipelineAndWait(label: string): Promise<RunResult | null> {
  console.log(`\n━━━ ${label} ━━━\n`);

  // Check if URL already exists
  const existing = await getLinkByUrl(TEST_USER_ID, url);
  if (existing?.id) {
    console.log(`📎 URL already exists as link #${existing.id} (status: ${existing.status})`);
  } else {
    console.log('📎 URL is new, will create link record');
  }

  // Spawn task
  console.log('⏳ Spawning process-link task...');
  const { taskId } = await spawnProcessLink(TEST_USER_ID, url, existing?.id);
  console.log(`✅ Task spawned: ${taskId}\n`);

  // Poll for completion
  const startTime = Date.now();
  let linkId: number | null = existing?.id ?? null;
  let lastStatus = '';

  while (Date.now() - startTime < TIMEOUT_MS) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Wait for link record to appear
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
      return null;
    }

    if (current.status !== lastStatus) {
      console.log(`  [${elapsed}s] status: ${lastStatus || '(init)'} → ${current.status}`);
      lastStatus = current.status!;
    }

    if (current.status === 'analyzed') {
      console.log(`\n✅ Pipeline completed in ${elapsed}s`);
      return {
        linkId: current.id!,
        title: current.og_title || url,
        summary: current.summary || '',
        tags: current.tags || '[]',
        status: current.status,
      };
    }

    if (current.status === 'error') {
      console.error(`\n❌ Pipeline failed after ${elapsed}s`);
      console.error(`  Error: ${current.error_message}`);
      return null;
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  console.error(`\n❌ Timed out after ${TIMEOUT_MS / 1000}s`);
  return null;
}

async function main() {
  console.log('\n━━━ PIPELINE INTEGRATION TEST ━━━');
  console.log(`URL: ${url}`);
  console.log(`User ID: ${TEST_USER_ID}`);

  // Start worker
  console.log('\n⏳ Starting Absurd worker...');
  await startWorker();
  console.log('✅ Worker started');

  // ── Pass 1: process the URL ──
  const result1 = await runPipelineAndWait('PASS 1: Process URL');
  if (!result1) {
    console.error('\n🛑 Pass 1 failed, aborting.');
    process.exit(1);
  }

  console.log('\n  📄 RESULT:');
  console.log(`    ID:      ${result1.linkId}`);
  console.log(`    Title:   ${result1.title}`);
  console.log(`    Tags:    ${result1.tags}`);
  console.log(`    Summary: ${result1.summary.slice(0, 200)}`);

  // ── Pass 2: re-process same URL (upsert) ──
  const result2 = await runPipelineAndWait('PASS 2: Re-process same URL (upsert)');
  if (!result2) {
    console.error('\n🛑 Pass 2 failed, aborting.');
    process.exit(1);
  }

  console.log('\n  📄 RESULT:');
  console.log(`    ID:      ${result2.linkId}`);
  console.log(`    Title:   ${result2.title}`);
  console.log(`    Tags:    ${result2.tags}`);
  console.log(`    Summary: ${result2.summary.slice(0, 200)}`);

  // ── Verify idempotency ──
  console.log('\n━━━ IDEMPOTENCY CHECK ━━━\n');

  const sameId = result1.linkId === result2.linkId;
  console.log(`  Same link ID:  ${sameId ? '✅' : '❌'} (${result1.linkId} vs ${result2.linkId})`);

  if (sameId) {
    console.log('\n  ✅ Pipeline is idempotent — same URL produces same record, updated in place.');
  } else {
    console.error('\n  ❌ IDEMPOTENCY VIOLATION — duplicate records created!');
    process.exit(1);
  }

  console.log('\n━━━ ALL TESTS PASSED ━━━\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
