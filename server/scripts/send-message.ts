/**
 * Send a message with optional image to a user via the Telegram bot.
 *
 * Usage:
 *   pnpm tsx scripts/send-message.ts --user-id <id> --text "message" [--image /path/to/image.jpg]
 *
 * Examples:
 *   pnpm tsx scripts/send-message.ts --user-id 1 --text "Hello!"
 *   pnpm tsx scripts/send-message.ts --user-id 1 --text "Check this out" --image ./photo.jpg
 */

import 'dotenv/config';
import { Bot, InputFile } from 'grammy';
import { getDb } from '../src/db.js';
import { parseArgs } from 'util';
import { existsSync } from 'fs';

const db = getDb();

const { values } = parseArgs({
  options: {
    'user-id': { type: 'string', short: 'u' },
    text: { type: 'string', short: 't' },
    image: { type: 'string', short: 'i' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(`
Send a message with optional image to a user via the Telegram bot.

Usage:
  pnpm tsx scripts/send-message.ts --user-id <id> --text "message" [--image /path/to/image.jpg]

Options:
  -u, --user-id   User ID (from linkmind database)
  -t, --text      Message text (required)
  -i, --image     Path to image file (optional)
  -h, --help      Show this help
  `);
  process.exit(0);
}

const userId = values['user-id'];
const text = values.text;
const imagePath = values.image;

if (!userId || !text) {
  console.error('Error: --user-id and --text are required');
  console.error('Use --help for usage info');
  process.exit(1);
}

if (imagePath && !existsSync(imagePath)) {
  console.error(`Error: Image file not found: ${imagePath}`);
  process.exit(1);
}

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  console.error('Error: TELEGRAM_BOT_TOKEN not set in environment');
  process.exit(1);
}

async function main() {
  // Get user's telegram_id from database
  const user = await db
    .selectFrom('users')
    .select(['id', 'telegram_id', 'username', 'display_name'])
    .where('id', '=', Number(userId))
    .executeTakeFirst();

  if (!user) {
    console.error(`Error: User with id ${userId} not found`);
    process.exit(1);
  }

  console.log(`Sending to user: ${user.display_name || user.username || user.id} (telegram_id: ${user.telegram_id})`);

  const bot = new Bot(botToken);

  try {
    if (imagePath) {
      // Send photo with caption
      await bot.api.sendPhoto(user.telegram_id, new InputFile(imagePath), {
        caption: text,
      });
      console.log('✅ Photo message sent successfully!');
    } else {
      // Send text only
      await bot.api.sendMessage(user.telegram_id, text);
      console.log('✅ Text message sent successfully!');
    }
  } catch (err) {
    console.error('Failed to send message:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  process.exit(0);
}

main();
