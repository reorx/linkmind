/**
 * Hacker News summarization input budget derived from GPT-5.3-codex context window.
 *
 * Assumptions:
 * - Context window: 400k tokens
 * - Reserve 100k tokens for system/user wrappers, output, and retry overhead
 * - Average 1 token ~= 4 chars for English-heavy HN markdown
 */

const DEFAULT_GPT53_CODEX_CONTEXT_LIMIT_TOKENS = 400_000;
const DEFAULT_RESERVED_TOKENS = 100_000;
const DEFAULT_CHARS_PER_TOKEN = 4;

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parsePositiveNumber(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Max HN markdown chars allowed before summarize.
 *
 * Env overrides (optional):
 * - HN_SUMMARY_MARKDOWN_CHAR_LIMIT
 * - HN_SUMMARY_CONTEXT_LIMIT_TOKENS
 * - HN_SUMMARY_RESERVED_TOKENS
 * - HN_SUMMARY_CHARS_PER_TOKEN
 */
export function getHNSummaryMarkdownCharLimit(): number {
  const fixed = parsePositiveInt(process.env.HN_SUMMARY_MARKDOWN_CHAR_LIMIT);
  if (fixed) return fixed;

  const contextLimit =
    parsePositiveInt(process.env.HN_SUMMARY_CONTEXT_LIMIT_TOKENS) ?? DEFAULT_GPT53_CODEX_CONTEXT_LIMIT_TOKENS;
  const reserved = parsePositiveInt(process.env.HN_SUMMARY_RESERVED_TOKENS) ?? DEFAULT_RESERVED_TOKENS;
  const charsPerToken = parsePositiveNumber(process.env.HN_SUMMARY_CHARS_PER_TOKEN) ?? DEFAULT_CHARS_PER_TOKEN;

  const inputTokenBudget = Math.max(1_000, contextLimit - reserved);
  const chars = Math.floor(inputTokenBudget * charsPerToken);
  return Math.max(chars, 1_000);
}
