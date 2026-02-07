# linkmind-probe: Node.js Implementation Plan

## Why Node.js Instead of Python

- Direct integration with `vibe-reader` (npm package, when available) and `defuddle`
- Share scraper code with the main linkmind server (reuse `scraper.ts` logic)
- Same runtime/toolchain as the main project (TypeScript, pnpm, tsx)
- Single `node_modules` for Playwright — no separate Python venv

## Project Structure

```
linkmind-probe/                    # Replace the Python version at /Users/reorx/Code/linkmind-probe/
├── package.json
├── tsconfig.json
├── .nvmrc                         # v22
├── src/
│   ├── cli.ts                     # CLI entry point (commander)
│   ├── daemon.ts                  # SSE client + event dispatch + daemon lifecycle
│   ├── auth.ts                    # Device authorization flow
│   ├── config.ts                  # Config + PID management (~/.linkmind-probe/)
│   ├── scraper.ts                 # Unified scraper (Twitter via bird, web via Playwright+Defuddle)
│   └── types.ts                   # Shared types (ScrapeData, SSE events)
└── tests/
```

## Dependencies

```json
{
  "dependencies": {
    "commander": "^13.0.0",
    "defuddle": "^0.6.6",
    "playwright": "^1.50.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  }
}
```

Key decisions:
- **commander** for CLI (lightweight, zero-dep, good TypeScript support)
- **Native `fetch`** for HTTP (Node 22 has stable fetch, no need for extra deps)
- **No SSE library** — parse SSE manually from fetch ReadableStream (simple, no deps)
- **playwright + defuddle** — same as main linkmind server
- **No eventsource polyfill** — the native EventSource API doesn't support custom headers (Authorization), so we use fetch + manual SSE parsing

## Module Details

### 1. `types.ts` — Shared Types

```typescript
/** Matches the ScrapeData interface on the server side (pipeline.ts) */
export interface ScrapeData {
  title?: string;
  markdown: string;
  og_title?: string;
  og_description?: string;
  og_image?: string;
  og_site_name?: string;
  og_type?: string;
  raw_media?: Array<{ type: string; url: string }>;
}

/** SSE scrape_request event payload from server */
export interface ScrapeRequestEvent {
  event_id: string;
  url: string;
  url_type: 'twitter' | 'web';
  link_id: number;
  created_at: string;
}

/** Result payload sent back to server */
export interface ScrapeResultPayload {
  event_id: string;
  success: boolean;
  data?: ScrapeData;
  error?: string;
}
```

### 2. `config.ts` — Config + PID Management

State directory: `~/.linkmind-probe/`

```
~/.linkmind-probe/
├── config.json      # { api_base, access_token, user_id }
├── probe.pid        # PID file
└── probe.log        # Log file (daemon mode)
```

Functions:
- `loadConfig()` / `saveConfig(config)` — read/write `config.json`
- `writePid()` / `removePid()` / `readPid()` — PID file management
- `isRunning()` — check if PID is alive via `process.kill(pid, 0)`
- `stopDaemon()` — send SIGTERM to PID

Config interface:
```typescript
interface Config {
  api_base: string;
  access_token: string;
  user_id: string;
}
```

Same structure as the Python version. Config files are compatible — if the user already ran the Python `login`, the Node.js version can read the same `config.json`.

### 3. `auth.ts` — Device Authorization Flow

Port the Python `auth.py` logic to TypeScript:

1. `POST {api_base}/api/auth/device` → get `{ device_code, user_code, verification_uri, expires_in, interval }`
2. Print user_code to terminal, open browser via `open` command (macOS) or `xdg-open` (Linux)
3. Poll `POST {api_base}/api/auth/token` with `{ device_code }` every `interval` seconds
4. Handle: 400 `authorization_pending` → keep polling, 400 `expired_token` → fail, 200 → save token

Use native `fetch()` for HTTP. Use `child_process.exec` for opening browser (`open <url>` on macOS).

### 4. `scraper.ts` — Unified Scraper

Two modes, returning `ScrapeData`:

