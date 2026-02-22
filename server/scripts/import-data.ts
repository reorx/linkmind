/**
 * Import data from JSON export files into a fresh database.
 * Assumes 001_init.sql has already been applied.
 *
 * Run: npx tsx scripts/import-data.ts [data-dir]
 */

import dotenv from 'dotenv';
if (!process.env.DATABASE_URL) {
  dotenv.config({ override: true });
}

import pg from 'pg';
import fs from 'fs';
import path from 'path';

const DATABASE_URL = process.env.DATABASE_URL!;

function loadJson(filePath: string): any[] {
  if (!fs.existsSync(filePath)) {
    console.log(`⏭️  ${filePath} not found, skipping`);
    return [];
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function buildInsert(table: string, rows: Record<string, any>[]): { text: string; values: any[] } | null {
  if (rows.length === 0) return null;

  const columns = Object.keys(rows[0]);
  const placeholders: string[] = [];
  const values: any[] = [];
  let idx = 1;

  for (const row of rows) {
    const rowPlaceholders: string[] = [];
    for (const col of columns) {
      let val = row[col];
      // Serialize objects/arrays to JSON string for JSONB columns
      if (val !== null && typeof val === 'object' && !(val instanceof Date)) {
        val = JSON.stringify(val);
      }
      values.push(val);
      rowPlaceholders.push(`$${idx++}`);
    }
    placeholders.push(`(${rowPlaceholders.join(', ')})`);
  }

  const text = `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(', ')}) VALUES ${placeholders.join(', ')}`;
  return { text, values };
}

async function main() {
  const dataDir = process.argv[2] || path.resolve(import.meta.dirname, '../data-export');

  if (!fs.existsSync(dataDir)) {
    console.error(`❌ Data directory not found: ${dataDir}`);
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Import in dependency order
    const tables = ['invites', 'users', 'records', 'record_relations', 'record_derivations'];

    for (const table of tables) {
      const rows = loadJson(path.join(dataDir, `${table}.json`));
      if (rows.length === 0) continue;

      const insert = buildInsert(table, rows);
      if (!insert) continue;

      await client.query(insert.text, insert.values);
      console.log(`✅ ${table}: ${rows.length} rows imported`);

      // Reset sequence to max id
      if (['invites', 'users', 'records', 'record_relations'].includes(table)) {
        await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT COALESCE(MAX(id), 0) FROM ${table}))`);
        console.log(`   🔢 ${table}_id_seq reset`);
      }
    }

    await client.query('COMMIT');
    console.log('\n✅ Import complete!');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});
