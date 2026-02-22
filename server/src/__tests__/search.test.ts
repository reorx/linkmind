/**
 * Integration test: hybrid search (BM25 + vector + RRF fusion).
 *
 * Uses REAL embedding API calls (DashScope) and the actual database
 * (local PostgreSQL or Neon) with pgvector + ParadeDB pg_search.
 *
 * Strategy: creates a dedicated test user, inserts test records,
 * runs tests scoped to that user, then cleans up everything in afterAll.
 *
 * Test samples:
 *   - Sample A: contains exact keyword "量子计算", strong BM25 match
 *   - Sample B: semantically related but does NOT contain "量子计算", vector-only
 *   - Sample C: contains "量子计算" AND semantically rich, both BM25 and vector
 *   - Sample D: completely unrelated (cooking), control sample
 *
 * Usage:
 *   npx vitest run src/test-search.ts
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { initLogger } from '../logger.js';
initLogger();

import { getDb, insertRecord, updateRecord } from '../db/index.js';
import { createEmbedding } from '../llm.js';
import { hybridSearch, searchRelatedRecords } from '../search.js';

// Unique telegram ID for test user — high enough to avoid collision
const TEST_TELEGRAM_ID = 777_777_777;

/* ── Test Data ── */

interface TestSample {
  label: string;
  url: string;
  og_title: string;
  summary: string;
  markdown: string;
}

const SAMPLE_A: TestSample = {
  label: 'A (BM25-strong)',
  url: 'https://test.example.com/quantum-computing-intro',
  og_title: '量子计算入门：从量子比特到量子霸权',
  summary:
    '量子计算是利用量子力学原理进行信息处理的计算方式。量子比特（qubit）可以同时处于 0 和 1 的叠加态，' +
    '使得量子计算机在特定问题上具有指数级加速能力。量子计算的主要应用包括密码学、药物发现和优化问题。',
  markdown:
    '# 量子计算入门\n\n量子计算利用量子力学的叠加和纠缠原理，实现传统计算机无法企及的计算能力。' +
    '量子比特是量子计算的基本单元，与经典比特不同，它可以同时表示多个状态。',
};

const SAMPLE_B: TestSample = {
  label: 'B (vector-only)',
  url: 'https://test.example.com/superconducting-qubits',
  og_title: 'Superconducting Circuits for Next-Gen Information Processing',
  summary:
    '超导电路作为下一代信息处理的核心技术，利用约瑟夫森结（Josephson junction）实现量子比特的精确操控。' +
    '这些微观系统展现出独特的叠加与纠缠特性，在密码破解、分子模拟和组合优化等领域具有革命性潜力。' +
    '谷歌和 IBM 正在竞相提升超导量子比特的相干时间和门保真度。',
  markdown:
    '# Superconducting Qubits\n\nSuperconducting circuits based on Josephson junctions ' +
    'are the leading platform for scalable information processing using quantum mechanical principles. ' +
    'These systems exploit superposition and entanglement to solve problems intractable for classical processors.',
};

const SAMPLE_C: TestSample = {
  label: 'C (both)',
  url: 'https://test.example.com/quantum-ml',
  og_title: '量子计算与机器学习的交叉前沿',
  summary:
    '量子计算与机器学习的结合正在开辟全新的研究方向。量子神经网络（QNN）利用参数化量子电路实现模型训练，' +
    '在某些数据集上展现出超越经典模型的表达能力。量子核方法（quantum kernel methods）提供了一种在高维希尔伯特空间中计算相似度的新途径。',
  markdown:
    '# 量子计算与机器学习\n\n量子计算为机器学习带来了新的可能性。量子近似优化算法（QAOA）和变分量子本征求解器（VQE）' +
    '正在被用于训练量子机器学习模型。这种交叉领域的研究可能带来计算效率的质的飞跃。',
};

