import dotenv from "dotenv";
dotenv.config({ override: true });

import { startBot } from "./bot.js";
import { startWebServer } from "./web.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Error: TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

if (!process.env.OPENAI_API_KEY) {
  console.error("Error: OPENAI_API_KEY is required");
  process.exit(1);
}

const webPort = parseInt(process.env.WEB_PORT ?? "3456", 10);
const webBaseUrl = process.env.WEB_BASE_URL ?? `http://localhost:${webPort}`;

console.log("🧠 LinkMind starting...");
console.log(`  Model: ${process.env.OPENAI_DEFAULT_MODEL ?? "qwen-plus"}`);
console.log(`  Web:   ${webBaseUrl}`);

// Start web server
startWebServer(webPort);

// Start Telegram bot
startBot(token, webBaseUrl);

console.log("🧠 LinkMind ready!");
