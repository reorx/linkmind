/**
 * Migration: Add invites table and status/invite_id to users.
 * Sets first user (id=1) to active.
 *
 * Usage: npx tsx scripts/migrate_add_invites.ts
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
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Create invites table
    console.log('Creating invites table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS invites (
        id SERIAL PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        max_uses INTEGER NOT NULL DEFAULT 1,
        used_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log('✅ invites table created');

    // 2. Add status to users
    const { rows: statusCol } = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'status'`,
    );
    if (statusCol.length === 0) {
      await client.query(`ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`);
      console.log('✅ users.status added');
    } else {
      console.log('⚠️  users.status already exists');
    }

    // 3. Add invite_id to users
    const { rows: inviteCol } = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'invite_id'`,
    );
    if (inviteCol.length === 0) {
      await client.query(`ALTER TABLE users ADD COLUMN invite_id INTEGER REFERENCES invites(id)`);
      console.log('✅ users.invite_id added');
    } else {
      console.log('⚠️  users.invite_id already exists');
    }

    // 4. Set first user to active
    await client.query(`UPDATE users SET status = 'active' WHERE id = 1`);
    console.log('✅ First user set to active');

    await client.query('COMMIT');
    console.log('\n🎉 Migration complete!');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
