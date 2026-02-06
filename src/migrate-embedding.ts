/**
 * One-time migration: rename embedding → summary_embedding
 */
import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    await client.query('ALTER TABLE links RENAME COLUMN embedding TO summary_embedding');
    console.log('✅ Migration successful: embedding → summary_embedding');
  } catch (err: any) {
    if (err.message?.includes('does not exist')) {
      console.log('Column "embedding" does not exist, checking if already migrated...');
      const res = await client.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'links' AND column_name = 'summary_embedding'
      `);
      if (res.rows.length > 0) {
        console.log('✅ Already migrated: summary_embedding exists');
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
