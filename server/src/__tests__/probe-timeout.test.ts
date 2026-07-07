/**
 * Behavior tests: probe timeout sweep + user notification.
 *
 * Covers:
 *   1. Expired `pending` probe event → event=expired, record=error with timeout message
 *   2. Expired `sent` probe event → same as above
 *   3. Non-expired event → untouched
 *   4. Expired event whose record already moved on (analyzed) → only event expired
 *   5. notifyUser: called once when record has telegram_chat_id; skipped without chat_id
 *   6. Pipeline resumed by handleProbeResult (probe scrapeData) → completion notification
 *
 * Uses a separate test database (linkmind_probe_test).
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

// Override DATABASE_URL to use test database BEFORE any imports that use it
const PROD_DB_URL = process.env.DATABASE_URL!;
const TEST_DB_URL = PROD_DB_URL.replace(/\/[^/]+$/, '/linkmind_probe_test');
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

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { bootstrapDatabase } from '../db/bootstrap.js';

// ── Mock scraper (no external calls; isTwitterUrl=false skips media processing) ──
vi.mock('../scraper.js', () => ({
  scrapeUrl: vi.fn(),
  scrapeWithFallbackChain: vi.fn(),
  isScrapeContentValid: vi.fn().mockReturnValue(true),
  isTwitterUrl: vi.fn().mockReturnValue(false),
}));

// ── Mock LLM ──
vi.mock('../llm.js', () => ({
  createEmbedding: vi.fn().mockResolvedValue({ embedding: new Array(1024).fill(0), usage: undefined }),
  getLLM: vi.fn().mockReturnValue({
    name: 'mock-llm',
    chat: vi.fn().mockImplementation(async (_messages: any[], opts?: any) => {
      if (opts?.label === 'summary' || opts?.label === 'hn-summary') {
        return {
          text: `<valid_content>true</valid_content>
<tags>twitter, testing</tags>

这是一条来自 Twitter 的测试推文，讨论了软件测试的重要性。`,
          usage: undefined,
        };
      }
      return { text: '这条推文强调了测试的价值，值得收藏。', usage: undefined };
    }),
  }),
}));

// ── Mock search ──
vi.mock('../search.js', () => ({
  searchRelatedRecords: vi.fn().mockResolvedValue([]),
}));

// ── Mock export ──
vi.mock('../export.js', () => ({
  renderMarkdown: vi.fn().mockReturnValue('# Mock Markdown'),
}));

import { initLogger } from '../logger.js';
initLogger();

import { getRecord, insertRecord, updateRecord, createProbeEvent, getProbeEventById } from '../db/index.js';
import { startWorker, handleProbeResult } from '../pipeline.js';
import { sweepExpiredProbeEvents } from '../probe-timeout-cron.js';
import { setNotifier } from '../notify.js';

const TEST_TELEGRAM_ID = 888888;
const TEST_CHAT_ID = -100777;
const TTL_HOURS = 24;

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
       VALUES ($1, 'probe_test_user', 'Probe Test User', 'active')
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
    await adminPool.query('DROP DATABASE IF EXISTS "linkmind_probe_test" WITH (FORCE)');
  } finally {
    await adminPool.end();
  }
}

// ── Helpers ──

let pool: pg.Pool;
let eventSeq = 0;

async function backdateProbeEvent(eventId: string, hours: number): Promise<void> {
  await pool.query(`UPDATE probe_events SET created_at = NOW() - make_interval(hours => $2) WHERE id = $1`, [
    eventId,
    hours,
  ]);
}

/** Create a waiting_probe record + its probe event. */
async function createWaitingProbeFixture(
  userId: number,
  opts: { chatId?: number; url?: string } = {},
): Promise<{ recordId: number; eventId: string; url: string }> {
  eventSeq += 1;
  const url = opts.url ?? `https://x.com/someone/status/${1000 + eventSeq}`;
  const recordId = await insertRecord(userId, {
    type: 'link',
    url,
    telegram_chat_id: opts.chatId,
  });
  await updateRecord(recordId, { status: 'waiting_probe' });
  const eventId = `test-event-${eventSeq}`;
  await createProbeEvent(eventId, userId, recordId, url, 'twitter');
  return { recordId, eventId, url };
}

// ── Tests ──

