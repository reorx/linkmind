/**
 * CLI: List all invite codes.
 * Usage: npx tsx scripts/list_invites.ts
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import pg from 'pg';

const PG_URL = process.env.DATABASE_URL;
if (!PG_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

async function main() {
  const pool = new pg.Pool({ connectionString: PG_URL });

  try {
    const { rows } = await pool.query(
      `SELECT i.*, COUNT(u.id) as actual_uses
       FROM invites i
       LEFT JOIN users u ON u.invite_id = i.id
       GROUP BY i.id
       ORDER BY i.created_at DESC`,
    );

    if (rows.length === 0) {
      console.log('No invites found.');
      return;
    }

    console.log(`\n${'Code'.padEnd(14)} ${'Uses'.padEnd(10)} ${'Max'.padEnd(6)} Created`);
    console.log('-'.repeat(55));
    for (const r of rows) {
      const status = r.used_count >= r.max_uses ? '(full)' : '';
      console.log(
        `${r.code.padEnd(14)} ${String(r.used_count).padEnd(10)} ${String(r.max_uses).padEnd(6)} ${new Date(r.created_at).toLocaleString()} ${status}`,
      );
    }
    console.log(`\nTotal: ${rows.length} invite(s)`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
