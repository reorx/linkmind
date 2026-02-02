/**
 * Backfill: export all analyzed links as Markdown files.
 */

import 'dotenv/config';
import { getAllAnalyzedLinks } from './db.js';
import { exportAllLinks } from './export.js';

async function main() {
  const links = await getAllAnalyzedLinks();
  console.log(`Found ${links.length} analyzed links`);
  const paths = exportAllLinks(links);
  console.log(`Done. Exported ${paths.length} files.`);
}

main();
