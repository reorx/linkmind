/**
 * Migration: Add images column to links table.
 *
 * Usage: npx tsx scripts/migrate_add_images.ts
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

    // Check if column already exists
    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'links' AND column_name = 'images'`,
    );

    if (rows.length === 0) {
      console.log('Adding images column to links table...');
      await client.query(`ALTER TABLE links ADD COLUMN images TEXT`);
      console.log('✅ links.images column added');
    } else {
      console.log('⚠️  links.images column already exists');
    }

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
