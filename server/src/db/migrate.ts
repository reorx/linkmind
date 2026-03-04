import * as path from 'path';
import { promises as fs } from 'fs';
import { Kysely, Migrator, FileMigrationProvider, PostgresDialect } from 'kysely';
import pg from 'pg';
import { getDb } from './connection.js';

export async function runMigrations(connectionString?: string) {
  const db =
    connectionString === undefined
      ? getDb()
      : new Kysely<any>({
          dialect: new PostgresDialect({
            pool: new pg.Pool({ connectionString }),
          }),
        });
  const shouldDestroy = connectionString !== undefined;

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(import.meta.dirname, 'migrations'),
    }),
  });

  const { error, results } = await migrator.migrateToLatest();

  results?.forEach((it) => {
    if (it.status === 'Success') {
      console.log(`migration "${it.migrationName}" was executed successfully`);
    } else if (it.status === 'Error') {
      console.error(`failed to execute migration "${it.migrationName}"`);
    }
  });

  if (error) {
    console.error('failed to migrate');
    console.error(error);
    if (shouldDestroy) {
      await db.destroy();
    }
    process.exit(1);
  }

  if (shouldDestroy) {
    await db.destroy();
  }

  return results;
}
