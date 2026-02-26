/**
 * Generate a login link for local testing (bypasses Telegram bot).
 * Usage: npx tsx scripts/gen-login-link.ts <user_id>
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import jwt from 'jsonwebtoken';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const WEB_PORT = process.env.WEB_PORT || '3456';

if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}
if (!JWT_SECRET) {
  console.error('JWT_SECRET not set');
  process.exit(1);
}

const userId = parseInt(process.argv[2], 10);
if (isNaN(userId)) {
  console.error('Usage: npx tsx scripts/gen-login-link.ts <user_id>');
  process.exit(1);
}

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    const result = await pool.query('SELECT id, telegram_id, username, display_name, status FROM users WHERE id = $1', [
      userId,
    ]);
    if (result.rows.length === 0) {
      console.error(`User not found: id=${userId}`);
      process.exit(1);
    }

    const user = result.rows[0];
    console.log(
      `User: ${user.display_name || user.username} (id=${user.id}, telegram_id=${user.telegram_id}, status=${user.status})\n`,
    );

    const loginToken = jwt.sign({ userId: user.id, telegramId: user.telegram_id }, JWT_SECRET!, { expiresIn: '1h' });
    const url = `http://localhost:${WEB_PORT}/auth/callback?token=${loginToken}`;

    console.log(`Login link (expires in 1h):\n${url}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
