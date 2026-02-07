/**
 * Migrate data from SQLite (better-sqlite3) to PostgreSQL.
 * Usage: npx tsx scripts/migrate_data.ts
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import Database from 'better-sqlite3';
import pg from 'pg';

const SQLITE_PATH = 'data/linkmind.db';
const PG_URL = process.env.DATABASE_URL;

if (!PG_URL) {
  console.error('DATABASE_URL not set in .env');
  process.exit(1);
}

async function main() {
  // Open SQLite
  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  const rows = sqlite.prepare('SELECT * FROM links ORDER BY id').all() as any[];
  console.log(`SQLite: ${rows.length} records`);

  // Connect to PG
  const pool = new pg.Pool({ connectionString: PG_URL });
  const client = await pool.connect();

  try {
    // Check if PG already has data
    const { rows: existing } = await client.query('SELECT COUNT(*) as count FROM links');
    const pgCount = parseInt(existing[0].count, 10);
    if (pgCount > 0) {
      console.log(`PostgreSQL already has ${pgCount} records. Truncating...`);
      await client.query('TRUNCATE links RESTART IDENTITY');
    }

    // Insert rows one by one (handles all special chars properly)
    let ok = 0;
    let fail = 0;

    for (const row of rows) {
      try {
        await client.query(
          `INSERT INTO links (id, url, og_title, og_description, og_image, og_site_name, og_type,
            markdown, summary, insight, related_notes, related_links, tags,
            status, error_message, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            row.id,
            row.url,
            row.og_title || null,
            row.og_description || null,
            row.og_image || null,
            row.og_site_name || null,
            row.og_type || null,
            row.markdown || null,
            row.summary || null,
            row.insight || null,
            row.related_notes || '[]',
            row.related_links || '[]',
            row.tags || '[]',
            row.status,
            row.error_message || null,
            row.created_at || new Date().toISOString(),
            row.updated_at || new Date().toISOString(),
          ],
        );
        ok++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ❌ #${row.id} ${(row.og_title || row.url || '').slice(0, 50)} → ${msg}`);
        fail++;
      }
    }

    // Reset sequence
    await client.query("SELECT setval('links_id_seq', (SELECT COALESCE(MAX(id), 1) FROM links))");

    // Verify
    const { rows: final } = await client.query('SELECT COUNT(*) as count FROM links');
    console.log(`\nMigrated: ${ok} ok, ${fail} failed`);
    console.log(`PostgreSQL: ${final[0].count} records`);

    if (ok === rows.length) {
      console.log('🎉 Migration complete!');
    } else {
      console.log('⚠️  Some records failed, check errors above.');
    }
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