const SAMPLE_D: TestSample = {
  label: 'D (unrelated)',
  url: 'https://test.example.com/sichuan-mapo-tofu',
  og_title: '正宗川味麻婆豆腐的做法',
  summary:
    '麻婆豆腐是川菜的代表菜品，以麻辣鲜香著称。关键在于选用嫩豆腐，配以郫县豆瓣酱、花椒粉和牛肉末，' +
    '大火快炒收汁。正宗做法需要先将豆腐焯水去腥，最后勾薄芡让酱汁均匀包裹每一块豆腐。',
  markdown:
    '# 正宗川味麻婆豆腐\n\n材料：嫩豆腐一块，牛肉末100g，郫县豆瓣酱两大勺，花椒粉适量。' +
    '做法：豆腐切块焯水，锅中爆香牛肉末，加豆瓣酱炒出红油，放入豆腐轻推，勾芡收汁即可。',
};

const ALL_SAMPLES = [SAMPLE_A, SAMPLE_B, SAMPLE_C, SAMPLE_D];

/* ── Setup & Cleanup (uses main database) ── */

async function createTestUser(): Promise<number> {
  const db = getDb();
  // Delete any leftover test user + records from a previous failed run
  await cleanupTestData();

  const result = await db
    .insertInto('users')
    .values({
      telegram_id: TEST_TELEGRAM_ID,
      username: 'search_test_user',
      display_name: 'Search Test User',
      status: 'active',
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return result.id;
}

async function cleanupTestData(): Promise<void> {
  const db = getDb();
  // Find the test user
  const user = await db
    .selectFrom('users')
    .select('id')
    .where('telegram_id', '=', TEST_TELEGRAM_ID)
    .executeTakeFirst();

  if (!user) return;

  // Delete records owned by this user (cascades to record_relations, record_derivations)
  await db.deleteFrom('records').where('user_id', '=', user.id).execute();
  // Delete the test user
  await db.deleteFrom('users').where('id', '=', user.id).execute();
}

async function insertSampleRecords(userId: number): Promise<Map<string, number>> {
  const ids = new Map<string, number>();

  for (const sample of ALL_SAMPLES) {
    const recordId = await insertRecord(userId, {
      type: 'link',
      url: sample.url,
    });

    // Generate real embedding from summary
    const embedding = await createEmbedding(sample.summary);
    const vectorStr = `[${embedding.join(',')}]`;

    await updateRecord(recordId, {
      og_title: sample.og_title,
      summary: sample.summary,
      markdown: sample.markdown,
      status: 'analyzed',
      summary_embedding: vectorStr,
    } as any);

    ids.set(sample.label, recordId);
    console.log(`  ✓ Inserted ${sample.label} (id=${recordId}, embedding dims=${embedding.length})`);
  }

  return ids;
}

/* ── Tests ── */

describe('Hybrid Search Integration', () => {
  let userId: number;
  let sampleIds: Map<string, number>;

  beforeAll(async () => {
    console.log('\n📦 Setting up test data...');
    userId = await createTestUser();
    console.log(`  Test user created (id=${userId})`);

    console.log('📝 Inserting samples with real embeddings...');
    sampleIds = await insertSampleRecords(userId);

    console.log('✅ Setup complete\n');
  }, 120_000);

  afterAll(async () => {
    console.log('\n🧹 Cleaning up test data...');
    await cleanupTestData();
    console.log('✅ Cleanup complete');
  });

  it('BM25 should find records with exact keyword "量子计算"', async () => {
    const results = await hybridSearch('量子计算', userId, 10);

    const idA = sampleIds.get('A (BM25-strong)')!;
    const idC = sampleIds.get('C (both)')!;
    const idD = sampleIds.get('D (unrelated)')!;

    // A and C contain "量子计算" → should have bm25Rank and rank higher
    const resultA = results.find((r) => r.id === idA);
    const resultC = results.find((r) => r.id === idC);
    expect(resultA, 'Sample A should be in results').toBeDefined();
    expect(resultC, 'Sample C should be in results').toBeDefined();
    expect(resultA!.bm25Rank, 'Sample A should have bm25Rank').not.toBeNull();
    expect(resultC!.bm25Rank, 'Sample C should have bm25Rank').not.toBeNull();

    // D (cooking) should have lower RRF score than quantum-related records
    const resultD = results.find((r) => r.id === idD);
    if (resultD) {
      expect(resultD.rrfScore).toBeLessThan(resultA!.rrfScore);
      expect(resultD.rrfScore).toBeLessThan(resultC!.rrfScore);
    }
  }, 30_000);

  it('Vector search should find semantically related records without exact keyword', async () => {
    const results = await hybridSearch('量子计算', userId, 10);

    const idB = sampleIds.get('B (vector-only)')!;

    // B is semantically about quantum computing but lacks the exact phrase
    const resultB = results.find((r) => r.id === idB);
    expect(resultB, 'Sample B should be in results via vector search').toBeDefined();
    expect(resultB!.vectorRank, 'Sample B should have vectorRank').not.toBeNull();
  }, 30_000);

  it('Hybrid search should rank dual-match records higher', async () => {
    const results = await hybridSearch('量子计算', userId, 10);

    const idA = sampleIds.get('A (BM25-strong)')!;
    const idC = sampleIds.get('C (both)')!;
    const idD = sampleIds.get('D (unrelated)')!;

    // C has both keyword + semantic relevance → should have both ranks
    const resultC = results.find((r) => r.id === idC);
    expect(resultC!.bm25Rank, 'C should have bm25Rank').not.toBeNull();
    expect(resultC!.vectorRank, 'C should have vectorRank').not.toBeNull();

    // A also has both
    const resultA = results.find((r) => r.id === idA);
    expect(resultA!.bm25Rank, 'A should have bm25Rank').not.toBeNull();
    expect(resultA!.vectorRank, 'A should have vectorRank').not.toBeNull();

    // Records with both ranks should have higher RRF score than single-rank records
    const idB = sampleIds.get('B (vector-only)')!;
    const resultB = results.find((r) => r.id === idB);
    if (resultB) {
      const dualMatchScores = [resultA!.rrfScore, resultC!.rrfScore];
      const minDualScore = Math.min(...dualMatchScores);
      expect(resultB.rrfScore).toBeLessThan(minDualScore);
    }

    // D should have lower RRF score than all quantum-related records
    const resultD = results.find((r) => r.id === idD);
    if (resultD) {
      expect(resultD.rrfScore).toBeLessThan(resultA!.rrfScore);
      expect(resultD.rrfScore).toBeLessThan(resultC!.rrfScore);
    }
  }, 30_000);

  it('Unrelated query should rank matching records highest', async () => {
    const results = await hybridSearch('麻婆豆腐做法', userId, 10);

    const idD = sampleIds.get('D (unrelated)')!;

    // D (cooking) should be found and ranked first (highest RRF score)
    const resultD = results.find((r) => r.id === idD);
    expect(resultD, 'Sample D should be found for cooking query').toBeDefined();
    expect(results[0].id, 'Cooking record should rank #1 for cooking query').toBe(idD);
  }, 30_000);

  it('searchRelatedRecords should find semantically similar records', async () => {
    const idA = sampleIds.get('A (BM25-strong)')!;
    const embeddingA = await createEmbedding(SAMPLE_A.summary);

    const related = await searchRelatedRecords(embeddingA, userId, idA, 5);

    const relatedIds = related.map((r) => r.id);
    const idB = sampleIds.get('B (vector-only)')!;
    const idC = sampleIds.get('C (both)')!;
    const idD = sampleIds.get('D (unrelated)')!;

    expect(relatedIds, 'Should include semantically related B').toContain(idB);
    expect(relatedIds, 'Should include semantically related C').toContain(idC);

    // D should have a lower score than quantum-related records
    const scoreD = related.find((r) => r.id === idD)?.score ?? 0;
    const scoreB = related.find((r) => r.id === idB)?.score ?? 0;
    const scoreC = related.find((r) => r.id === idC)?.score ?? 0;
    expect(Math.max(scoreB, scoreC)).toBeGreaterThan(scoreD);
  }, 30_000);
});
