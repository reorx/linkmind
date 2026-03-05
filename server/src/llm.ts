/**
 * LLM abstraction layer.
 *
 * Provides a unified interface for chat completions across providers.
 * Switch provider via LLM_PROVIDER env var ("openai" | "gemini").
 */

import OpenAI from 'openai';
import { logger } from './logger.js';

const log = logger.child({ module: 'llm' });

/* ── Public types ── */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  /** Label for logging (e.g. "summary", "insight") */
  label?: string;
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface ChatResult {
  text: string;
  usage?: UsageInfo;
}

export interface EmbeddingResult {
  embedding: number[];
  usage?: {
    inputTokens: number;
    model: string;
  };
}

export interface LLMProvider {
  name: string;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult>;
}

/* ── Provider: OpenAI-compatible (Qwen via dashscope, etc.) ── */

function createOpenAIProvider(): LLMProvider {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
  });
  const model = process.env.OPENAI_DEFAULT_MODEL ?? 'qwen-plus';

  return {
    name: `openai/${model}`,
    async chat(messages, options = {}) {
      const startTime = Date.now();
      const label = options.label || 'chat';
      log.debug({ model, label, messages: messages.length }, `→ OpenAI: ${label}`);

      const response = await client.chat.completions.create({
        model,
        max_tokens: options.maxTokens ?? 2048,
        temperature: options.temperature,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        ...(options.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
      });

      const text = response.choices[0]?.message?.content || '';
      const elapsed = Date.now() - startTime;
      log.info({ model, label, elapsed: `${elapsed}ms`, responseLength: text.length }, `← OpenAI: ${label} done`);

      const usage: UsageInfo | undefined = response.usage
        ? {
            inputTokens: response.usage.prompt_tokens ?? 0,
            outputTokens: response.usage.completion_tokens ?? 0,
            model,
          }
        : undefined;

      return { text, usage };
    },
  };
}

/* ── Embedding ── */

const EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER ?? 'dashscope';

function getEmbeddingConfig(): { client: OpenAI; model: string; provider: string } {
  switch (EMBEDDING_PROVIDER) {
    case 'voyage': {
      const apiKey = process.env.VOYAGE_API_KEY;
      if (!apiKey) throw new Error('VOYAGE_API_KEY is required when EMBEDDING_PROVIDER=voyage');
      return {
        client: new OpenAI({
          apiKey,
          baseURL: 'https://api.voyageai.com/v1',
        }),
        model: process.env.EMBEDDING_MODEL ?? 'voyage-4',
        provider: 'voyage',
      };
    }
    case 'dashscope':
    default:
      return {
        client: new OpenAI({
          apiKey: process.env.OPENAI_API_KEY,
          baseURL: process.env.OPENAI_BASE_URL,
        }),
        model: process.env.EMBEDDING_MODEL ?? 'text-embedding-v3',
        provider: 'dashscope',
      };
  }
}

/**
 * Create an embedding vector for the given text.
 * Provider is selected via EMBEDDING_PROVIDER env var ("dashscope" | "voyage").
 * Returns a 1024-dimensional vector by default.
 */
export async function createEmbedding(text: string): Promise<EmbeddingResult> {
  const { client, model, provider } = getEmbeddingConfig();

  const startTime = Date.now();
  log.debug({ provider, model, textLength: text.length }, '→ Embedding');

  const response = await client.embeddings.create({
    model,
    input: text,
  });

  const embedding = response.data[0]?.embedding;
  if (!embedding) {
    throw new Error('Embedding API returned empty result');
  }

  const elapsed = Date.now() - startTime;
  log.info({ provider, model, elapsed: `${elapsed}ms`, dimensions: embedding.length }, '← Embedding done');

  const usage = response.usage ? { inputTokens: response.usage.prompt_tokens ?? 0, model } : undefined;

  return { embedding, usage };
}

