/**
 * Migration: Add users table and user_id to links.
 * Creates first user from FIRST_USER_TELEGRAM_ID env var (default: 69627313).
 *
 * Usage: npx tsx scripts/migrate_add_users.ts
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import pg from 'pg';

const PG_URL = process.env.DATABASE_URL;
const FIRST_USER_TELEGRAM_ID = parseInt(process.env.FIRST_USER_TELEGRAM_ID || '69627313', 10);
const FIRST_USER_NAME = process.env.FIRST_USER_NAME || 'Xiao';
const FIRST_USER_USERNAME = process.env.FIRST_USER_USERNAME || 'reorx';

if (!PG_URL) {
  console.error('DATABASE_URL not set in .env');
  process.exit(1);
}

async function main() {
  const pool = new pg.Pool({ connectionString: PG_URL });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Create users table
    console.log('Creating users table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT NOT NULL UNIQUE,
        username TEXT,
        display_name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log('✅ users table created');

    // 2. Insert first user
    console.log(`Creating first user (telegram_id: ${FIRST_USER_TELEGRAM_ID})...`);
    const { rows } = await client.query(
      `INSERT INTO users (telegram_id, username, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (telegram_id) DO UPDATE SET username = $2, display_name = $3
       RETURNING id`,
      [FIRST_USER_TELEGRAM_ID, FIRST_USER_USERNAME, FIRST_USER_NAME],
    );
    const firstUserId = rows[0].id;
    console.log(`✅ First user created (id: ${firstUserId})`);

    // 3. Add user_id column to links (nullable first)
    console.log('Adding user_id column to links...');
    const { rows: colCheck } = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'links' AND column_name = 'user_id'`,
    );
    if (colCheck.length === 0) {
      await client.query(`ALTER TABLE links ADD COLUMN user_id INTEGER REFERENCES users(id)`);
      console.log('✅ user_id column added');
    } else {
      console.log('⚠️  user_id column already exists');
    }

    // 4. Assign all existing links to first user
    const { rowCount } = await client.query(`UPDATE links SET user_id = $1 WHERE user_id IS NULL`, [firstUserId]);
    console.log(`✅ ${rowCount} existing links assigned to user #${firstUserId}`);

    // 5. Make user_id NOT NULL
    await client.query(`ALTER TABLE links ALTER COLUMN user_id SET NOT NULL`);
    console.log('✅ user_id set to NOT NULL');

    // 6. Add index
    await client.query(`CREATE INDEX IF NOT EXISTS idx_links_user_id ON links (user_id)`);
    console.log('✅ Index created');

    await client.query('COMMIT');
    console.log('\n🎉 Migration complete!');

    // Verify
    const { rows: stats } = await client.query(
      `SELECT u.id, u.display_name, u.telegram_id, COUNT(l.id) as link_count
       FROM users u LEFT JOIN links l ON l.user_id = u.id
       GROUP BY u.id ORDER BY u.id`,
    );
    console.log('\nUsers:');
    for (const s of stats) {
      console.log(`  #${s.id} ${s.display_name} (tg:${s.telegram_id}) — ${s.link_count} links`);
    }
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
