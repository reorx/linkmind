/**
 * Generate a JWT session token for a user (for local API testing).
 * Usage: npx tsx scripts/gen-token.ts <username>
 */

import jwt from 'jsonwebtoken';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;

if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}
if (!JWT_SECRET) {
  console.error('JWT_SECRET not set');
  process.exit(1);
}

const username = process.argv[2];
if (!username) {
  console.error('Usage: npx tsx scripts/gen-token.ts <username>');
  process.exit(1);
}

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    const result = await pool.query('SELECT id, username, display_name, status FROM users WHERE username = $1', [
      username,
    ]);
    if (result.rows.length === 0) {
      console.error(`User not found: ${username}`);
      process.exit(1);
    }

    const user = result.rows[0];
    console.log(`\nUser: ${user.display_name || user.username} (id=${user.id}, status=${user.status})\n`);

    const token = jwt.sign({ userId: user.id }, JWT_SECRET!, { expiresIn: '7d' });

    console.log(`Token (expires in 7d):\n${token}\n`);
    console.log(`Example usage:\n  curl http://localhost:3456/api/links -b "lm_session=${token}"\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
