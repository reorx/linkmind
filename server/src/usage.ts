/**
 * Usage billing business logic.
 *
 * Tracks per-user resource consumption (LLM, Crawler, Embedding) in USD.
 * Uses lazy cycle reset — checkAndGetBudget() detects and advances cycles.
 * Soft limit: blocks new pipeline enqueue, but running pipelines complete.
 */

import { logger } from './logger.js';
import {
  getOrCreateBalance,
  getBalance,
  insertTransactionAndUpdateBalance,
  updateBalanceCycleReset,
  updateCycleAnchorAndReset,
} from './db/usage.js';

export { getBalance } from './db/usage.js';

const log = logger.child({ module: 'usage' });

/* ── Configuration ── */

const CNY_USD_RATE = Number(process.env.CNY_USD_RATE) || 7.3;
const DEFAULT_CYCLE_LIMIT_USD = Number(process.env.DEFAULT_CYCLE_LIMIT_USD) || 1.0;
const BILLING_TIMEZONE = process.env.BILLING_TIMEZONE || 'Asia/Shanghai';

/* ── Pricing tables ── */

// LLM pricing per 1M tokens
const LLM_PRICING: Record<string, { input: number; output: number; currency: 'USD' | 'CNY' }> = {
  'qwen/qwen-plus': { input: 0.8, output: 2.0, currency: 'CNY' },
  'qwen/qwen-max': { input: 2.0, output: 6.0, currency: 'CNY' },
  'gemini/gemini-2.0-flash': { input: 0.1, output: 0.4, currency: 'USD' },
  'gemini/gemini-3-flash-preview': { input: 0.5, output: 3.0, currency: 'USD' },
};

// Embedding pricing per 1M tokens (input only)
const EMBEDDING_PRICING: Record<string, { input: number; currency: 'USD' | 'CNY' }> = {
  'dashscope/text-embedding-v3': { input: 0.7, currency: 'CNY' },
  'voyage/voyage-4': { input: 0.03, currency: 'USD' },
};

// Crawler pricing per call (USD)
const CRAWLER_PRICING: Record<string, number> = {
  firecrawl: 0.001,
  jina: 0.001,
};

/* ── Cost calculation (exported for testing) ── */

export function calculateLLMCost(provider: string, model: string, inputTokens: number, outputTokens: number): number {
  const key = `${provider}/${model}`;
  const pricing = LLM_PRICING[key];
  if (!pricing) {
    log.warn({ provider, model }, 'Unknown LLM pricing, returning 0');
    return 0;
  }
  const rate = pricing.currency === 'CNY' ? CNY_USD_RATE : 1;
  const inputCost = ((inputTokens / 1_000_000) * pricing.input) / rate;
  const outputCost = ((outputTokens / 1_000_000) * pricing.output) / rate;
  return inputCost + outputCost;
}

export function calculateEmbeddingCost(provider: string, model: string, inputTokens: number): number {
  const key = `${provider}/${model}`;
  const pricing = EMBEDDING_PRICING[key];
  if (!pricing) {
    log.warn({ provider, model }, 'Unknown embedding pricing, returning 0');
    return 0;
  }
  const rate = pricing.currency === 'CNY' ? CNY_USD_RATE : 1;
  return ((inputTokens / 1_000_000) * pricing.input) / rate;
}

export function calculateCrawlerCost(provider: string): number {
  const cost = CRAWLER_PRICING[provider];
  if (cost === undefined) {
    log.warn({ provider }, 'Unknown crawler pricing, returning 0');
    return 0;
  }
  return cost;
}

/* ── Date / cycle helpers ── */

/**
 * Returns current date in BILLING_TIMEZONE.
 * Must be a plain function (not arrow/const) so tests can mock with vi.spyOn.
 */
