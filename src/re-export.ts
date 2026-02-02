/**
 * CLI: Re-export all analyzed links to Markdown files.
 * Replaces existing files with the updated format.
 *
 * Usage: tsx src/re-export.ts
 */

import 'dotenv/config';
import { getAllAnalyzedLinks } from './db.js';
import { exportLinkMarkdown } from './export.js';

async function main() {
  const links = await getAllAnalyzedLinks();
  console.log(`Re-exporting ${links.length} analyzed links...\n`);

  let ok = 0;
  let fail = 0;

  for (const link of links) {
    try {
      const path = exportLinkMarkdown(link);
      console.log(`  ✅ #${link.id} ${(link.og_title || link.url).slice(0, 60)} → ${path}`);
      ok++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ #${link.id} ${(link.og_title || link.url).slice(0, 60)} → ${msg}`);
      fail++;
    }
  }

  console.log(`\nDone: ${ok} exported, ${fail} failed`);
}

main();
