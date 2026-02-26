/**
 * Import data from JSON export files into a fresh database.
 * Assumes 001_init.sql has already been applied.
 *
 * Run: npx tsx scripts/import-data.ts [data-dir]
 *
 * Options:
 *   --user-id N    Only import data for user with id N (invites + that user + their records)
 *   --limit N      Only import first N records per table
 */

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

function parseArgs() {
  const args = process.argv.slice(2);
  let dataDir = path.resolve(import.meta.dirname, '../../data-export');
  let userId: number | null = null;
  let limit: number | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user-id' && args[i + 1]) {
      userId = parseInt(args[++i], 10);
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[++i], 10);
    } else if (!args[i].startsWith('--')) {
      dataDir = args[i];
    }
  }
  return { dataDir, userId, limit };
}

function filterRows(table: string, rows: any[], userId: number | null, limit: number | null): any[] {
  let filtered = rows;
  if (userId !== null) {
    if (table === 'users') {
      filtered = rows.filter((r) => r.id === userId);
    } else if (table === 'records') {
      filtered = rows.filter((r) => r.user_id === userId);
    } else if (table === 'record_relations' || table === 'record_derivations') {
      // These reference records, filter by user's record ids later
      // For now pass through — will be filtered below
    }
    // invites: import all (they're small and needed for FK)
  }
  if (limit !== null) {
    filtered = filtered.slice(0, limit);
  }
  return filtered;
}

async function main() {
  const { dataDir, userId, limit } = parseArgs();

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

    // Collect imported record ids for filtering relations
    const importedRecordIds = new Set<number>();

    for (const table of tables) {
      let rows = loadJson(path.join(dataDir, `${table}.json`));
      if (rows.length === 0) continue;

      rows = filterRows(table, rows, userId, table === 'records' ? limit : null);

      // Filter relations by imported record ids
      if ((table === 'record_relations' || table === 'record_derivations') && userId !== null) {
        rows = rows.filter(
          (r: any) =>
            importedRecordIds.has(r.record_id) ||
            importedRecordIds.has(r.source_record_id) ||
            importedRecordIds.has(r.target_record_id),
        );
      }

      if (rows.length === 0) {
        console.log(`⏭️  ${table}: 0 rows after filtering, skipped`);
        continue;
      }

      const insert = buildInsert(table, rows);
      if (!insert) continue;

      await client.query(insert.text, insert.values);
      console.log(`✅ ${table}: ${rows.length} rows imported`);

      // Track imported record ids
      if (table === 'records') {
        for (const r of rows) importedRecordIds.add(r.id);
      }

      // Reset sequence to max id
      if (['invites', 'users', 'records', 'record_relations'].includes(table)) {
        await client.query(
          `SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT COALESCE(MAX(id), 0) FROM ${table}))`,
        );
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
