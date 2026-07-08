/**
 * LLM provider tests: max_tokens handling and finish_reason observability.
 *
 * Background: commit 2b78b0a removed maxTokens from all call sites to prevent
 * truncation, but llm.ts kept a hidden `?? 2048` default so the cap silently
 * remained. These tests pin the fixed behavior: no cap unless explicitly set,
 * and finish_reason surfaced for truncation detection.
 *
 * Usage:
 *   cd server && npx vitest run src/__tests__/llm.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: createMock } };
    embeddings = { create: vi.fn() };
  },
}));

process.env.LLM_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_DEFAULT_MODEL = 'qwen-plus';

import { initLogger } from '../logger.js';
initLogger();

import { getLLM } from '../llm.js';

function fakeResponse(overrides: Record<string, any> = {}) {
  return {
    choices: [{ message: { content: 'hello' }, finish_reason: 'stop', ...overrides }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

describe('OpenAI provider', () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue(fakeResponse());
  });

  it('omits max_tokens when maxTokens option is not set', async () => {
    await getLLM().chat([{ role: 'user', content: 'hi' }], { label: 'insight' });

    const params = createMock.mock.calls[0][0];
    expect('max_tokens' in params).toBe(false);
  });

  it('passes max_tokens through when explicitly set', async () => {
    await getLLM().chat([{ role: 'user', content: 'hi' }], { maxTokens: 512 });

    const params = createMock.mock.calls[0][0];
    expect(params.max_tokens).toBe(512);
  });

  it('surfaces finish_reason in the chat result', async () => {
    createMock.mockResolvedValue(fakeResponse({ finish_reason: 'length' }));

    const result = await getLLM().chat([{ role: 'user', content: 'hi' }]);

    expect(result.finishReason).toBe('length');
    expect(result.text).toBe('hello');
  });

  it('reports usage tokens', async () => {
    const result = await getLLM().chat([{ role: 'user', content: 'hi' }]);

    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, model: 'qwen-plus' });
  });
});
