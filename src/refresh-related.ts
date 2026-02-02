/**
 * CLI: Refresh related content for a single link or all links.
 * Usage:
 *   tsx src/refresh-related.ts         # refresh all
 *   tsx src/refresh-related.ts 5       # refresh link #5
 */

import 'dotenv/config';
import { refreshRelated } from './pipeline.js';

async function main() {
  const arg = process.argv[2];
  const linkId = arg ? parseInt(arg, 10) : undefined;

  if (arg && (isNaN(linkId!) || linkId! <= 0)) {
    console.error(`Invalid link ID: ${arg}`);
    process.exit(1);
  }

  console.log(linkId ? `Refreshing related content for link #${linkId}...` : 'Refreshing related content for all links...');

  const results = await refreshRelated(linkId);

  console.log('\n── Results ──');
  for (const r of results) {
    const status = r.error ? `❌ ${r.error}` : `✅ ${r.relatedNotes} notes, ${r.relatedLinks} links`;
    console.log(`  #${r.linkId} ${r.title.slice(0, 60)} → ${status}`);
  }

  const ok = results.filter((r) => !r.error).length;
  const fail = results.filter((r) => r.error).length;
  console.log(`\nDone: ${ok} refreshed, ${fail} failed`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
