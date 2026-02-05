/**
 * Test hybrid search combining BM25 + vector.
 * Run: npx tsx scripts/test-hybrid-search.ts "your search query"
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { hybridSearch } from '../src/search.js';

async function main() {
  const query = process.argv[2] || 'AI agent';
  const userId = 1; // Default user

  console.log(`\n🔍 Hybrid Search: "${query}"\n`);

  const results = await hybridSearch(query, userId, 5);

  console.log('Top 5 results (RRF fusion of BM25 + Vector):\n');
  results.forEach((r, i) => {
    const bm25 = r.bm25Rank ? `BM25:#${r.bm25Rank}` : 'BM25:—';
    const vector = r.vectorRank ? `Vec:#${r.vectorRank}` : 'Vec:—';
    console.log(`${i + 1}. [${r.id}] ${r.title?.slice(0, 55)}...`);
    console.log(`   ${bm25} | ${vector} | RRF: ${r.rrfScore.toFixed(4)}`);
    console.log(`   ${r.url}\n`);
  });

  process.exit(0);
}

main().catch(console.error);
