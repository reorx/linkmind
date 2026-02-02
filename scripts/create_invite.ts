/**
 * CLI: Create an invite code.
 * Usage: npx tsx scripts/create_invite.ts [--max-uses N]
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import crypto from 'crypto';
import pg from 'pg';

const PG_URL = process.env.DATABASE_URL;
const BOT_USERNAME = process.env.BOT_USERNAME || 'linkmind_bot';

if (!PG_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

function parseArgs(): { maxUses: number } {
  const args = process.argv.slice(2);
  let maxUses = 1;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max-uses' && args[i + 1]) {
      maxUses = parseInt(args[i + 1], 10);
      if (isNaN(maxUses) || maxUses < 1) {
        console.error('--max-uses must be a positive integer');
        process.exit(1);
      }
    }
  }
  return { maxUses };
}

async function main() {
  const { maxUses } = parseArgs();
  const code = crypto.randomBytes(6).toString('hex'); // 12-char hex

  const pool = new pg.Pool({ connectionString: PG_URL });

  try {
    await pool.query('INSERT INTO invites (code, max_uses) VALUES ($1, $2)', [code, maxUses]);

    const deepLink = `https://t.me/${BOT_USERNAME}?start=invite_${code}`;

    console.log(`\n✅ 邀请码已创建\n`);
    console.log(`  邀请码:       ${code}`);
    console.log(`  最大使用次数: ${maxUses}`);
    console.log(`  链接:         ${deepLink}`);
    console.log('');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
