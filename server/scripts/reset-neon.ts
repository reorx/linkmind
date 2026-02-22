/**
 * Reset Neon database: drop all tables and recreate schema from scratch.
 * Reads migrations from server/migrations/ and applies absurd.sql.
 *
 * Run: npx tsx scripts/reset-neon.ts
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import pg from 'pg';
import fs from 'fs';
import path from 'path';

const DATABASE_URL = process.env.DATABASE_URL!;
if (!DATABASE_URL.includes('neon.tech')) {
  console.error('❌ This script is only for Neon databases. Current DATABASE_URL does not contain neon.tech.');
  process.exit(1);
}

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  console.log('🗑️  Dropping all existing tables...');
  await pool.query(`
    DROP TABLE IF EXISTS device_auth_requests CASCADE;
    DROP TABLE IF EXISTS probe_events CASCADE;
    DROP TABLE IF EXISTS probe_devices CASCADE;
    DROP TABLE IF EXISTS record_derivations CASCADE;
    DROP TABLE IF EXISTS record_relations CASCADE;
    DROP TABLE IF EXISTS records CASCADE;
    DROP TABLE IF EXISTS users CASCADE;
    DROP TABLE IF EXISTS invites CASCADE;
  `);

  // Drop absurd schema if exists
  await pool.query('DROP SCHEMA IF EXISTS absurd CASCADE');

  // Apply migrations in order
  const migrationsDir = path.resolve(import.meta.dirname, '../migrations');
  const sqlFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of sqlFiles) {
    console.log(`📦 Applying ${file}...`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    await pool.query(sql);
  }

  // Apply absurd queue
  console.log('⚙️  Setting up Absurd queue...');
  const absurdSql = fs.readFileSync(path.resolve(import.meta.dirname, '../sql/absurd.sql'), 'utf-8');
  await pool.query(absurdSql);
  await pool.query("SELECT absurd.create_queue('linkmind')");

  // Verify
  const tables = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
  );
  console.log(
    '\n✅ Done! Tables:',
    tables.rows.map((r: any) => r.table_name).join(', '),
  );

  await pool.end();
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
