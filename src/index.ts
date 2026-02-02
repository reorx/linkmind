import dotenv from "dotenv";
dotenv.config({ override: true });

import { initLogger, logger } from "./logger.js";
import { startBot } from "./bot.js";
import { startWebServer } from "./web.js";

// Initialize logger after dotenv has loaded
initLogger();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  logger.fatal("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

if (!process.env.OPENAI_API_KEY) {
  logger.fatal("OPENAI_API_KEY is required");
  process.exit(1);
}

const webPort = parseInt(process.env.WEB_PORT ?? "3456", 10);
const webBaseUrl = process.env.WEB_BASE_URL ?? `http://localhost:${webPort}`;

logger.info("🧠 LinkMind starting...");
logger.info({ model: process.env.OPENAI_DEFAULT_MODEL ?? "qwen-plus", web: webBaseUrl }, "Config");

// Start web server
startWebServer(webPort);

// Start Telegram bot
startBot(token, webBaseUrl);

logger.info("🧠 LinkMind ready!");
