/**
 * Integration test: hybrid search (BM25 + vector + RRF fusion).
 *
 * This test uses REAL embedding API calls (DashScope) and a real test database
 * with pgvector + ParadeDB pg_search extensions.
 *
 * Test samples are designed so that:
 *   - Sample A: contains exact keyword "量子计算", strong BM25 match
 *   - Sample B: semantically related (quantum physics concepts) but does NOT contain "量子计算",
 *               only vector search can find it
 *   - Sample C: contains "量子计算" AND is semantically rich, both BM25 and vector match
 *   - Sample D: completely unrelated topic (cooking recipe), should NOT appear
 *
 * Usage:
 *   npx vitest run src/test-search.ts
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

// Override DATABASE_URL to use test database BEFORE any imports that use it
const PROD_DB_URL = process.env.DATABASE_URL!;
const TEST_DB_URL = PROD_DB_URL.replace(/\/[^/]+$/, '/linkmind_search_test');
process.env.DATABASE_URL = TEST_DB_URL;

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

import { initLogger } from './logger.js';
initLogger();

import { insertRecord, updateRecord } from './db.js';
import { createEmbedding } from './llm.js';
import { hybridSearch, searchRelatedRecords } from './search.js';

const TEST_TELEGRAM_ID = 888888;
const TEST_USER_ID_HOLDER = { userId: 0 };

/* ── Test Data ── */

interface TestSample {
  label: string;
  url: string;
  og_title: string;
  summary: string;
  markdown: string;
}

// Sample A: BM25-strong — contains exact keyword "量子计算" prominently
const SAMPLE_A: TestSample = {
  label: 'A (BM25-strong)',
  url: 'https://example.com/quantum-computing-intro',
  og_title: '量子计算入门：从量子比特到量子霸权',
  summary:
    '量子计算是利用量子力学原理进行信息处理的计算方式。量子比特（qubit）可以同时处于 0 和 1 的叠加态，' +
    '使得量子计算机在特定问题上具有指数级加速能力。量子计算的主要应用包括密码学、药物发现和优化问题。',
  markdown:
    '# 量子计算入门\n\n量子计算利用量子力学的叠加和纠缠原理，实现传统计算机无法企及的计算能力。' +
    '量子比特是量子计算的基本单元，与经典比特不同，它可以同时表示多个状态。',
};

