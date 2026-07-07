---
created: 2026-03-11
tags:
  - insight
  - llm
  - thinking
  - gemini
  - footnotes
  - rendering
---

# Plan: Insight Enhancement — Thinking Mode + Footnote References

## Background

The insight step generates a brief analysis of a saved link from the user's perspective, referencing related previously-saved links found via vector search. Currently:

- Uses plain LLM completion (no thinking/reasoning), which limits the model's ability to judge relevance
- Passes max 5 related records (filtered by score ≥ 0.65 from top 10 searched)
- Related links are sometimes force-included even when not genuinely relevant
- No structured way to reference which related links were actually used in the insight text

## Goals

1. **Enable thinking mode** for insight generation to improve relevance judgement
2. **Increase related context** — pass up to 10 related records to give the LLM more material to selectively reference
3. **Footnote references** — LLM outputs inline `[^rID]` markers for related links it actually uses; rendering layer converts these to platform-appropriate format

## Production Context

- **LLM Provider**: Gemini (`gemini-3-flash-preview`)
- **Thinking API**: Gemini REST API `thinkingConfig` field
- **Fallback provider**: OpenAI-compatible (Qwen via DashScope) — thinking support via `enable_thinking` parameter (lower priority)

## Implementation Plan

### 1. Add thinking support to Gemini provider (`server/src/llm.ts`)

- Add `thinking?: boolean` to `ChatOptions` interface
- In `createGeminiProvider.chat()`, when `options.thinking` is true, add to request body:
  ```json
  {
    "generationConfig": {
      "thinkingConfig": { "thinkingBudget": 0 }
    }
  }
  ```
  Note: `thinkingBudget: 0` means "let the model decide". We can tune this later.
  Ref: https://ai.google.dev/gemini-api/docs/thinking
- Ensure thinking tokens are captured in usage if the API returns them (for cost tracking)
- OpenAI provider: skip for now, can add Qwen thinking support later if needed

### 2. Increase related records passed to insight (`server/src/pipeline.ts`)

- Change `RELATED_MAX_COUNT` from `5` to `10`
- Consider lowering `RELATED_SCORE_THRESHOLD` slightly (e.g. `0.55`) to allow more candidates through — the LLM with thinking enabled will be better at filtering irrelevant ones
- Keep `searchRelatedRecords` search count at 20 (currently searches 10, need to increase)

### 3. Update insight prompt (`server/src/prompts.ts`)

Update `INSIGHT_SYSTEM_PROMPT` to:
- Instruct the LLM to be selective — explicitly say "only reference links you find genuinely related"
- Define footnote format: when referencing a related link, use `[^rID]` where ID is the record's actual ID number
- Do NOT output a footnote definitions section at the bottom
- Increase related link summary truncation from 100 chars to ~200 chars (more context for better judgement)

Update `buildInsightUserPrompt` to:
- Include record ID in each related link entry so the LLM knows which ID to use
- Format: `- [ID:42] [Title](url) (相似度: 0.78): summary...`

### 4. Enable thinking in insight generation (`server/src/agent.ts`)

- In `generateInsight()`, pass `thinking: true` to `getLLM().chat()`:
  ```ts
  const chatResult = await getLLM().chat(
    [
      { role: 'system', content: INSIGHT_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { label: 'insight', temperature: 0.1, thinking: true },
  );
  ```

### 5. Footnote rendering — Telegram (`server/src/bot.ts`)

- After insight is generated, post-process the text before sending to Telegram
- Create a utility function `renderInsightForTelegram(insight: string): string`:
  - Find all `[^rID]` patterns
  - Assign sequential superscript numbers: `[^r42]` → `¹`, `[^r87]` → `²`, etc.
  - Unicode superscript digits: `⁰¹²³⁴⁵⁶⁷⁸⁹`
  - Append a "References" section at the bottom listing each number → link title + URL
  - Or: since related links are already rendered separately in the Telegram message, just do the superscript conversion without appending references

### 6. Footnote rendering — Web (`server/src/routes/pages.ts` or EJS templates)

- Create a utility function `renderInsightForWeb(insight: string): string`:
  - Find all `[^rID]` patterns
  - Replace with `<a href="/links/ID" class="footnote-ref"><sup>N</sup></a>` where N is sequential
  - Add tooltip with the record title (fetch from DB or pass in context)
  - Style the superscript links appropriately in CSS

### 7. Shared footnote utilities (`core/` or `server/src/`)

- Create `server/src/insight-render.ts` (or in core if needed by probe):
  - `parseFootnoteRefs(text: string): Array<{ match: string, recordId: number, index: number }>` — extract all `[^rID]` references and assign sequential indices
  - `renderFootnoteTelegram(text: string): string` — superscript conversion
  - `renderFootnoteWeb(text: string): string` — HTML link conversion
- Keep rendering logic centralized so both bot and web use the same parsing

## File Changes Summary

| File | Change |
|------|--------|
| `server/src/llm.ts` | Add `thinking` to ChatOptions, implement in Gemini provider |
| `server/src/pipeline.ts` | Increase RELATED_MAX_COUNT to 10, increase search count to 20, optionally lower threshold |
| `server/src/prompts.ts` | Update insight prompts for selective usage + `[^rID]` footnote format |
| `server/src/agent.ts` | Pass `thinking: true` in generateInsight |
| `server/src/insight-render.ts` | New file — footnote parsing + rendering utilities |
| `server/src/bot.ts` | Use `renderFootnoteTelegram()` before sending insight messages |
| `server/src/routes/pages.ts` or templates | Use `renderFootnoteWeb()` when rendering insight on web |

## Testing

- Unit tests for footnote parsing/rendering utilities (`insight-render.ts`)
- Test with various edge cases: no footnotes, multiple refs to same record, record IDs with many digits
- Manual test: run pipeline on a link with known related records, verify thinking improves selectivity
- Compare before/after insight quality on a few real examples

## Open Questions

- Should `NOTE_INSIGHT_SYSTEM_PROMPT` (for notes) get the same treatment? (Probably yes, but can do in a follow-up)
- Exact `thinkingBudget` value — start with `0` (model decides), tune based on latency/cost observations
- Whether to lower `RELATED_SCORE_THRESHOLD` — start conservative at `0.60` and see if it helps
