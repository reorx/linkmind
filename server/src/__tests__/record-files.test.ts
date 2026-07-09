/**
 * Behavior tests: record_files dedup / upsert.
 *
 * Re-processing a record (retry) regenerates the same deterministic storage_key
 * and must NOT create duplicate record_files rows — insertRecordFile upserts on
 * (record_id, storage_key). Reproduces the duplicate-row bug seen on records
 * #58 / #41 before the UNIQUE constraint + onConflict fix.
 *
 * Uses a separate test database (linkmind_recordfiles_test).
 *
 * Usage:
 *   cd server && npx vitest run src/__tests__/record-files.test.ts
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

// Override DATABASE_URL to use test database BEFORE any imports that use it
const PROD_DB_URL = process.env.DATABASE_URL!;
const TEST_DB_URL = PROD_DB_URL.replace(/\/[^/]+$/, '/linkmind_recordfiles_test');
process.env.DATABASE_URL = TEST_DB_URL;
const TEST_DB_ADMIN_URL =
  process.env.TEST_DB_ADMIN_DATABASE_URL ??
  (() => {
    const url = new URL(TEST_DB_URL);
    url.pathname = '/postgres';
    if (!url.username || url.username === 'linkmind') {
      url.username = 'reorx';
    }
    return url.toString();
  })();

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { bootstrapDatabase } from '../db/bootstrap.js';

import { initLogger } from '../logger.js';
initLogger();

import { insertRecord, insertRecordFile, getRecordFiles } from '../db/index.js';
import { recordFileKey } from '../storage/index.js';

const TEST_TELEGRAM_ID = 777001;

async function createTestDatabase(): Promise<void> {
  await bootstrapDatabase({
    databaseUrl: TEST_DB_URL,
    adminDatabaseUrl: TEST_DB_ADMIN_URL,
    dropIfExists: true,
    absurdQueueName: 'linkmind',
  });

  const testPool = new pg.Pool({ connectionString: TEST_DB_URL });
  try {
    await testPool.query(
      `INSERT INTO users (telegram_id, username, display_name, status)
       VALUES ($1, 'recordfiles_test_user', 'Record Files Test User', 'active')
       ON CONFLICT (telegram_id) DO NOTHING`,
      [TEST_TELEGRAM_ID],
    );
  } finally {
    await testPool.end();
  }
}

async function dropTestDatabase(): Promise<void> {
  const adminPool = new pg.Pool({ connectionString: TEST_DB_ADMIN_URL });
  try {
    await adminPool.query('DROP DATABASE IF EXISTS "linkmind_recordfiles_test" WITH (FORCE)');
  } finally {
    await adminPool.end();
  }
}

describe('record_files dedup', () => {
  let recordId: number;

  beforeAll(async () => {
    await createTestDatabase();

    const pool = new pg.Pool({ connectionString: TEST_DB_URL });
    let userId: number;
    try {
      const res = await pool.query('SELECT id FROM users WHERE telegram_id = $1', [TEST_TELEGRAM_ID]);
      userId = res.rows[0].id;
    } finally {
      await pool.end();
    }

    recordId = await insertRecord(userId, { url: 'https://example.com/twitter-status', status: 'analyzed' });
  }, 30_000);

  afterAll(async () => {
    // DROP DATABASE WITH FORCE terminates the Kysely pool's idle connection
    const suppress = (err: Error) => {
      if (err.message?.includes('terminating connection')) return;
      throw err;
    };
    process.on('uncaughtException', suppress);
    await dropTestDatabase();
    await new Promise((r) => setTimeout(r, 100));
    process.removeListener('uncaughtException', suppress);
  });

  it('re-inserting the same (record_id, storage_key) upserts instead of duplicating', async () => {
    const storageKey = recordFileKey(recordId, 0, 'twitter', 'jpg');

    const id1 = await insertRecordFile({
      record_id: recordId,
      source: 'twitter_media',
      source_ref: 'https://pbs.twimg.com/media/first.jpg',
      storage_provider: 'local',
      storage_key: storageKey,
      mime_type: 'image/jpeg',
      size_bytes: 100,
      width: 10,
      height: 10,
    });

    // Second processing pass: same key, refreshed metadata (larger download)
    const id2 = await insertRecordFile({
      record_id: recordId,
      source: 'twitter_media',
      source_ref: 'https://pbs.twimg.com/media/first.jpg',
      storage_provider: 'local',
      storage_key: storageKey,
      mime_type: 'image/jpeg',
      size_bytes: 250,
      width: 20,
      height: 20,
    });

    const files = await getRecordFiles(recordId);
    expect(files).toHaveLength(1);
    expect(id2).toBe(id1); // upsert returns the existing row's id
    expect(files[0].size_bytes).toBe(250); // metadata refreshed by the upsert
    expect(files[0].width).toBe(20);
  });

  it('a different storage_key still creates a separate row', async () => {
    const storageKey = recordFileKey(recordId, 1, 'twitter', 'jpg');

    await insertRecordFile({
      record_id: recordId,
      source: 'twitter_media',
      source_ref: 'https://pbs.twimg.com/media/second.jpg',
      storage_provider: 'local',
      storage_key: storageKey,
      mime_type: 'image/jpeg',
      size_bytes: 300,
      width: 30,
      height: 30,
    });

    const files = await getRecordFiles(recordId);
    expect(files).toHaveLength(2);
  });
});
