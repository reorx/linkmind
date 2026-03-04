import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { runMigrations } from './migrate.js';

export interface BootstrapDatabaseOptions {
  databaseUrl: string;
  adminDatabaseUrl: string;
  owner?: string;
  dropIfExists?: boolean;
  extensions?: string[];
  includeOptionalBm25Migration?: boolean;
  runKyselyMigrations?: boolean;
  absurdQueueName?: string;
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

function getDatabaseName(connectionString: string): string {
  const dbName = decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ''));
  if (!dbName) {
    throw new Error(`Invalid database name in URL: ${connectionString}`);
  }
  return dbName;
}

async function databaseExists(adminClient: pg.Client, database: string): Promise<boolean> {
  const result = await adminClient.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  return (result.rowCount ?? 0) > 0;
}

export async function runBaselineSqlMigrations(
  connectionString: string,
  includeOptionalBm25Migration: boolean = true,
): Promise<void> {
  const migrationsDir = path.resolve(import.meta.dirname, '../../migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const selectedFiles = files.filter((file) => includeOptionalBm25Migration || file !== '002_bm25_index.sql');

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    for (const file of selectedFiles) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      console.log(`Applying baseline migration: ${file}`);
      await client.query(sql);
    }
  } finally {
    await client.end();
  }
}

export async function ensureAbsurdQueue(connectionString: string, queueName: string): Promise<void> {
  const absurdPath = path.resolve(import.meta.dirname, '../../sql/absurd.sql');
  const absurdSql = fs.readFileSync(absurdPath, 'utf-8');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(absurdSql);
    await client.query(`SELECT absurd.create_queue($1)`, [queueName]);
  } finally {
    await client.end();
  }
}

export async function bootstrapDatabase(options: BootstrapDatabaseOptions): Promise<void> {
  const {
    databaseUrl,
    adminDatabaseUrl,
    owner,
    dropIfExists = false,
    extensions = ['vector', 'pg_search'],
    includeOptionalBm25Migration = true,
    runKyselyMigrations = true,
    absurdQueueName,
  } = options;

  const database = getDatabaseName(databaseUrl);
  const ownerName = owner ?? decodeURIComponent(new URL(databaseUrl).username || '');

  const adminClient = new pg.Client({ connectionString: adminDatabaseUrl });
  await adminClient.connect();
  try {
    if (dropIfExists) {
      console.log(`Dropping database ${database} (if exists)...`);
      await adminClient.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`);
    }

    const exists = await databaseExists(adminClient, database);
    if (!exists) {
      const ownerClause = ownerName ? ` OWNER ${quoteIdent(ownerName)}` : '';
      console.log(`Creating database ${database}...`);
      await adminClient.query(`CREATE DATABASE ${quoteIdent(database)}${ownerClause}`);
    } else {
      throw new Error(`Database ${database} already exists. Use dropIfExists=true to recreate it.`);
    }
  } finally {
    await adminClient.end();
  }

  const adminTargetUrl = withDatabase(adminDatabaseUrl, database);
  const extClient = new pg.Client({ connectionString: adminTargetUrl });
  await extClient.connect();
  try {
    for (const ext of extensions) {
      console.log(`Ensuring extension ${ext}...`);
      await extClient.query(`CREATE EXTENSION IF NOT EXISTS ${quoteIdent(ext)}`);
    }
  } finally {
    await extClient.end();
  }

  await runBaselineSqlMigrations(databaseUrl, includeOptionalBm25Migration);

  if (runKyselyMigrations) {
    console.log('Applying Kysely migrations...');
    await runMigrations(databaseUrl);
  }

  if (absurdQueueName) {
    console.log(`Ensuring Absurd queue ${absurdQueueName}...`);
    await ensureAbsurdQueue(databaseUrl, absurdQueueName);
  }
}
