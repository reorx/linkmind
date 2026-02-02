# LinkMind

Link collector + deep analysis agent via Telegram.

Send a URL to the Telegram bot → it scrapes, analyzes (LLM), finds related notes & links, and serves a permanent web page.

## Setup

```bash
pnpm install
cp .env.example .env  # then fill in your keys
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | Telegram bot token from @BotFather |
| `LLM_PROVIDER` | | `openai` (default) or `gemini` |
| `OPENAI_API_KEY` | when openai | API key (dashscope, OpenAI, etc.) |
| `OPENAI_BASE_URL` | when openai | API base URL |
| `OPENAI_DEFAULT_MODEL` | | Model name (default: `qwen-plus`) |
| `GEMINI_API_KEY` | when gemini | Google AI Studio API key |
| `GEMINI_MODEL` | | Gemini model (default: `gemini-2.0-flash`) |
| `WEB_PORT` | | Web server port (default: `3456`) |
| `WEB_BASE_URL` | | Public URL for permanent links |
| `QMD_NOTES_COLLECTION` | | qmd collection name for notes (default: `notes`) |
| `QMD_LINKS_COLLECTION` | | qmd collection name for links (default: `links`) |
| `QMD_LINKS_PATH` | | Filesystem path for exported link markdown files |
| `LOG_LEVEL` | | Pino log level (default: `info`) |
| `LOG_FILE` | | Log file path |

## Development

```bash
# Run the service (Telegram bot + web server)
pnpm dev

# Type check
pnpm typecheck
```

## Testing

### Test pipeline (scrape + LLM)

```bash
# Full pipeline: scrape the URL, then test LLM analysis
npx tsx src/test-pipeline.ts <url>

# Only test scraping (no LLM calls)
npx tsx src/test-pipeline.ts <url> --scrape-only

# Only test LLM (uses placeholder content if no scrape)
npx tsx src/test-pipeline.ts <url> --analyze-only
```

Example:
```bash
npx tsx src/test-pipeline.ts "https://example.com/article" --scrape-only
```

## Architecture

```
Telegram Bot (bot.ts)
    ↓
Pipeline (pipeline.ts)
    ├── [scrape]  Playwright + Defuddle (scraper.ts)
    ├── [analyze] LLM summary + insight (agent.ts → llm.ts)
    │     └── qmd search for related notes/links (search.ts)
    └── [export]  Markdown file export (export.ts)
    ↓
Web Server (web.ts)
    ├── /           Timeline homepage
    ├── /link/:id   Link detail page (two-column layout)
    └── /note       Note viewer (via qmd get)
```

### LLM Abstraction (`src/llm.ts`)

Providers are swappable via `LLM_PROVIDER` env var:
- **`openai`** — OpenAI-compatible API (Qwen via dashscope, OpenAI, etc.)
- **`gemini`** — Google Gemini REST API (supports system instructions + JSON mode)

Business code (`agent.ts`) calls `getLLM().chat(messages, options)` and doesn't know which provider is active.
