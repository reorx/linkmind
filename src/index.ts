import dotenv from 'dotenv';
dotenv.config({ override: true });

import { initLogger, logger } from './logger.js';
import { getLLM } from './llm.js';
import { startBot } from './bot.js';
import { startWebServer } from './web.js';
import { startWorker } from './pipeline.js';

// Initialize logger after dotenv has loaded
initLogger();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  logger.fatal('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

const webPort = parseInt(process.env.WEB_PORT ?? '3456', 10);
const webBaseUrl = process.env.WEB_BASE_URL ?? `http://localhost:${webPort}`;

logger.info('🧠 LinkMind starting...');

// Initialize LLM provider (validates API keys)
const llm = getLLM();
logger.info({ llm: llm.name, web: webBaseUrl }, 'Config');

// Start web server
startWebServer(webPort);

// Start Telegram bot
startBot(token, webBaseUrl);

// Start Absurd durable execution worker
startWorker().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Worker start failed');
});

logger.info('🧠 LinkMind ready!');
