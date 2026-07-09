import { type Kysely, sql } from 'kysely';

/**
 * Deduplicate record_files and enforce uniqueness on (record_id, storage_key).
 *
 * Re-processing a record (retry) regenerates the same deterministic storage_key
 * (`records/{id}/{index}_{source}.{ext}`) and overwrites the same storage object,
 * but the old insertRecordFile always INSERTed a fresh row — so duplicate rows
 * accumulated (observed on records #58 / #41). This removes existing duplicates
 * (keeping the lowest id per key) and adds a UNIQUE constraint so insertRecordFile
 * can upsert instead of duplicating.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    DELETE FROM record_files a
    USING record_files b
    WHERE a.id > b.id
      AND a.record_id = b.record_id
      AND a.storage_key = b.storage_key
  `.execute(db);

  await sql`
    ALTER TABLE record_files
    ADD CONSTRAINT record_files_record_storage_uniq UNIQUE (record_id, storage_key)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // forward-only, no rollback
}
