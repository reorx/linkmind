/**
 * Export records, users, invites to JSON files.
 * Run: npx tsx scripts/export-data.ts [output-dir]
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';

const DATABASE_URL = process.env.DATABASE_URL!;

async function main() {
  const outDir = process.argv[2] || path.resolve(import.meta.dirname, '../../data-export');
  fs.mkdirSync(outDir, { recursive: true });

  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  const tables = ['invites', 'users', 'records'] as const;

  for (const table of tables) {
    const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY id`);
    const outPath = path.join(outDir, `${table}.json`);
    fs.writeFileSync(outPath, JSON.stringify(rows, null, 2));
    console.log(`✅ ${table}: ${rows.length} rows → ${outPath}`);
  }

  // Also export record_relations and record_derivations if they have data
  for (const table of ['record_relations', 'record_derivations']) {
    try {
      const { rows } = await pool.query(`SELECT * FROM ${table}`);
      if (rows.length > 0) {
        const outPath = path.join(outDir, `${table}.json`);
        fs.writeFileSync(outPath, JSON.stringify(rows, null, 2));
        console.log(`✅ ${table}: ${rows.length} rows → ${outPath}`);
      } else {
        console.log(`⏭️  ${table}: 0 rows, skipped`);
      }
    } catch {
      console.log(`⏭️  ${table}: table not found, skipped`);
    }
  }

  await pool.end();
  console.log(`\n📁 Export complete: ${outDir}`);
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