**Twitter (bird CLI):**
- Port existing Python `scrape_twitter()` to TypeScript
- `execFile('bird', ['read', '--json', '--cookie-source', 'chrome', url])`
- Parse JSON → build markdown (same format as server's `scraper.ts:scrapeTwitter()`)
- Can directly reuse/adapt the server's `scrapeTwitter()` function since it's the same language now

**Web (Playwright + Defuddle):**
- Port directly from server's `scraper.ts:scrapeUrl()` — it's already TypeScript
- Launch Playwright headless → navigate → extract OG metadata → Defuddle → htmlToSimpleMarkdown
- Major advantage of Node.js: we can literally copy the `scrapeUrl()` and `htmlToSimpleMarkdown()` functions
- When `vibe-reader` becomes available, swap in here

Both return `ScrapeData` (matching server's interface).

### 5. `daemon.ts` — SSE Client + Event Processing

**SSE client using native fetch:**

```typescript
async function connectSSE(config: Config): Promise<void> {
  const res = await fetch(`${config.api_base}/api/probe/subscribe_events`, {
    headers: {
      'Authorization': `Bearer ${config.access_token}`,
      'Accept': 'text/event-stream',
    },
  });

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE: split on \n\n, extract event: and data: fields
    // ... (standard SSE parsing)
  }
}
```

SSE parsing logic:
- Accumulate text in buffer
- Split on `\n\n` to get complete events
- For each event block, parse `event:` and `data:` lines
- Dispatch: `ping` → reset heartbeat timer, `scrape_request` → spawn scrape task

**Event processing:**
- On `scrape_request`: call appropriate scraper based on `url_type`
- Upload result via `POST /api/probe/receive_result`
- Process events concurrently (don't block SSE reading)

**Reconnection:**
- Exponential backoff: 5s → 10s → 20s → 40s → 60s (max)
- Reset backoff on successful connection
- Heartbeat timeout: 60s without any event → reconnect

**Daemon lifecycle:**
- `runForeground(config)`: write PID, register SIGTERM/SIGINT handlers, run SSE loop
- `runDaemon(config)`: spawn `node --import tsx src/cli.ts run --foreground` as detached child, redirect stdout/stderr to log file

### 6. `cli.ts` — CLI Entry Point

Using `commander`:

```
linkmind-probe login --api-base <url>   # Device auth flow
linkmind-probe run                       # Start daemon (background)
linkmind-probe run --foreground          # Run in foreground
linkmind-probe stop                      # Stop daemon (SIGTERM)
linkmind-probe status                    # Check if running
linkmind-probe logout                    # Clear token
```

Entry in package.json:
```json
{
  "bin": {
    "linkmind-probe": "./src/cli.ts"
  }
}
```

With a shebang `#!/usr/bin/env -S node --import tsx` at top of `cli.ts`, or use tsx in the bin script.

Actually, for simpler distribution: use tsx as the runner:
```json
{
  "bin": {
    "linkmind-probe": "./bin/linkmind-probe.js"
  }
}
```
Where `bin/linkmind-probe.js`:
```javascript
#!/usr/bin/env node
import('tsx/esm/api').then(({ register }) => {
  register();
  import('../src/cli.ts');
});
```

Or simpler — just use tsx directly in development (`npx tsx src/cli.ts`) and worry about packaging later.

## Implementation Order

### Step 1: Project Setup + Config + CLI skeleton
- Init project with pnpm, tsconfig, .nvmrc
- Implement `config.ts` (PID management, config read/write)
- Implement `cli.ts` with all commands wired up (stubs for auth/daemon)
- Verify `linkmind-probe status` works

### Step 2: Auth Flow
- Implement `auth.ts` (device auth with native fetch)
- Wire to `linkmind-probe login`
- Test against running linkmind server

### Step 3: Scraper
- Copy and adapt `scrapeTwitter()` from server's `scraper.ts`
- Copy and adapt `scrapeUrl()` + `htmlToSimpleMarkdown()` for web scraping
- Unify into single `scraper.ts` returning `ScrapeData`

### Step 4: Daemon + SSE
- Implement SSE parser (native fetch + ReadableStream)
- Implement event loop with reconnection
- Implement result upload
- Wire daemon mode (foreground + background)
- Test end-to-end: send Twitter URL via bot → probe receives event → scrapes → uploads result → pipeline resumes

## Key Differences from Python Version

| Aspect | Python | Node.js |
|--------|--------|---------|
| CLI | click | commander |
| HTTP | httpx | native fetch |
| SSE | httpx-sse | manual parse on fetch ReadableStream |
| Web scraper | subprocess vibe-reader | Playwright + Defuddle (in-process) |
| Twitter scraper | subprocess bird | subprocess bird (same) |
| Daemon | subprocess.Popen | child_process.spawn (detached) |
| Package | pyproject.toml + uv | package.json + pnpm |
| Code sharing | none | can reuse server's scraper.ts directly |

## Server-Side Changes

**No changes needed.** The server-side code (web.ts, pipeline.ts, db.ts) already has:
- Device auth endpoints (`/api/auth/device`, `/api/auth/token`)
- SSE endpoint (`/api/probe/subscribe_events`) with proper `event: <type>\ndata: <json>\n\n` format
- Result endpoint (`/api/probe/receive_result`)
- Pipeline integration (`handleProbeResult`, `waiting_probe` status)
- DB tables (migration `003_probe_tables.sql`)

The Node.js probe is a drop-in replacement for the Python probe — same API contract.

## Cleanup

Delete the Python project at `/Users/reorx/Code/linkmind-probe/` before starting.
