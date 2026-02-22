import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './types.js';

let db: Kysely<Database> | null = null;

export function getDb(): Kysely<Database> {
  if (db) return db;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString }),
    }),
  });

  return db;
}
