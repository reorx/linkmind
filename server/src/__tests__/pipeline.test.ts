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
const TEST_DB_ADMIN_URL =
  process.env.TEST_DB_ADMIN_DATABASE_URL ??
  (() => {
    const url = new URL(TEST_DB_URL);
    url.pathname = '/postgres';
    if (!url.username || url.username === 'linkmind') {
      url.username = 'reorx';
    }
    return url.toString();
  })();

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { bootstrapDatabase } from '../db/bootstrap.js';

// ── Mock scraper ──
vi.mock('../scraper.js', () => ({
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
  scrapeWithFallbackChain: vi.fn().mockResolvedValue({
    source: 'playwright',
    data: {
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
    },
    trace: ['playwright'],
  }),
  isTwitterUrl: vi.fn().mockReturnValue(false),
}));

// ── Mock LLM ──
vi.mock('../llm.js', () => ({
  createEmbedding: vi.fn().mockResolvedValue({ embedding: new Array(1024).fill(0), usage: undefined }),
  generateObject: vi.fn().mockImplementation(async (_messages: any[], options: any) => ({
    result: options.parse({
      valid_content: true,
      summary: '这是一篇关于风暴英雄（HotS）的个人回忆文章，作者分享了这款游戏对他的意义。',
      tags: ['gaming', 'HotS', 'community', 'personal-essay'],
    }),
    usage: undefined,
  })),
  getLLM: vi.fn().mockReturnValue({
    name: 'mock-llm',
    chat: vi.fn().mockImplementation(async (messages: any[], opts?: any) => {
      if (opts?.jsonMode) {
        return {
          text: JSON.stringify({
            summary: '这是一篇关于风暴英雄（HotS）的个人回忆文章，作者分享了这款游戏对他的意义。',
            tags: ['gaming', 'HotS', 'community', 'personal-essay'],
          }),
          usage: undefined,
        };
      }
      // Insight response
      return { text: '这篇文章很有共鸣感，作为游戏玩家能理解社区消亡的失落。值得收藏。', usage: undefined };
    }),
  }),
}));

// ── Mock search (for related content) ──
vi.mock('../search.js', () => ({
  searchRelatedRecords: vi.fn().mockResolvedValue([]),
}));

// ── Mock export (file export disabled, renderMarkdown kept for future use) ──
vi.mock('../export.js', () => ({
  renderMarkdown: vi.fn().mockReturnValue('# Mock Markdown'),
}));

import { initLogger } from '../logger.js';
initLogger();

const TEST_URL = 'https://reorx.com/essays/2023/01/what-hots-means-to-me/';
const TEST_TELEGRAM_ID = 999999;

// ── Test database setup ──

async function createTestDatabase(): Promise<void> {
  await bootstrapDatabase({
    databaseUrl: TEST_DB_URL,
    adminDatabaseUrl: TEST_DB_ADMIN_URL,
    dropIfExists: true,
    absurdQueueName: 'linkmind',
  });

  const testPool = new pg.Pool({ connectionString: TEST_DB_URL });
  try {
    await testPool.query(
      `INSERT INTO users (telegram_id, username, display_name, status)
       VALUES ($1, 'test_user', 'Test User', 'active')
       ON CONFLICT (telegram_id) DO NOTHING`,
      [TEST_TELEGRAM_ID],
    );
  } finally {
    await testPool.end();
  }
}

async function dropTestDatabase(): Promise<void> {
  const adminPool = new pg.Pool({ connectionString: TEST_DB_ADMIN_URL });
  try {
    await adminPool.query('DROP DATABASE IF EXISTS "linkmind_test" WITH (FORCE)');
  } finally {
    await adminPool.end();
  }
}

// ── Helpers ──

import {
  getRecord,
  getRecordByUrl,
  insertNote,
  insertRecord,
  appendUserNote,
  getRecordByTelegramMessage,
} from '../db/index.js';
import { startWorker, spawnProcessLink, spawnProcessNote } from '../pipeline.js';

