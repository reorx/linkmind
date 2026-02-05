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

export interface LLMProvider {
  name: string;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
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
      return text;
    },
  };
}

/* ── Embedding ── */

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'text-embedding-v3';

/**
 * Create an embedding vector for the given text using DashScope's text-embedding API.
 * Returns a 1024-dimensional vector (text-embedding-v3 default).
 */
export async function createEmbedding(text: string): Promise<number[]> {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
  });

  const startTime = Date.now();
  log.debug({ model: EMBEDDING_MODEL, textLength: text.length }, '→ Embedding');

  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });

  const embedding = response.data[0]?.embedding;
  if (!embedding) {
    throw new Error('Embedding API returned empty result');
  }

  const elapsed = Date.now() - startTime;
  log.info({ model: EMBEDDING_MODEL, elapsed: `${elapsed}ms`, dimensions: embedding.length }, '← Embedding done');

  return embedding;
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
      return text;
    },
  };
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
