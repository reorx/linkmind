import dotenv from 'dotenv';
dotenv.config({ override: true });

import { runMigrations } from '../src/db/migrate.js';
import { getDb } from '../src/db/connection.js';

async function main() {
  console.log('Running migrations...');
  const results = await runMigrations();

  if (!results || results.length === 0) {
    console.log('No pending migrations.');
  }

  await getDb().destroy();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