describe('Probe timeout sweep + notification', () => {
  let testUserId: number;
  const notifierMock = vi.fn().mockResolvedValue(undefined);

  beforeAll(async () => {
    await createTestDatabase();

    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    const res = await pool.query('SELECT id FROM users WHERE telegram_id = $1', [TEST_TELEGRAM_ID]);
    testUserId = res.rows[0].id;

    setNotifier(notifierMock);
    await startWorker();
  }, 30_000);

  afterAll(async () => {
    await pool.end();

    // Suppress pg connection errors during teardown (DROP DATABASE WITH FORCE kills idle connections)
    const suppress = (err: Error) => {
      if (err.message?.includes('terminating connection')) return;
      throw err;
    };
    process.on('uncaughtException', suppress);

    await dropTestDatabase();

    await new Promise((r) => setTimeout(r, 100));
    process.removeListener('uncaughtException', suppress);
  });

  beforeEach(() => {
    notifierMock.mockClear();
  });

  it('expires a pending event past TTL and marks record as error', async () => {
    const { recordId, eventId, url } = await createWaitingProbeFixture(testUserId, { chatId: TEST_CHAT_ID });
    await backdateProbeEvent(eventId, 25);

    await sweepExpiredProbeEvents(TTL_HOURS);

    const event = await getProbeEventById(eventId);
    expect(event!.status).toBe('expired');

    const record = await getRecord(recordId);
    expect(record!.status).toBe('error');
    expect(record!.error_message).toContain('Probe');
    expect(record!.error_message).toContain('超时');

    // Notification sent once to the record's chat
    expect(notifierMock).toHaveBeenCalledTimes(1);
    const [chatId, text] = notifierMock.mock.calls[0];
    expect(Number(chatId)).toBe(TEST_CHAT_ID);
    expect(text).toContain('超时');
    expect(text).toContain(url);
  });

  it('expires a sent event past TTL the same way', async () => {
    const { recordId, eventId } = await createWaitingProbeFixture(testUserId, { chatId: TEST_CHAT_ID });
    await pool.query(`UPDATE probe_events SET status = 'sent', sent_at = NOW() WHERE id = $1`, [eventId]);
    await backdateProbeEvent(eventId, 25);

    await sweepExpiredProbeEvents(TTL_HOURS);

    const event = await getProbeEventById(eventId);
    expect(event!.status).toBe('expired');

    const record = await getRecord(recordId);
    expect(record!.status).toBe('error');
    expect(notifierMock).toHaveBeenCalledTimes(1);
  });

  it('leaves events within TTL untouched', async () => {
    const { recordId, eventId } = await createWaitingProbeFixture(testUserId, { chatId: TEST_CHAT_ID });
    await backdateProbeEvent(eventId, 1);

    await sweepExpiredProbeEvents(TTL_HOURS);

    const event = await getProbeEventById(eventId);
    expect(event!.status).toBe('pending');

    const record = await getRecord(recordId);
    expect(record!.status).toBe('waiting_probe');
    expect(notifierMock).not.toHaveBeenCalled();
  });

  it('only expires the event when record has already moved on (analyzed)', async () => {
    const { recordId, eventId } = await createWaitingProbeFixture(testUserId, { chatId: TEST_CHAT_ID });
    await updateRecord(recordId, { status: 'analyzed' });
    await backdateProbeEvent(eventId, 25);

    await sweepExpiredProbeEvents(TTL_HOURS);

    const event = await getProbeEventById(eventId);
    expect(event!.status).toBe('expired');

    const record = await getRecord(recordId);
    expect(record!.status).toBe('analyzed');
    expect(record!.error_message).toBeFalsy();
    expect(notifierMock).not.toHaveBeenCalled();
  });

  it('does not notify (and does not throw) when record has no telegram_chat_id', async () => {
    const { recordId, eventId } = await createWaitingProbeFixture(testUserId, {});
    await backdateProbeEvent(eventId, 25);

    await sweepExpiredProbeEvents(TTL_HOURS);

    const event = await getProbeEventById(eventId);
    expect(event!.status).toBe('expired');

    const record = await getRecord(recordId);
    expect(record!.status).toBe('error');
    expect(notifierMock).not.toHaveBeenCalled();
  });

  it('sends a completion notification after pipeline resumed by handleProbeResult', async () => {
    const { recordId, eventId } = await createWaitingProbeFixture(testUserId, { chatId: TEST_CHAT_ID });

    await handleProbeResult(eventId, {
      title: 'Test Tweet',
      og_title: 'Test Tweet',
      og_description: 'A tweet about testing',
      markdown:
        '软件测试是构建可靠系统的基石。没有测试的重构就像蒙着眼睛开车，' +
        '你永远不知道下一次改动会撞坏什么。好的测试套件让团队敢于大胆修改代码，' +
        '因为回归会被立即发现。这也是为什么 BDD 和 TDD 在长期项目中回报巨大。',
      raw_media: [],
    });

    // Wait for the pipeline to finish and the completion notification to fire
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      const r = await getRecord(recordId);
      if (r?.status === 'error') throw new Error(`Pipeline failed: ${r.error_message}`);
      if (r?.status === 'analyzed' && notifierMock.mock.calls.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const record = await getRecord(recordId);
    expect(record!.status).toBe('analyzed');
    expect(record!.summary).toBeTruthy();

    expect(notifierMock).toHaveBeenCalledTimes(1);
    const [chatId, text, opts] = notifierMock.mock.calls[0];
    expect(Number(chatId)).toBe(TEST_CHAT_ID);
    expect(text).toContain('Test Tweet');
    expect(text).toContain('摘要');
    expect(opts?.recordUrl).toContain(`/link/${recordId}`);
  });
});
