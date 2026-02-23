/**
 * Delete a record and clean up all references.
 *
 * Usage:
 *   npx tsx scripts/admin-delete-record.ts <record-id>
 *
 * For production:
 *   npx tsx --env-file=.env.prod scripts/admin-delete-record.ts <record-id>
 *
 * What it does:
 *   1. Remove record from other records' related_links arrays
 *   2. Delete record_relations entries
 *   3. Delete the record itself
 */

import dotenv from 'dotenv';
if (!process.env.DATABASE_URL) {
  dotenv.config({ override: true });
}

import { deleteRecordFull } from '../src/pipeline.js';
import { getRecord } from '../src/db/index.js';
import { getDb } from '../src/db/connection.js';

async function main() {
  const recordId = parseInt(process.argv[2], 10);
  if (!recordId || isNaN(recordId)) {
    console.error('Usage: npx tsx scripts/admin-delete-record.ts <record-id>');
    process.exit(1);
  }

  console.log(`[admin] DATABASE_URL: ${process.env.DATABASE_URL?.replace(/\/\/.*@/, '//***@')}`);

  const record = await getRecord(recordId);
  if (!record) {
    console.error(`Record #${recordId} not found`);
    process.exit(1);
  }

  console.log(`[admin] Found record #${recordId}: ${record.url}`);
  console.log(`[admin] Status: ${record.status}`);
  console.log(`[admin] Deleting...`);

  const result = await deleteRecordFull(recordId);

  console.log(`[admin] ✅ Deleted record #${result.recordId} (${result.url})`);
  console.log(`[admin]    Related records updated: ${result.relatedRecordsUpdated}`);

  await getDb().destroy();
}

main().catch((err) => {
  console.error('[admin] Error:', err.message);
  process.exit(1);
});
