import { getDb } from './connection.js';

export interface InsertRecordFile {
  record_id: number;
  source: string;
  source_ref?: string;
  storage_provider: string;
  storage_key: string;
  mime_type?: string;
  size_bytes?: number;
  width?: number;
  height?: number;
  metadata?: Record<string, unknown>;
}

export async function insertRecordFile(file: InsertRecordFile): Promise<number> {
  const db = getDb();
  // Upsert on (record_id, storage_key): re-processing a record regenerates the
  // same deterministic storage_key, so refresh the existing row instead of
  // inserting a duplicate. Requires the record_files_record_storage_uniq
  // constraint (migration 2026-07-10T0012).
  const row = await db
    .insertInto('record_files')
    .values({
      record_id: file.record_id,
      source: file.source,
      source_ref: file.source_ref ?? null,
      storage_provider: file.storage_provider,
      storage_key: file.storage_key,
      mime_type: file.mime_type ?? null,
      size_bytes: file.size_bytes ?? null,
      width: file.width ?? null,
      height: file.height ?? null,
      metadata: file.metadata ? JSON.stringify(file.metadata) : '{}',
    })
    .onConflict((oc) =>
      oc.columns(['record_id', 'storage_key']).doUpdateSet({
        source: file.source,
        source_ref: file.source_ref ?? null,
        storage_provider: file.storage_provider,
        mime_type: file.mime_type ?? null,
        size_bytes: file.size_bytes ?? null,
        width: file.width ?? null,
        height: file.height ?? null,
        metadata: file.metadata ? JSON.stringify(file.metadata) : '{}',
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function getRecordFiles(recordId: number) {
  const db = getDb();
  return db
    .selectFrom('record_files')
    .where('record_id', '=', recordId)
    .orderBy('created_at', 'asc')
    .selectAll()
    .execute();
}
