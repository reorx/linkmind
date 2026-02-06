/**
 * Backfill: re-process all analyzed links through the new pipeline.
 *
 * Usage:
 *   npx tsx src/backfill-all.ts              # backfill all (concurrency=3)
 *   npx tsx src/backfill-all.ts -c 5         # custom concurrency
 *   npx tsx src/backfill-all.ts --dry-run    # show what would be done
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { getAllAnalyzedLinks, updateLink } from './db.js';
import { registerTasks, spawnProcessLink } from './pipeline.js';
import { initLogger } from './logger.js';

initLogger();
registerTasks();

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const concurrencyIdx = args.indexOf('-c');
const concurrency = concurrencyIdx !== -1 ? parseInt(args[concurrencyIdx + 1], 10) : 3;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

interface TaskInfo {
  linkId: number;
  title: string;
  taskId: string;
}

/**
 * Check task states from Absurd's task table.
 * Returns map of taskId → state
 */
async function getTaskStates(taskIds: string[]): Promise<Map<string, string>> {
  if (taskIds.length === 0) return new Map();

  const result = await pool.query<{ task_id: string; state: string }>(
    `SELECT task_id::text, state FROM absurd.t_linkmind WHERE task_id = ANY($1::uuid[])`,
    [taskIds],
  );

  return new Map(result.rows.map((r) => [r.task_id, r.state]));
}

/**
 * Wait for all tasks to reach terminal state (completed/failed/cancelled).
 */
async function waitForTasks(tasks: TaskInfo[]): Promise<void> {
  const terminalStates = ['completed', 'failed', 'cancelled'];
  const taskIds = tasks.map((t) => t.taskId);

  while (true) {
    const states = await getTaskStates(taskIds);

    let allDone = true;
    for (const task of tasks) {
      const state = states.get(task.taskId) || 'unknown';
      if (!terminalStates.includes(state)) {
        allDone = false;
      }
    }

    if (allDone) {
      // Print final states
      for (const task of tasks) {
        const state = states.get(task.taskId) || 'unknown';
        const icon = state === 'completed' ? '✅' : state === 'failed' ? '❌' : '⚠️';
        console.log(`  ${icon} #${task.linkId} ${task.title.slice(0, 40)} → ${state}`);
      }
      break;
    }

    // Poll every 2 seconds
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function main() {
  console.log('📦 Fetching all analyzed links...');
  const links = await getAllAnalyzedLinks();
  console.log(`Found ${links.length} links to backfill (concurrency: ${concurrency})\n`);

  if (dryRun) {
    console.log('🔍 DRY RUN - would process:');
    for (const link of links) {
      console.log(`  #${link.id} ${link.og_title?.slice(0, 50) || link.url}`);
    }
    console.log(`\nRun without --dry-run to actually backfill.`);
    return;
  }

  console.log('🚀 Starting backfill...\n');

  // Process in batches
  for (let i = 0; i < links.length; i += concurrency) {
    const batch = links.slice(i, i + concurrency);
    const batchNum = Math.floor(i / concurrency) + 1;
    const totalBatches = Math.ceil(links.length / concurrency);

    console.log(`\n📋 Batch ${batchNum}/${totalBatches}`);

    // Spawn tasks for this batch
    const tasks: TaskInfo[] = [];
    for (const link of batch) {
      const title = link.og_title || link.url;
      try {
        // Reset status to pending
        await updateLink(link.id!, { status: 'pending', error_message: undefined });

        // Spawn the task
        const { taskId } = await spawnProcessLink(link.user_id, link.url, link.id);
        tasks.push({ linkId: link.id!, title, taskId });
        console.log(`  ⏳ #${link.id} ${title.slice(0, 40)} → spawned`);
      } catch (err) {
        console.error(`  ❌ #${link.id} ${title.slice(0, 40)} → spawn failed: ${err}`);
      }
    }

    // Wait for all tasks in this batch to complete
    if (tasks.length > 0) {
      console.log(`  ⏳ Waiting for ${tasks.length} tasks...`);
      await waitForTasks(tasks);
    }
  }

  console.log(`\n✨ Backfill complete!`);
  await pool.end();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
