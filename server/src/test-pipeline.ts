/**
 * Integration test: full pipeline (scrape → analyze → export) via Absurd.
 *
 * Uses a separate test database (linkmind_test) to avoid affecting production data.
 * Mocks the scraper and LLM to avoid external dependencies.
 *
 * Usage:
 *   npx vitest run src/test-pipeline.ts
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

// Override DATABASE_URL to use test database BEFORE any imports that use it
const PROD_DB_URL = process.env.DATABASE_URL!;
const TEST_DB_URL = PROD_DB_URL.replace(/\/[^/]+$/, '/linkmind_test');
process.env.DATABASE_URL = TEST_DB_URL;

import { describe, it, expect, beforeAll, afterAll, vi, onTestFinished } from 'vitest';
import pg from 'pg';

// ── Mock scraper ──
vi.mock('./scraper.js', () => ({
  scrapeUrl: vi.fn().mockResolvedValue({
    title: 'What HotS Means to Me',
    og: {
      title: 'What HotS Means to Me',
      description: 'A personal reflection on Heroes of the Storm and what the game meant.',
      image: 'https://reorx.com/og-image.png',
      siteName: 'reorx.com',
      type: 'article',
    },
    markdown:
      '# What HotS Means to Me\n\nHeroes of the Storm was more than a game to me. ' +
      'It was a place where I found community, learned teamwork, and experienced some of the most ' +
      'memorable gaming moments of my life. The game taught me about strategy, adaptability, and ' +
      'the importance of team composition. Even though Blizzard pulled the plug on its esports scene, ' +
      'the community persists. The lessons I learned playing HotS — about cooperation, about reading ' +
      'situations, about making the best of imperfect circumstances — carry over into everything I do.',
    rawMedia: [],
    author: 'Reorx',
    published: '2023-01-15',
  }),
  isTwitterUrl: vi.fn().mockReturnValue(false),
}));

// ── Mock LLM ──
vi.mock('./llm.js', () => ({
  createEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0)),
  getLLM: vi.fn().mockReturnValue({
    name: 'mock-llm',
    chat: vi.fn().mockImplementation(async (messages: any[], opts?: any) => {
      if (opts?.jsonMode) {
        return JSON.stringify({
          summary: '这是一篇关于风暴英雄（HotS）的个人回忆文章，作者分享了这款游戏对他的意义。',
          tags: ['gaming', 'HotS', 'community', 'personal-essay'],
        });
      }
      // Insight response
      return '这篇文章很有共鸣感，作为游戏玩家能理解社区消亡的失落。值得收藏。';
    }),
  }),
}));

// ── Mock search (for related content) ──
vi.mock('./search.js', () => ({
  searchRelatedLinks: vi.fn().mockResolvedValue([]),
}));

// ── Mock export (file export disabled, renderMarkdown kept for future use) ──
vi.mock('./export.js', () => ({
  renderMarkdown: vi.fn().mockReturnValue('# Mock Markdown'),
}));

import { initLogger } from './logger.js';
initLogger();

const TEST_URL = 'https://reorx.com/essays/2023/01/what-hots-means-to-me/';
const TEST_TELEGRAM_ID = 999999;

// ── Test database setup ──

async function createTestDatabase(): Promise<void> {
  // Connect as superuser to create/drop test database
  const adminPool = new pg.Pool({
    host: 'localhost',
    port: 5432,
    user: 'reorx',
    database: 'postgres',
  });

  try {
    // Drop if exists, then create (owned by linkmind so the app user has full access)
    await adminPool.query('DROP DATABASE IF EXISTS linkmind_test');
    await adminPool.query('CREATE DATABASE linkmind_test OWNER linkmind');
  } finally {
    await adminPool.end();
  }

  // Enable pgvector as superuser (requires elevated privileges)
  const adminTestPool = new pg.Pool({
    host: 'localhost',
    port: 5432,
    user: 'reorx',
    database: 'linkmind_test',
  });
  try {
    await adminTestPool.query('CREATE EXTENSION IF NOT EXISTS vector');
  } finally {
    await adminTestPool.end();
  }

  // Now connect to the test database and set up schema
  const testPool = new pg.Pool({ connectionString: TEST_DB_URL });
  try {
    // Create application tables
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

      CREATE TABLE IF NOT EXISTS links (
        id SERIAL PRIMARY KEY,
        url TEXT NOT NULL,
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
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        user_id INTEGER NOT NULL REFERENCES users(id),
        images TEXT,
        summary_embedding vector(1536)
      );

      CREATE INDEX IF NOT EXISTS idx_links_url ON links(url);
      CREATE INDEX IF NOT EXISTS idx_links_user_id ON links(user_id);
      CREATE INDEX IF NOT EXISTS idx_links_status ON links(status);
      CREATE INDEX IF NOT EXISTS idx_links_created_at ON links(created_at DESC);

      CREATE TABLE IF NOT EXISTS link_relations (
        id SERIAL PRIMARY KEY,
        link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
        related_link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
        score REAL NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(link_id, related_link_id)
      );

      CREATE TABLE IF NOT EXISTS probe_devices (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        access_token TEXT UNIQUE NOT NULL,
        name TEXT,
        last_seen_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS probe_events (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        link_id INTEGER REFERENCES links(id),
        url TEXT NOT NULL,
        url_type TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        result JSONB,
        error TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        sent_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS device_auth_requests (
        device_code TEXT PRIMARY KEY,
        user_code TEXT NOT NULL,
        user_id INTEGER REFERENCES users(id),
        status TEXT DEFAULT 'pending',
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Create Absurd schema, functions, and queue
    const fs = await import('fs');
    const path = await import('path');
    const absurdSql = fs.readFileSync(path.resolve(import.meta.dirname, '../sql/absurd.sql'), 'utf-8');
    await testPool.query(absurdSql);
    await testPool.query("SELECT absurd.create_queue('linkmind')");

    // Create test user
    await testPool.query(
      `INSERT INTO users (telegram_id, username, display_name, status)
       VALUES ($1, 'test_user', 'Test User', 'active')`,
      [TEST_TELEGRAM_ID],
    );
  } finally {
    await testPool.end();
  }
}

async function dropTestDatabase(): Promise<void> {
  const adminPool = new pg.Pool({
    host: 'localhost',
    port: 5432,
    user: 'reorx',
    database: 'postgres',
  });
  try {
    await adminPool.query('DROP DATABASE IF EXISTS linkmind_test WITH (FORCE)');
  } finally {
    await adminPool.end();
  }
}

// ── Helpers ──

import { getLink, getLinkByUrl } from './db.js';
import { startWorker, spawnProcessLink } from './pipeline.js';

async function waitForLink(userId: number, url: string, timeoutMs: number = 60_000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const link = await getLinkByUrl(userId, url);
    if (link?.id && link.status === 'analyzed') return link.id;
    if (link?.id && link.status === 'error') throw new Error(`Pipeline failed: ${link.error_message}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for link to be analyzed`);
}

// ── Tests ──

describe('Pipeline integration', () => {
  let testUserId: number;

  beforeAll(async () => {
    await createTestDatabase();

    // Look up the test user ID
    const pool = new pg.Pool({ connectionString: TEST_DB_URL });
    try {
      const res = await pool.query('SELECT id FROM users WHERE telegram_id = $1', [TEST_TELEGRAM_ID]);
      testUserId = res.rows[0].id;
    } finally {
      await pool.end();
    }

    // Start the Absurd worker
    await startWorker();
  }, 30_000);

  afterAll(async () => {
    // Suppress pg connection errors during teardown (DROP DATABASE WITH FORCE kills idle connections)
    const suppress = (err: Error) => {
      if (err.message?.includes('terminating connection')) return;
      throw err;
    };
    process.on('uncaughtException', suppress);

    await dropTestDatabase();

    // Give a tick for errors to fire, then remove the handler
    await new Promise((r) => setTimeout(r, 100));
    process.removeListener('uncaughtException', suppress);
  });

  it('should process a new URL through the full pipeline', async () => {
    const { taskId } = await spawnProcessLink(testUserId, TEST_URL);
    expect(taskId).toBeTruthy();

    const linkId = await waitForLink(testUserId, TEST_URL);
    const link = await getLink(linkId);

    expect(link).toBeDefined();
    expect(link!.status).toBe('analyzed');
    expect(link!.og_title).toBe('What HotS Means to Me');
    expect(link!.summary).toContain('风暴英雄');
    expect(link!.insight).toBeTruthy();
    expect(JSON.parse(link!.tags!)).toContain('gaming');
  });

  it('should upsert when processing the same URL again', async () => {
    // Get the existing link
    const existingLink = await getLinkByUrl(testUserId, TEST_URL);
    expect(existingLink).toBeDefined();
    const originalId = existingLink!.id!;

    // Process same URL again
    const { taskId } = await spawnProcessLink(testUserId, TEST_URL, originalId);
    expect(taskId).toBeTruthy();

    const linkId = await waitForLink(testUserId, TEST_URL);

    // Should be the same link ID (upsert, not duplicate)
    expect(linkId).toBe(originalId);

    const link = await getLink(linkId);
    expect(link).toBeDefined();
    expect(link!.status).toBe('analyzed');
    expect(link!.og_title).toBe('What HotS Means to Me');
  });

  it('should have exactly one record for the test URL', async () => {
    const pool = new pg.Pool({ connectionString: TEST_DB_URL });
    try {
      const res = await pool.query('SELECT COUNT(*) as count FROM links WHERE url = $1', [TEST_URL]);
      expect(parseInt(res.rows[0].count)).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
