/**
 * Migration: Create link_relations table
 */
import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS link_relations (
        id SERIAL PRIMARY KEY,
        link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
        related_link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
        score REAL NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(link_id, related_link_id)
      );
      CREATE INDEX IF NOT EXISTS idx_link_relations_link ON link_relations(link_id);
      CREATE INDEX IF NOT EXISTS idx_link_relations_related ON link_relations(related_link_id);
    `);
    console.log('✅ Created link_relations table');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
