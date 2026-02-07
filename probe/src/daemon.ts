/**
 * SSE client + event processing + daemon lifecycle.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { writePid, removePid, LOG_PATH, STATE_DIR } from './config.js';
import { scrapeTwitter, scrapeWeb } from './scraper.js';
import type { ScrapeRequestEvent, ScrapeResultPayload } from './types.js';

const HEARTBEAT_TIMEOUT = 60_000; // ms

function log(level: string, msg: string): void {
  const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
  const line = `${ts} [${level}] ${msg}`;
  console.error(line);
}

async function uploadResult(config: Config, payload: ScrapeResultPayload): Promise<void> {
  const resp = await fetch(`${config.api_base}/api/probe/receive_result`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (resp.ok) {
    log('INFO', `Result uploaded for ${payload.event_id}`);
  } else {
    log('ERROR', `Failed to upload result for ${payload.event_id}: ${resp.status} ${await resp.text()}`);
  }
}

async function processEvent(config: Config, event: ScrapeRequestEvent): Promise<void> {
  const { event_id, url, url_type } = event;
  log('INFO', `Processing event ${event_id}: ${url_type} ${url}`);

  let payload: ScrapeResultPayload;
  try {
    let data;
    if (url_type === 'twitter') {
      data = await scrapeTwitter(url);
    } else if (url_type === 'web') {
      data = await scrapeWeb(url);
    } else {
      throw new Error(`Unknown url_type: ${url_type}`);
    }

    payload = { event_id, success: true, data };
  } catch (e: any) {
    log('ERROR', `Scrape failed for ${event_id}: ${e.message}`);
    payload = { event_id, success: false, error: e.message };
  }

  await uploadResult(config, payload);
}

/**
 * Parse SSE stream from a fetch ReadableStream.
 * Calls onEvent for each complete event.
 */
async function readSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (eventType: string, data: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Split on double newline to get complete events
    const parts = buffer.split('\n\n');
    // Last part is incomplete — keep in buffer
    buffer = parts.pop()!;

    for (const block of parts) {
      if (!block.trim()) continue;

      let eventType = 'message';
      let data = '';

      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          data = line.slice(6);
        } else if (line.startsWith('data:')) {
          data = line.slice(5);
        }
      }

      onEvent(eventType, data);
    }
  }
}

/**
 * Main SSE event loop with reconnection.
 */
async function eventLoop(config: Config, signal: AbortSignal): Promise<void> {
  let backoff = 5000;
  const maxBackoff = 60000;

  while (!signal.aborted) {
    try {
      log('INFO', `Connecting to SSE at ${config.api_base}/api/probe/subscribe_events`);

      const resp = await fetch(`${config.api_base}/api/probe/subscribe_events`, {
        headers: {
          Authorization: `Bearer ${config.access_token}`,
          Accept: 'text/event-stream',
        },
        signal,
      });

      if (!resp.ok) {
        log('ERROR', `SSE connection failed: ${resp.status} ${resp.statusText}`);
        throw new Error(`HTTP ${resp.status}`);
      }

      log('INFO', 'SSE connected');
      backoff = 5000; // reset on successful connect

      let lastEventTime = Date.now();

      // Heartbeat checker
      const heartbeatCheck = setInterval(() => {
        if (Date.now() - lastEventTime > HEARTBEAT_TIMEOUT) {
          log('WARN', `No events for ${HEARTBEAT_TIMEOUT / 1000}s, reconnecting...`);
          // Abort this specific connection by closing the reader
          reader.cancel();
          clearInterval(heartbeatCheck);
        }
      }, 10000);

      const reader = resp.body!.getReader();

      try {
        await readSSE(reader, (eventType, data) => {
          lastEventTime = Date.now();

          if (eventType === 'ping') {
            return;
          }

          if (eventType === 'scrape_request') {
            const eventData: ScrapeRequestEvent = JSON.parse(data);
            // Process in background
            processEvent(config, eventData).catch((e) => {
              log('ERROR', `processEvent failed: ${e.message}`);
            });
            return;
          }

          log('WARN', `Unknown SSE event: ${eventType}`);
        });
      } finally {
        clearInterval(heartbeatCheck);
      }
    } catch (e: any) {
      if (signal.aborted) break;
      log('WARN', `SSE connection lost: ${e.message}`);
    }

    if (signal.aborted) break;

    log('INFO', `Reconnecting in ${backoff / 1000}s...`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, backoff);
      // If aborted during wait, resolve immediately
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    backoff = Math.min(backoff * 2, maxBackoff);
  }
}

/**
 * Run in foreground mode: write PID, handle signals, run SSE loop.
 */
export function runForeground(config: Config): void {
  writePid();

  const ac = new AbortController();

  const cleanup = () => {
    log('INFO', 'Shutting down...');
    ac.abort();
    removePid();
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  log('INFO', `linkmind-probe running (pid ${process.pid})`);

  eventLoop(config, ac.signal)
    .then(() => {
      log('INFO', 'linkmind-probe stopped');
      process.exit(0);
    })
    .catch((e) => {
      log('ERROR', `Event loop error: ${e.message}`);
      removePid();
      process.exit(1);
    });
}

/**
 * Run as background daemon: spawn a detached child running in foreground mode.
 * Returns the child PID, or null if it exited immediately.
 */
export async function runDaemon(config: Config): Promise<number | null> {
  fs.mkdirSync(STATE_DIR, { recursive: true });

  const logFd = fs.openSync(LOG_PATH, 'a');

  // Find the tsx binary
  const tsxBin = path.resolve(import.meta.dirname, '../node_modules/.bin/tsx');

  const child = spawn(tsxBin, [path.resolve(import.meta.dirname, 'cli.ts'), 'run', '--foreground'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });

  child.unref();
  fs.closeSync(logFd);

  // Wait a bit and check if it exited
  return new Promise<number | null>((resolve) => {
    setTimeout(() => {
      if (child.exitCode !== null) {
        resolve(null);
      } else {
        resolve(child.pid!);
      }
    }, 300);
  });
}
