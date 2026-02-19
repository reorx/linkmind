/**
 * Reset Neon database: drop all tables and recreate schema from scratch.
 * Run: npx tsx scripts/reset-neon.ts
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import pg from 'pg';

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

  console.log('🔧 Ensuring extensions...');
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_search');

  console.log('📦 Creating tables...');
  await pool.query(`
    CREATE TABLE invites (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL UNIQUE,
      username TEXT,
      display_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'pending',
      invite_id INTEGER REFERENCES invites(id)
    );

    CREATE TABLE records (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      type TEXT NOT NULL DEFAULT 'link',
      url TEXT,
      content TEXT,
      source_url TEXT,
      user_note TEXT,
      added_by_user BOOLEAN NOT NULL DEFAULT TRUE,
      og_title TEXT,
      og_description TEXT,
      og_image TEXT,
      og_site_name TEXT,
      og_type TEXT,
      markdown TEXT,
      summary TEXT,
      insight TEXT,
      related_notes JSONB DEFAULT '[]',
      related_links JSONB DEFAULT '[]',
      tags JSONB DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      telegram_message_id BIGINT,
      telegram_chat_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      images TEXT,
      summary_embedding vector(1024)
    );

    CREATE TABLE record_relations (
      id SERIAL PRIMARY KEY,
      record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
      related_record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
      score REAL NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(record_id, related_record_id)
    );

    CREATE TABLE record_derivations (
      source_record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
      derived_record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source_record_id, derived_record_id)
    );

    CREATE TABLE probe_devices (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      access_token TEXT UNIQUE NOT NULL,
      name TEXT,
      last_seen_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE probe_events (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      link_id INTEGER REFERENCES records(id),
      url TEXT NOT NULL,
      url_type TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      result JSONB,
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      sent_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE device_auth_requests (
      device_code TEXT PRIMARY KEY,
      user_code TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      status TEXT DEFAULT 'pending',
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log('📇 Creating indexes...');
  await pool.query(`
    CREATE INDEX idx_records_url ON records(url);
    CREATE INDEX idx_records_user_id ON records(user_id);
    CREATE INDEX idx_records_status ON records(status);
    CREATE INDEX idx_records_created_at ON records(created_at DESC);
    CREATE INDEX idx_records_type ON records(type);
    CREATE INDEX idx_records_added_by_user ON records(added_by_user);
    CREATE INDEX idx_records_telegram_msg ON records(telegram_chat_id, telegram_message_id);
    CREATE INDEX idx_derivations_derived ON record_derivations(derived_record_id);
  `);

  console.log('🔍 Creating BM25 index...');
  await pool.query(`
    CREATE INDEX idx_records_bm25
    ON records USING bm25 (id, og_title, summary, markdown)
    WITH (key_field = 'id')
  `);

  console.log('⚙️  Setting up Absurd queue...');
  // Read and execute absurd.sql
  const fs = await import('fs');
  const path = await import('path');
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