export function getCurrentDate(): Date {
  const now = new Date();
  // Format in the billing timezone to get the local date parts
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BILLING_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const year = Number(parts.find((p) => p.type === 'year')!.value);
  const month = Number(parts.find((p) => p.type === 'month')!.value);
  const day = Number(parts.find((p) => p.type === 'day')!.value);

  // Return a plain Date representing midnight of that date (no time component).
  // pg returns DATE columns as local-time midnight, so we stay consistent.
  return new Date(year, month - 1, day);
}

/**
 * Calculate next cycle start from current cycle start + original anchor day.
 * Uses anchorDay (not currentCycleStart's day) to avoid drift on short months.
 */
export function getNextCycleStart(currentCycleStart: Date, anchorDay: number): Date {
  // Use local-time methods — pg returns DATE columns as local-time midnight
  const year = currentCycleStart.getFullYear();
  const month = currentCycleStart.getMonth(); // 0-indexed

  // Target is the next month
  const targetYear = month === 11 ? year + 1 : year;
  const targetMonth = month === 11 ? 0 : month + 1;

  // Last day of target month (day 0 of next month = last day of target month)
  const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
  const day = Math.min(anchorDay, lastDay);

  return new Date(targetYear, targetMonth, day);
}

/* ── Core functions ── */

export async function checkAndGetBudget(
  userId: number,
  now?: Date,
): Promise<{
  allowed: boolean;
  usedUsd: number;
  limitUsd: number;
  cycleStart: Date;
  cycleEnd: Date;
}> {
  const balance = await getOrCreateBalance(userId, DEFAULT_CYCLE_LIMIT_USD);

  const limitUsd = Number(balance.cycle_limit_usd);
  const anchorDay = balance.cycle_anchor.getDate();

  let cycleStart = balance.current_cycle_start;
  const today = now ?? getCurrentDate();

  // Lazy cycle reset: advance until next cycle start is after today
  let nextCycleStart = getNextCycleStart(cycleStart, anchorDay);
  while (nextCycleStart <= today) {
    await updateBalanceCycleReset(userId, nextCycleStart);
    cycleStart = nextCycleStart;
    nextCycleStart = getNextCycleStart(cycleStart, anchorDay);
  }

  // Re-read balance after potential resets
  const current = await getOrCreateBalance(userId);
  const usedUsd = Number(current.current_cycle_usage_usd);

  return {
    allowed: usedUsd < limitUsd,
    usedUsd,
    limitUsd,
    cycleStart,
    cycleEnd: nextCycleStart,
  };
}

type RecordTransactionParams = {
  userId: number;
  recordId?: number;
  step?: string;
} & (
  | { type: 'llm'; provider: string; model: string; inputTokens: number; outputTokens: number }
  | { type: 'embedding'; provider: string; model: string; inputTokens: number }
  | { type: 'crawler'; provider: string; url?: string }
);

export async function recordTransaction(params: RecordTransactionParams): Promise<void> {
  let amountUsd: number;
  let metadata: Record<string, any>;

  if (params.type === 'llm') {
    amountUsd = calculateLLMCost(params.provider, params.model, params.inputTokens, params.outputTokens);
    metadata = {
      model: params.model,
      input_tokens: params.inputTokens,
      output_tokens: params.outputTokens,
    };
  } else if (params.type === 'embedding') {
    amountUsd = calculateEmbeddingCost(params.provider, params.model, params.inputTokens);
    metadata = {
      model: params.model,
      input_tokens: params.inputTokens,
    };
  } else {
    amountUsd = calculateCrawlerCost(params.provider);
    metadata = params.url ? { url: params.url } : {};
  }

  await insertTransactionAndUpdateBalance({
    userId: params.userId,
    recordId: params.recordId ?? null,
    step: params.step ?? null,
    type: params.type,
    provider: params.provider,
    amountUsd,
    metadata: Object.keys(metadata).length > 0 ? metadata : null,
  });
}

export async function resetUserCycle(userId: number, newAnchorDate: Date): Promise<void> {
  await updateCycleAnchorAndReset(userId, newAnchorDate, newAnchorDate);
}