/* ── Provider: Gemini (direct REST API) ── */

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function createGeminiProvider(): LLMProvider {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required when using Gemini provider');
  const model = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash';

  return {
    name: `gemini/${model}`,
    async chat(messages, options = {}) {
      const startTime = Date.now();
      const label = options.label || 'chat';
      log.debug({ model, label, messages: messages.length }, `→ Gemini: ${label}`);

      // Convert ChatMessage[] to Gemini format
      // Gemini uses "contents" with "role" (user/model) and system instruction separately
      const systemParts: string[] = [];
      const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

      for (const msg of messages) {
        if (msg.role === 'system') {
          systemParts.push(msg.content);
        } else {
          contents.push({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }],
          });
        }
      }

      const body: Record<string, any> = {
        contents,
        generationConfig: {
          temperature: options.temperature ?? 0.3,
          maxOutputTokens: options.maxTokens ?? 2048,
          ...(options.jsonMode ? { responseMimeType: 'application/json' } : {}),
        },
      };

      if (systemParts.length > 0) {
        body.systemInstruction = {
          parts: systemParts.map((text) => ({ text })),
        };
      }

      const url = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.text();
        log.error({ status: res.status, label, error: err }, `← Gemini: ${label} error`);
        throw new Error(`Gemini ${label} error (${res.status}): ${err}`);
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

      if (!text) {
        log.error({ label, response: data }, `← Gemini: ${label} empty response`);
        throw new Error(`Gemini ${label}: empty response`);
      }

      const elapsed = Date.now() - startTime;
      log.info({ model, label, elapsed: `${elapsed}ms`, responseLength: text.length }, `← Gemini: ${label} done`);

      const usageMeta = data?.usageMetadata;
      const usage: UsageInfo | undefined = usageMeta
        ? {
            inputTokens: usageMeta.promptTokenCount ?? 0,
            outputTokens: usageMeta.candidatesTokenCount ?? 0,
            model,
          }
        : undefined;

      return { text, usage };
    },
  };
}

/* ── generateObject: structured JSON output with retry ── */

export interface GenerateObjectOptions<T> extends ChatOptions {
  /** Transform and validate the parsed JSON. Throw on invalid shape. */
  parse: (raw: unknown) => T;
  /** Max retry attempts when JSON parsing fails (default: 1) */
  maxRetries?: number;
}

/**
 * Call LLM with jsonMode, parse the response as JSON, validate with `parse()`.
 * On parse failure: log warning, feed the error back to LLM for one retry.
 * If retry also fails, throw the error (caller should let it propagate to fail the record).
 */
export async function generateObject<T>(
  messages: ChatMessage[],
  options: GenerateObjectOptions<T>,
): Promise<{ result: T; usage?: UsageInfo }> {
  const { parse, maxRetries = 1, ...chatOptions } = options;
  const label = chatOptions.label || 'generateObject';

  const tryParse = (text: string): T => {
    // Strip markdown code fences if present
    const cleaned = text
      .replace(/^```(?:json)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .trim();
    const parsed = JSON.parse(cleaned);
    return parse(parsed);
  };

  // Build a mutable copy of messages for potential retry
  const msgs = [...messages];

  // Accumulate usage across retries
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let usageModel: string | undefined;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const chatResult = await getLLM().chat(msgs, { ...chatOptions, jsonMode: true });

    if (chatResult.usage) {
      totalInputTokens += chatResult.usage.inputTokens;
      totalOutputTokens += chatResult.usage.outputTokens;
      usageModel = chatResult.usage.model;
    }

    try {
      const result = tryParse(chatResult.text);
      const usage: UsageInfo | undefined = usageModel
        ? { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, model: usageModel }
        : undefined;
      return { result, usage };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < maxRetries) {
        log.warn(
          { label, attempt: attempt + 1, error: lastError.message, rawText: chatResult.text.slice(0, 500) },
          `[${label}] JSON parse failed, retrying with error feedback`,
        );
        // Feed the error back to LLM so it can fix its output
        msgs.push(
          { role: 'assistant', content: chatResult.text },
          {
            role: 'user',
            content: `Your previous response could not be parsed as valid JSON.\nError: ${lastError.message}\nPlease output the corrected JSON only, with no extra text or markdown fences.`,
          },
        );
      } else {
        log.error(
          { label, attempts: attempt + 1, error: lastError.message, rawText: chatResult.text.slice(0, 500) },
          `[${label}] JSON parse failed after all retries`,
        );
      }
    }
  }

  throw lastError!;
}

/* ── Factory ── */

let _provider: LLMProvider | null = null;

export function getLLM(): LLMProvider {
  if (_provider) return _provider;

  const providerName = process.env.LLM_PROVIDER ?? 'openai';

  switch (providerName) {
    case 'gemini':
      _provider = createGeminiProvider();
      break;
    case 'openai':
    default:
      _provider = createOpenAIProvider();
      break;
  }

  log.info({ provider: _provider.name }, 'LLM provider initialized');
  return _provider;
}
