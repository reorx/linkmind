/**
 * Check link status.
 * Usage: npx tsx src/check-link.ts <linkId>
 */
import 'dotenv/config';
import { getLink } from './db.js';

const linkId = parseInt(process.argv[2], 10);
if (!linkId || isNaN(linkId)) {
  console.error('Usage: npx tsx src/check-link.ts <linkId>');
  process.exit(1);
}

async function main() {
  const link = await getLink(linkId);
  if (!link) {
    console.error(`Link #${linkId} not found`);
    process.exit(1);
  }
  
  console.log('Status:', link.status);
  console.log('Title:', link.og_title);
  console.log('Summary:', link.summary?.slice(0, 100) + '...');
  console.log('Related Links:', link.related_links);
  console.log('Summary Embedding:', link.summary_embedding ? `exists (${JSON.parse(link.summary_embedding).length} dims)` : 'missing');
  console.log('Insight:', link.insight?.slice(0, 100) + '...');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
