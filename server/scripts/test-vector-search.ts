/**
 * Test vector similarity search.
 * Run: npx tsx scripts/test-vector-search.ts "your search query"
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { getDb } from '../src/db.js';
import { createEmbedding } from '../src/llm.js';
import { sql } from 'kysely';

async function main() {
  const query = process.argv[2] || 'AI agent tools';
  console.log(`Searching for: "${query}"\n`);

  // Generate query embedding
  const queryEmbedding = await createEmbedding(query);
  const vectorStr = `[${queryEmbedding.join(',')}]`;

  const db = getDb();

  // Perform cosine similarity search
  const results = await db
    .selectFrom('links')
    .select(['id', 'og_title', 'url'])
    .select(sql<number>`embedding <=> ${vectorStr}::vector`.as('distance'))
    .where('embedding', 'is not', null)
    .orderBy(sql`embedding <=> ${vectorStr}::vector`)
    .limit(5)
    .execute();

  console.log('Top 5 similar links:');
  results.forEach((r, i) => {
    const similarity = 1 - r.distance; // Convert distance to similarity
    console.log(`${i + 1}. [${r.id}] ${r.og_title?.slice(0, 60)}...`);
    console.log(`   Similarity: ${(similarity * 100).toFixed(1)}%`);
    console.log(`   ${r.url}\n`);
  });

  process.exit(0);
}

main().catch(console.error);