async function waitForLink(userId: number, url: string, timeoutMs: number = 60_000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const link = await getRecordByUrl(userId, url);
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
    const link = await getRecord(linkId);

    expect(link).toBeDefined();
    expect(link!.status).toBe('analyzed');
    expect(link!.og_title).toBe('What HotS Means to Me');
    expect(link!.summary).toContain('风暴英雄');
    expect(link!.insight).toBeTruthy();
    expect(JSON.parse(link!.tags!)).toContain('gaming');
  });

  it('should upsert when processing the same URL again', async () => {
    // Get the existing link
    const existingLink = await getRecordByUrl(testUserId, TEST_URL);
    expect(existingLink).toBeDefined();
    const originalId = existingLink!.id!;

    // Process same URL again
    const { taskId } = await spawnProcessLink(testUserId, TEST_URL, originalId);
    expect(taskId).toBeTruthy();

    const linkId = await waitForLink(testUserId, TEST_URL);

    // Should be the same link ID (upsert, not duplicate)
    expect(linkId).toBe(originalId);

    const link = await getRecord(linkId);
    expect(link).toBeDefined();
    expect(link!.status).toBe('analyzed');
    expect(link!.og_title).toBe('What HotS Means to Me');
  });

  it('should have exactly one record for the test URL', async () => {
    const pool = new pg.Pool({ connectionString: TEST_DB_URL });
    try {
      const res = await pool.query('SELECT COUNT(*) as count FROM records WHERE url = $1', [TEST_URL]);
      expect(parseInt(res.rows[0].count)).toBe(1);
    } finally {
      await pool.end();
    }
  });

  // ── Note tests ──

  it('should insert a note record and process it through note pipeline', async () => {
    const noteContent =
      '今天研究了 RAG 的几种实现方式，发现 naive chunking 效果很差，' +
      'semantic chunking 配合 re-ranking 效果好很多。关键是 chunk size 的选择，' +
      '太大会稀释语义，太小会丢失上下文。HyDE 也是个有趣的方向，用 LLM 生成假设性文档来做检索。' +
      '另外 ColBERT 的 late interaction 模式在长文档检索上表现很好。';

    const recordId = await insertNote(testUserId, noteContent, {
      telegramMessageId: 12345,
      telegramChatId: -100123,
    });
    expect(recordId).toBeGreaterThan(0);

    // Verify the record was created correctly
    const record = await getRecord(recordId);
    expect(record).toBeDefined();
    expect(record!.type).toBe('note');
    expect(record!.content).toBe(noteContent);
    expect(record!.url).toBeUndefined();
    expect(record!.added_by_user).toBe(true);
    expect(Number(record!.telegram_message_id)).toBe(12345);
    expect(Number(record!.telegram_chat_id)).toBe(-100123);

    // Process through note pipeline
    const { taskId } = await spawnProcessNote(testUserId, recordId);
    expect(taskId).toBeTruthy();

    // Wait for processing
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      const r = await getRecord(recordId);
      if (r?.status === 'analyzed') break;
      if (r?.status === 'error') throw new Error(`Note pipeline failed: ${r.error_message}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const processed = await getRecord(recordId);
    expect(processed!.status).toBe('analyzed');
    expect(processed!.summary).toBeTruthy();
    expect(processed!.tags).toBeTruthy();
    expect(processed!.insight).toBeTruthy();
  });

  it('should insert a link record with user_note', async () => {
    const recordId = await insertRecord(testUserId, {
      type: 'link',
      url: 'https://example.com/test-note',
      user_note: '这个链接很有意思',
    });

    const record = await getRecord(recordId);
    expect(record).toBeDefined();
    expect(record!.type).toBe('link');
    expect(record!.url).toBe('https://example.com/test-note');
    expect(record!.user_note).toBe('这个链接很有意思');
    expect(record!.added_by_user).toBe(true);
  });

  it('should append user notes correctly', async () => {
    const recordId = await insertNote(testUserId, 'Initial note content');

    await appendUserNote(recordId, 'First comment');
    let record = await getRecord(recordId);
    expect(record!.user_note).toBe('First comment');

    await appendUserNote(recordId, 'Second comment');
    record = await getRecord(recordId);
    expect(record!.user_note).toBe('First comment\n\nSecond comment');
  });

  it('should find record by telegram message', async () => {
    const recordId = await insertNote(testUserId, 'Telegram linked note', {
      telegramMessageId: 99999,
      telegramChatId: -100999,
    });

    const found = await getRecordByTelegramMessage(-100999, 99999);
    expect(found).toBeDefined();
    expect(found!.id).toBe(recordId);
    expect(found!.content).toBe('Telegram linked note');

    // Should return undefined for non-existent message
    const notFound = await getRecordByTelegramMessage(-100999, 88888);
    expect(notFound).toBeUndefined();
  });

  it('should insert a derived record (added_by_user = false)', async () => {
    const recordId = await insertRecord(testUserId, {
      type: 'link',
      url: 'https://example.com/derived',
      added_by_user: false,
    });

    const record = await getRecord(recordId);
    expect(record).toBeDefined();
    expect(record!.added_by_user).toBe(false);
  });
});
