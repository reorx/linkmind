/**
 * Usage billing tests: cost calculation, cycle dates, and full lifecycle.
 *
 * Uses a separate test database (linkmind_test) with the same bootstrap
 * pattern as pipeline.test.ts.
 *
 * Usage:
 *   cd server && npx vitest run src/__tests__/usage.test.ts
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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { bootstrapDatabase } from '../db/bootstrap.js';
import { initLogger } from '../logger.js';

initLogger();

import {
  calculateLLMCost,
  calculateEmbeddingCost,
  calculateCrawlerCost,
  getNextCycleStart,
  checkAndGetBudget,
  recordTransaction,
  resetUserCycle,
  getBalance,
} from '../usage.js';

// ── Helpers ──

/** Create a Date at local midnight for the given ISO date string (YYYY-MM-DD). */
function localDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Compare only the date portion (year-month-day) of two Date objects. */
function expectSameDate(actual: Date, expectedIso: string): void {
  const e = localDate(expectedIso);
  expect(actual.getFullYear()).toBe(e.getFullYear());
  expect(actual.getMonth()).toBe(e.getMonth());
  expect(actual.getDate()).toBe(e.getDate());
}

// ── Unit tests: Cost calculation ──

describe('Cost calculation', () => {
  it('calculateLLMCost: qwen-plus', () => {
    const cost = calculateLLMCost('qwen', 'qwen-plus', 1000, 500);
    // input: 1000/1M * ¥0.8 / 7.3 ≈ $0.0001096
    // output: 500/1M * ¥2.0 / 7.3 ≈ $0.0001370
    // total ≈ $0.0002466
    expect(cost).toBeCloseTo(0.0002466, 5);
  });

  it('calculateLLMCost: gemini-2.0-flash', () => {
    const cost = calculateLLMCost('gemini', 'gemini-2.0-flash', 1000, 500);
    // input: 1000/1M * $0.10 = $0.0001
    // output: 500/1M * $0.40 = $0.0002
    expect(cost).toBeCloseTo(0.0003, 6);
  });

  it('calculateEmbeddingCost: dashscope', () => {
    const cost = calculateEmbeddingCost('dashscope', 'text-embedding-v3', 500);
    // 500/1M * ¥0.7 / 7.3 ≈ $0.0000479
    expect(cost).toBeCloseTo(0.0000479, 6);
  });

  it('calculateCrawlerCost: firecrawl', () => {
    expect(calculateCrawlerCost('firecrawl')).toBe(0.001);
  });

  it('calculateCrawlerCost: jina', () => {
    expect(calculateCrawlerCost('jina')).toBe(0.001);
  });

  it('zero tokens → zero cost', () => {
    expect(calculateLLMCost('qwen', 'qwen-plus', 0, 0)).toBe(0);
    expect(calculateEmbeddingCost('dashscope', 'text-embedding-v3', 0)).toBe(0);
  });
});

// ── Unit tests: Cycle date calculation ──

describe('Cycle date calculation', () => {
  it('anchor day 31 → Feb 28 (non-leap year)', () => {
    // 2027 is not a leap year
    const next = getNextCycleStart(localDate('2027-01-31'), 31);
    expectSameDate(next, '2027-02-28');
  });

  it('anchor day 31 → Feb 29 (leap year)', () => {
    // 2028 is a leap year
    const next = getNextCycleStart(localDate('2028-01-31'), 31);
    expectSameDate(next, '2028-02-29');
  });

  it('anchor day 31 → Mar 31 (back to normal after Feb)', () => {
    const next = getNextCycleStart(localDate('2028-02-29'), 31);
    expectSameDate(next, '2028-03-31');
  });

  it('anchor day 15 → always 15th', () => {
    const next1 = getNextCycleStart(localDate('2028-01-15'), 15);
    expectSameDate(next1, '2028-02-15');

    const next2 = getNextCycleStart(localDate('2028-02-15'), 15);
    expectSameDate(next2, '2028-03-15');
  });

  it('anchor day 29 → Feb 28 (non-leap) / Feb 29 (leap)', () => {
    const nonLeap = getNextCycleStart(localDate('2027-01-29'), 29);
    expectSameDate(nonLeap, '2027-02-28');

    const leap = getNextCycleStart(localDate('2028-01-29'), 29);
    expectSameDate(leap, '2028-02-29');
  });

  it('multi-month skip: if 3 months elapsed, should advance 3 cycles', () => {
    let date = localDate('2028-01-31');
    date = getNextCycleStart(date, 31); // → 02-29
    expectSameDate(date, '2028-02-29');
    date = getNextCycleStart(date, 31); // → 03-31
    expectSameDate(date, '2028-03-31');
    date = getNextCycleStart(date, 31); // → 04-30
    expectSameDate(date, '2028-04-30');
  });
});