// Sample B: Vector-only — semantically about quantum physics but avoids the exact phrase "量子计算"
const SAMPLE_B: TestSample = {
  label: 'B (vector-only)',
  url: 'https://example.com/superconducting-qubits',
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

// Sample C: Both — contains keyword AND is semantically rich
const SAMPLE_C: TestSample = {
  label: 'C (both)',
  url: 'https://example.com/quantum-ml',
  og_title: '量子计算与机器学习的交叉前沿',
  summary:
    '量子计算与机器学习的结合正在开辟全新的研究方向。量子神经网络（QNN）利用参数化量子电路实现模型训练，' +
    '在某些数据集上展现出超越经典模型的表达能力。量子核方法（quantum kernel methods）提供了一种在高维希尔伯特空间中计算相似度的新途径。',
  markdown:
    '# 量子计算与机器学习\n\n量子计算为机器学习带来了新的可能性。量子近似优化算法（QAOA）和变分量子本征求解器（VQE）' +
    '正在被用于训练量子机器学习模型。这种交叉领域的研究可能带来计算效率的质的飞跃。',
};

// Sample D: Unrelated — cooking recipe, should NOT match quantum queries
const SAMPLE_D: TestSample = {
  label: 'D (unrelated)',
  url: 'https://example.com/sichuan-mapo-tofu',
  og_title: '正宗川味麻婆豆腐的做法',
  summary:
    '麻婆豆腐是川菜的代表菜品，以麻辣鲜香著称。关键在于选用嫩豆腐，配以郫县豆瓣酱、花椒粉和牛肉末，' +
    '大火快炒收汁。正宗做法需要先将豆腐焯水去腥，最后勾薄芡让酱汁均匀包裹每一块豆腐。',
  markdown:
    '# 正宗川味麻婆豆腐\n\n材料：嫩豆腐一块，牛肉末100g，郫县豆瓣酱两大勺，花椒粉适量。' +
    '做法：豆腐切块焯水，锅中爆香牛肉末，加豆瓣酱炒出红油，放入豆腐轻推，勾芡收汁即可。',
};

const ALL_SAMPLES = [SAMPLE_A, SAMPLE_B, SAMPLE_C, SAMPLE_D];

/* ── Database Setup ── */

async function createTestDatabase(): Promise<void> {
  const adminPool = new pg.Pool({ host: 'localhost', port: 5432, user: 'reorx', database: 'postgres' });
  try {
    await adminPool.query('DROP DATABASE IF EXISTS linkmind_search_test WITH (FORCE)');
    await adminPool.query('CREATE DATABASE linkmind_search_test OWNER linkmind');
  } finally {
    await adminPool.end();
  }

  // Enable extensions as superuser
  const adminTestPool = new pg.Pool({ host: 'localhost', port: 5432, user: 'reorx', database: 'linkmind_search_test' });
  try {
    await adminTestPool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await adminTestPool.query('CREATE EXTENSION IF NOT EXISTS pg_search');
  } finally {
    await adminTestPool.end();
  }

  // Create schema
  const testPool = new pg.Pool({ connectionString: TEST_DB_URL });
  try {
    await testPool.query(`
      CREATE TABLE IF NOT EXISTS invites (
        id SERIAL PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        max_uses INTEGER NOT NULL DEFAULT 1,
        used_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT NOT NULL UNIQUE,
        username TEXT,
        display_name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        status TEXT NOT NULL DEFAULT 'pending',
        invite_id INTEGER REFERENCES invites(id)
      );

      CREATE TABLE IF NOT EXISTS records (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        type TEXT NOT NULL DEFAULT 'link',
        url TEXT,
        content TEXT,
        source_url TEXT,
        user_note TEXT,
        added_by_user BOOLEAN NOT NULL DEFAULT TRUE,
        og_title TEXT,
        og_description TEXT,
        og_image TEXT,
        og_site_name TEXT,
        og_type TEXT,
        markdown TEXT,
        summary TEXT,
        insight TEXT,
        related_notes JSONB DEFAULT '[]',
        related_links JSONB DEFAULT '[]',
        tags JSONB DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        telegram_message_id BIGINT,
        telegram_chat_id BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        images TEXT,
        summary_embedding vector(1024)
      );

      CREATE TABLE IF NOT EXISTS record_relations (
        id SERIAL PRIMARY KEY,
        record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        related_record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        score REAL NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(record_id, related_record_id)
      );

      CREATE TABLE IF NOT EXISTS record_derivations (
        source_record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        derived_record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (source_record_id, derived_record_id)
      );

      -- Test user
      INSERT INTO users (telegram_id, username, display_name, status)
      VALUES (${TEST_TELEGRAM_ID}, 'search_test', 'Search Test User', 'active');
    `);
  } finally {
    await testPool.end();
  }
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

async function createBM25Index(): Promise<void> {
  const adminPool = new pg.Pool({ host: 'localhost', port: 5432, user: 'reorx', database: 'linkmind_search_test' });
  try {
    await adminPool.query(`
      CREATE INDEX IF NOT EXISTS idx_records_bm25_test
      ON records USING bm25 (id, og_title, summary, markdown)
      WITH (key_field = 'id')
    `);
  } finally {
    await adminPool.end();
  }
}

async function dropTestDatabase(): Promise<void> {
  const adminPool = new pg.Pool({ host: 'localhost', port: 5432, user: 'reorx', database: 'postgres' });
  try {
    await adminPool.query('DROP DATABASE IF EXISTS linkmind_search_test WITH (FORCE)');
  } finally {
    await adminPool.end();
  }
}

/* ── Tests ── */

describe('Hybrid Search Integration', () => {
  let userId: number;
  let sampleIds: Map<string, number>;

  beforeAll(async () => {
    console.log('\n📦 Creating test database...');
    await createTestDatabase();

    // Get test user ID
    const pool = new pg.Pool({ connectionString: TEST_DB_URL });
    try {
      const res = await pool.query('SELECT id FROM users WHERE telegram_id = $1', [TEST_TELEGRAM_ID]);
      userId = res.rows[0].id;
    } finally {
      await pool.end();
    }

    console.log('📝 Inserting samples with real embeddings...');
    sampleIds = await insertSampleRecords(userId);

    console.log('🔧 Creating BM25 index...');
    await createBM25Index();

    console.log('✅ Setup complete\n');
  }, 120_000); // embedding API calls may take time

  afterAll(async () => {
    const suppress = (err: Error) => {
      if (err.message?.includes('terminating connection')) return;
      throw err;
    };
    process.on('uncaughtException', suppress);
    await dropTestDatabase();
    await new Promise((r) => setTimeout(r, 100));
    process.removeListener('uncaughtException', suppress);
  });

  it('BM25 should find records with exact keyword "量子计算"', async () => {
    const results = await hybridSearch('量子计算', userId, 10);

    const resultIds = results.map((r) => r.id);
    const idA = sampleIds.get('A (BM25-strong)')!;
    const idC = sampleIds.get('C (both)')!;
    const idD = sampleIds.get('D (unrelated)')!;

    // A and C contain "量子计算" → should have bm25Rank
    const resultA = results.find((r) => r.id === idA);
    const resultC = results.find((r) => r.id === idC);
    expect(resultA, 'Sample A should be in results').toBeDefined();
    expect(resultC, 'Sample C should be in results').toBeDefined();
    expect(resultA!.bm25Rank, 'Sample A should have bm25Rank').not.toBeNull();
    expect(resultC!.bm25Rank, 'Sample C should have bm25Rank').not.toBeNull();

    // D (cooking) should rank last if it appears (vector search returns all in small datasets)
    const resultD = results.find((r) => r.id === idD);
    if (resultD) {
      expect(resultD.bm25Rank, 'D should not have bm25 match for quantum query').toBeNull();
      expect(resultD.rrfScore).toBeLessThan(resultA!.rrfScore);
      expect(resultD.rrfScore).toBeLessThan(resultC!.rrfScore);
    }
  }, 30_000);

  it('Vector search should find semantically related records without exact keyword', async () => {
    const results = await hybridSearch('量子计算', userId, 10);

    const idB = sampleIds.get('B (vector-only)')!;

    // B is semantically about quantum computing but lacks the exact phrase
    // → should be found by vector search
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

    // A also has both (keyword in title/summary + semantic)
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

    // D should rank lowest if it appears
    const resultD = results.find((r) => r.id === idD);
    if (resultD) {
      const lastIndex = results.length - 1;
      expect(results[lastIndex].id).toBe(idD);
    }
  }, 30_000);

  it('Unrelated query should not return quantum computing records', async () => {
    const results = await hybridSearch('麻婆豆腐做法', userId, 10);

    const idD = sampleIds.get('D (unrelated)')!;
    const idA = sampleIds.get('A (BM25-strong)')!;

    // D (cooking) should be found
    const resultD = results.find((r) => r.id === idD);
    expect(resultD, 'Sample D should be found for cooking query').toBeDefined();

    // A (quantum) should NOT be found by BM25 for a cooking query
    const resultA = results.find((r) => r.id === idA);
    if (resultA) {
      expect(resultA.bm25Rank, 'A should not have bm25 match for cooking query').toBeNull();
    }
  }, 30_000);

  it('searchRelatedRecords should find semantically similar records', async () => {
    // Use sample A's embedding to find related records
    const idA = sampleIds.get('A (BM25-strong)')!;
    const embeddingA = await createEmbedding(SAMPLE_A.summary);

    const related = await searchRelatedRecords(embeddingA, userId, idA, 5);

    // Should find B and C (quantum-related), but not D (cooking)
    const relatedIds = related.map((r) => r.id);
    const idB = sampleIds.get('B (vector-only)')!;
    const idC = sampleIds.get('C (both)')!;
    const idD = sampleIds.get('D (unrelated)')!;

    expect(relatedIds, 'Should include semantically related B').toContain(idB);
    expect(relatedIds, 'Should include semantically related C').toContain(idC);

    // D should either not appear, or have a much lower score
    const scoreD = related.find((r) => r.id === idD)?.score ?? 0;
    const scoreB = related.find((r) => r.id === idB)?.score ?? 0;
    const scoreC = related.find((r) => r.id === idC)?.score ?? 0;
    expect(Math.max(scoreB, scoreC)).toBeGreaterThan(scoreD);
  }, 30_000);
});
