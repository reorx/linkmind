/**
 * Logger: pino-based logging with optional file output.
 *
 * ENV:
 *   LOG_FILE — path to log file (JSON lines). Only written when set.
 *   LOG_LEVEL — log level (default: "info"). Set to "debug" for verbose output.
 *   LOG_FORMAT — "json" makes stdout raw pino JSON (one line per entry, for
 *     container logs / grep / jq). Anything else (or unset) keeps pino-pretty.
 *
 * Call initLogger() after dotenv.config() to pick up env vars.
 */

import pino from 'pino';
import pinoPretty from 'pino-pretty';
import fs from 'fs';
import path from 'path';

let _logger: pino.Logger | null = null;

function createLogger(): pino.Logger {
  const level = process.env.LOG_LEVEL || 'info';
  const logFile = process.env.LOG_FILE;

  // Stdout stream: raw JSON when opted in, pretty otherwise
  const stdoutStream = process.env.LOG_FORMAT === 'json' ? pino.destination(1) : pinoPretty({ colorize: true });

  if (!logFile) {
    return pino({ level }, stdoutStream);
  }

  // File stream (JSON lines)
  const absPath = path.resolve(logFile);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const fileStream = fs.createWriteStream(absPath, { flags: 'a' });

  const multistream = pino.multistream([
    { level: level as pino.Level, stream: stdoutStream },
    { level: level as pino.Level, stream: fileStream },
  ]);

  return pino({ level }, multistream);
}

/**
 * Initialize the logger. Must be called after dotenv.config().
 */
export function initLogger(): void {
  _logger = createLogger();
}

/**
 * Get the logger instance. Auto-initializes if not yet done.
 */
export const logger = new Proxy({} as pino.Logger, {
  get(_target, prop) {
    if (!_logger) {
      _logger = createLogger();
    }
    return (_logger as any)[prop];
  },
});
