/**
 * Hybrid search combining BM25 (full-text) and vector similarity search.
 * Uses Reciprocal Rank Fusion (RRF) for combining results.
 */

import { sql } from 'kysely';
import { getDb, type LinkRecord } from './db.js';
import { createEmbedding } from './llm.js';
import { logger as log } from './logger.js';

export interface SearchResult {
  id: number;
  url: string;
  title: string | null;
  summary: string | null;
  bm25Rank: number | null;
  vectorRank: number | null;
  rrfScore: number;
}

interface RankedResult {
  id: number;
  url: string;
  og_title: string | null;
  summary: string | null;
  rank: number;
}

const RRF_K = 60; // RRF constant, typically 60

/**
 * Perform hybrid search combining BM25 and vector similarity.
 * @param query - Search query string
 * @param userId - User ID to scope search
 * @param limit - Maximum number of results to return (default 5)
 */
export async function hybridSearch(query: string, userId: number, limit: number = 5): Promise<SearchResult[]> {
  const db = getDb();

  log.info({ query, userId, limit }, '[search] Starting hybrid search');

  // Run BM25 and vector searches in parallel
  const [bm25Results, vectorResults] = await Promise.all([
    searchBM25(query, userId, limit * 2),
    searchVector(query, userId, limit * 2),
  ]);

  log.info(
    { bm25Count: bm25Results.length, vectorCount: vectorResults.length },
    '[search] Got results from both methods',
  );

  // Build lookup maps for ranks
  const bm25Ranks = new Map<number, number>();
  bm25Results.forEach((r, i) => bm25Ranks.set(r.id, i + 1));

  const vectorRanks = new Map<number, number>();
  vectorResults.forEach((r, i) => vectorRanks.set(r.id, i + 1));

  // Collect all unique IDs
  const allIds = new Set<number>([...bm25Results.map((r) => r.id), ...vectorResults.map((r) => r.id)]);

  // Calculate RRF scores
  const scoredResults: SearchResult[] = [];
  const resultsById = new Map<number, RankedResult>();

  // Build lookup for result details
  for (const r of [...bm25Results, ...vectorResults]) {
    if (!resultsById.has(r.id)) {
      resultsById.set(r.id, r);
    }
  }

  for (const id of allIds) {
    const bm25Rank = bm25Ranks.get(id) ?? null;
    const vectorRank = vectorRanks.get(id) ?? null;

    // RRF score: sum of 1/(k + rank) for each method where result appears
    let rrfScore = 0;
    if (bm25Rank !== null) {
      rrfScore += 1 / (RRF_K + bm25Rank);
    }
    if (vectorRank !== null) {
      rrfScore += 1 / (RRF_K + vectorRank);
    }

    const result = resultsById.get(id)!;
    scoredResults.push({
      id,
      url: result.url,
      title: result.og_title,
      summary: result.summary,
      bm25Rank,
      vectorRank,
      rrfScore,
    });
  }

  // Sort by RRF score (descending) and take top K
  scoredResults.sort((a, b) => b.rrfScore - a.rrfScore);
  const topResults = scoredResults.slice(0, limit);

  log.info({ resultCount: topResults.length }, '[search] Hybrid search complete');

  return topResults;
}

/**
 * BM25 full-text search using pg_search.
 */
async function searchBM25(query: string, userId: number, limit: number): Promise<RankedResult[]> {
  const db = getDb();

  try {
    // Use pg_search's score_bm25 for ranking
    const results = await db
      .selectFrom('links')
      .select(['id', 'url', 'og_title', 'summary'])
      .select(sql<number>`paradedb.score(id)`.as('score'))
      .where('user_id', '=', userId)
      .where('status', '=', 'analyzed')
      .where(sql`id @@@ paradedb.parse(${query})`)
      .orderBy(sql`paradedb.score(id)`, 'desc')
      .limit(limit)
      .execute();

    return results.map((r, i) => ({
      id: r.id!,
      url: r.url,
      og_title: r.og_title ?? null,
      summary: r.summary ?? null,
      rank: i + 1,
    }));
  } catch (err) {
    log.warn({ err }, '[search] BM25 search failed, returning empty');
    return [];
  }
}

/**
 * Vector similarity search using pgvector.
 */
async function searchVector(query: string, userId: number, limit: number): Promise<RankedResult[]> {
  const db = getDb();

  try {
    // Generate query embedding
    const queryEmbedding = await createEmbedding(query);
    const vectorStr = `[${queryEmbedding.join(',')}]`;

    // Cosine distance search (lower distance = more similar)
    const results = await db
      .selectFrom('links')
      .select(['id', 'url', 'og_title', 'summary'])
      .select(sql<number>`embedding <=> ${vectorStr}::vector`.as('distance'))
      .where('user_id', '=', userId)
      .where('status', '=', 'analyzed')
      .where('embedding', 'is not', null)
      .orderBy(sql`embedding <=> ${vectorStr}::vector`)
      .limit(limit)
      .execute();

    return results.map((r, i) => ({
      id: r.id!,
      url: r.url,
      og_title: r.og_title ?? null,
      summary: r.summary ?? null,
      rank: i + 1,
    }));
  } catch (err) {
    log.warn({ err }, '[search] Vector search failed, returning empty');
    return [];
  }
}