// ── Integration tests: Full billing lifecycle ──

describe('Usage billing lifecycle', () => {
  let userId: number;
  let recordId1: number;
  let recordId2: number;
  let recordId3: number;

  beforeAll(async () => {
    await bootstrapDatabase({
      databaseUrl: TEST_DB_URL,
      adminDatabaseUrl: TEST_DB_ADMIN_URL,
      dropIfExists: true,
      absurdQueueName: 'linkmind',
    });

    const pool = new pg.Pool({ connectionString: TEST_DB_URL });
    try {
      // Create test user
      const userRes = await pool.query(
        `INSERT INTO users (telegram_id, username, display_name, status)
         VALUES (888888, 'usage_test_user', 'Usage Test User', 'active')
         RETURNING id`,
      );
      userId = userRes.rows[0].id;

      // Create test records for foreign key references
      const r1 = await pool.query(
        `INSERT INTO records (user_id, type, url, status, added_by_user, ingested_with_content)
         VALUES ($1, 'link', 'https://example.com/article1', 'enqueued', true, false)
         RETURNING id`,
        [userId],
      );
      recordId1 = r1.rows[0].id;

      const r2 = await pool.query(
        `INSERT INTO records (user_id, type, url, status, added_by_user, ingested_with_content)
         VALUES ($1, 'link', 'https://example.com/article2', 'enqueued', true, false)
         RETURNING id`,
        [userId],
      );
      recordId2 = r2.rows[0].id;

      const r3 = await pool.query(
        `INSERT INTO records (user_id, type, url, status, added_by_user, ingested_with_content)
         VALUES ($1, 'link', 'https://example.com/article3', 'enqueued', true, false)
         RETURNING id`,
        [userId],
      );
      recordId3 = r3.rows[0].id;

      // Initialize user_balances with known anchor
      await pool.query(
        `INSERT INTO user_balances (user_id, cycle_limit_usd, cycle_anchor, current_cycle_usage_usd, current_cycle_start)
         VALUES ($1, 1.0000, '2028-01-01', 0, '2028-01-01')`,
        [userId],
      );
    } finally {
      await pool.end();
    }
  }, 30_000);

  afterAll(async () => {
    const suppress = (err: Error) => {
      if (err.message?.includes('terminating connection')) return;
      throw err;
    };
    process.on('uncaughtException', suppress);

    const adminPool = new pg.Pool({ connectionString: TEST_DB_ADMIN_URL });
    try {
      await adminPool.query('DROP DATABASE IF EXISTS "linkmind_test" WITH (FORCE)');
    } finally {
      await adminPool.end();
    }

    await new Promise((r) => setTimeout(r, 100));
    process.removeListener('uncaughtException', suppress);
  });

  it('Phase 1: Jan 31 — first pipeline usage', async () => {
    const now = localDate('2028-01-31');

    // Check budget — should be allowed (usage=0, limit=1.00)
    const check1 = await checkAndGetBudget(userId, now);
    expect(check1.allowed).toBe(true);
    expect(check1.usedUsd).toBe(0);

    // 1. Firecrawl scrape
    await recordTransaction({
      userId,
      recordId: recordId1,
      step: 'scrape',
      type: 'crawler',
      provider: 'firecrawl',
      url: 'https://example.com/article1',
    });

    // 2. LLM summarize (qwen-plus): 1500 input + 400 output tokens
    await recordTransaction({
      userId,
      recordId: recordId1,
      step: 'summary',
      type: 'llm',
      provider: 'qwen',
      model: 'qwen-plus',
      inputTokens: 1500,
      outputTokens: 400,
    });

    // 3. Embedding (dashscope): 200 tokens
    await recordTransaction({
      userId,
      recordId: recordId1,
      step: 'embed',
      type: 'embedding',
      provider: 'dashscope',
      model: 'text-embedding-v3',
      inputTokens: 200,
    });

    // 4. LLM insight (qwen-plus): 800 input + 300 output tokens
    await recordTransaction({
      userId,
      recordId: recordId1,
      step: 'insight',
      type: 'llm',
      provider: 'qwen',
      model: 'qwen-plus',
      inputTokens: 800,
      outputTokens: 300,
    });

    // Assert: balance matches sum of all transactions
    const expectedUsage =
      calculateCrawlerCost('firecrawl') +
      calculateLLMCost('qwen', 'qwen-plus', 1500, 400) +
      calculateEmbeddingCost('dashscope', 'text-embedding-v3', 200) +
      calculateLLMCost('qwen', 'qwen-plus', 800, 300);

    const check2 = await checkAndGetBudget(userId, now);
    expect(check2.allowed).toBe(true);
    expect(check2.usedUsd).toBeCloseTo(expectedUsage, 6);
    expectSameDate(check2.cycleStart, '2028-01-01');

    // Verify user_balances table is in sync
    const balance = await getBalance(userId);
    expect(Number(balance!.current_cycle_usage_usd)).toBeCloseTo(expectedUsage, 6);
  });

  it('Phase 2: Jan 31 — user pays, cycle resets', async () => {
    const now = localDate('2028-01-31');

    // Reset cycle with new anchor = Jan 31
    await resetUserCycle(userId, localDate('2028-01-31'));

    // Assert: usage zeroed
    const check = await checkAndGetBudget(userId, now);
    expect(check.allowed).toBe(true);
    expect(check.usedUsd).toBe(0);
    expectSameDate(check.cycleStart, '2028-01-31');

    // Assert: balance table updated
    const balance = await getBalance(userId);
    expect(Number(balance!.current_cycle_usage_usd)).toBe(0);
    expectSameDate(balance!.cycle_anchor, '2028-01-31');
    expectSameDate(balance!.current_cycle_start, '2028-01-31');
  });

  it('Phase 3: Jan 31 — new usage after reset', async () => {
    const now = localDate('2028-01-31');

    // Another pipeline run
    await recordTransaction({
      userId,
      recordId: recordId2,
      step: 'scrape',
      type: 'crawler',
      provider: 'jina',
      url: 'https://example.com/article2',
    });

    await recordTransaction({
      userId,
      recordId: recordId2,
      step: 'summary',
      type: 'llm',
      provider: 'qwen',
      model: 'qwen-plus',
      inputTokens: 2000,
      outputTokens: 500,
    });

    const expectedUsage = calculateCrawlerCost('jina') + calculateLLMCost('qwen', 'qwen-plus', 2000, 500);

    const check = await checkAndGetBudget(userId, now);
    expect(check.allowed).toBe(true);
    expect(check.usedUsd).toBeCloseTo(expectedUsage, 6);
    expectSameDate(check.cycleStart, '2028-01-31');
  });

  it('Phase 4: Feb 29 — cross-cycle auto-reset (leap year)', async () => {
    const now = localDate('2028-02-29');

    // checkAndGetBudget triggers lazy reset
    const check = await checkAndGetBudget(userId, now);

    // Assert: auto-reset, usage zeroed
    expect(check.usedUsd).toBe(0);
    expect(check.allowed).toBe(true);
    expectSameDate(check.cycleStart, '2028-02-29');
  });

  it('Phase 4 cont: Feb 29 — over-limit detection with qwen-max', async () => {
    const now = localDate('2028-02-29');

    // Large consumption with qwen-max (2M input + 500K output)
    // Cost per call: (2*¥2.0 + 0.5*¥6.0) / 7.3 = ¥7/7.3 ≈ $0.9589
    await recordTransaction({
      userId,
      recordId: recordId3,
      step: 'summary',
      type: 'llm',
      provider: 'qwen',
      model: 'qwen-max',
      inputTokens: 2_000_000,
      outputTokens: 500_000,
    });

    // Not over limit yet (~$0.96)
    let check = await checkAndGetBudget(userId, now);
    expect(check.allowed).toBe(true);
    const summaryCost = calculateLLMCost('qwen', 'qwen-max', 2_000_000, 500_000);
    expect(check.usedUsd).toBeCloseTo(summaryCost, 4);

    // Another large charge — should push over $1.00 limit
    await recordTransaction({
      userId,
      recordId: recordId3,
      step: 'insight',
      type: 'llm',
      provider: 'qwen',
      model: 'qwen-max',
      inputTokens: 2_000_000,
      outputTokens: 500_000,
    });

    // Over limit (~$1.92 > $1.00)
    check = await checkAndGetBudget(userId, now);
    expect(check.allowed).toBe(false);
    const totalCost = summaryCost + calculateLLMCost('qwen', 'qwen-max', 2_000_000, 500_000);
    expect(check.usedUsd).toBeCloseTo(totalCost, 4);
    expect(check.limitUsd).toBe(1.0);
  });

  it('Phase 5: idempotency — duplicate recordTransaction does not double charge', async () => {
    const beforeBalance = await getBalance(userId);
    const beforeUsage = Number(beforeBalance!.current_cycle_usage_usd);

    // Duplicate: same record_id + step as Phase 4's summary
    await recordTransaction({
      userId,
      recordId: recordId3,
      step: 'summary',
      type: 'llm',
      provider: 'qwen',
      model: 'qwen-max',
      inputTokens: 2_000_000,
      outputTokens: 500_000,
    });

    // Assert: balance unchanged
    const afterBalance = await getBalance(userId);
    expect(Number(afterBalance!.current_cycle_usage_usd)).toBe(beforeUsage);
  });
});
