/**
 * Backfill embeddings for existing links that don't have them.
 * Run: npx tsx scripts/backfill-embeddings.ts
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { getDb, type LinkRecord } from '../src/db.js';
import { createEmbedding } from '../src/llm.js';

/**
 * Build text content for embedding from a link record.
 */
function buildEmbeddingText(link: LinkRecord): string {
  const parts: string[] = [];

  if (link.og_title) {
    parts.push(`标题: ${link.og_title}`);
  }
  if (link.og_description) {
    parts.push(`描述: ${link.og_description}`);
  }
  if (link.summary) {
    parts.push(`摘要: ${link.summary}`);
  }
  if (link.markdown) {
    const maxMarkdownLength = 6000;
    const markdown =
      link.markdown.length > maxMarkdownLength ? link.markdown.slice(0, maxMarkdownLength) + '...' : link.markdown;
    parts.push(`正文: ${markdown}`);
  }

  return parts.join('\n\n');
}

async function main() {
  const db = getDb();

  // Get all analyzed links without embeddings
  const links = await db
    .selectFrom('links')
    .selectAll()
    .where('status', '=', 'analyzed')
    .where('embedding', 'is', null)
    .execute();

  console.log(`Found ${links.length} links without embeddings`);

  let success = 0;
  let failed = 0;

  for (const link of links) {
    try {
      const text = buildEmbeddingText(link as LinkRecord);
      console.log(`[${link.id}] Generating embedding for: ${link.og_title?.slice(0, 50)}...`);

      const embedding = await createEmbedding(text);
      const vectorStr = `[${embedding.join(',')}]`;

      await db
        .updateTable('links')
        .set({ embedding: vectorStr } as any)
        .where('id', '=', link.id!)
        .execute();

      console.log(`[${link.id}] ✅ Done (${embedding.length} dimensions)`);
      success++;

      // Rate limit: wait 200ms between requests
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.error(`[${link.id}] ❌ Failed:`, err instanceof Error ? err.message : err);
      failed++;
    }
  }

  console.log(`\nBackfill complete: ${success} success, ${failed} failed`);
  process.exit(0);
}

main().catch(console.error);
