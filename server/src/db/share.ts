import { getDb } from './connection.js';
import type { ShareRecord } from './types.js';

function toShareRecord(row: any): ShareRecord {
  return {
    id: row.id,
    nanoid: row.nanoid,
    record_id: row.record_id,
    user_id: row.user_id,
    created_at: row.created_at?.toISOString?.() ?? row.created_at,
  };
}

export async function getShareByRecordId(recordId: number): Promise<ShareRecord | undefined> {
  const row = await getDb()
    .selectFrom('share_records')
    .selectAll()
    .where('record_id', '=', recordId)
    .executeTakeFirst();
  return row ? toShareRecord(row) : undefined;
}

export async function getShareByNanoid(nanoid: string): Promise<ShareRecord | undefined> {
  const row = await getDb().selectFrom('share_records').selectAll().where('nanoid', '=', nanoid).executeTakeFirst();
  return row ? toShareRecord(row) : undefined;
}

export async function createShare(nanoid: string, recordId: number, userId: number): Promise<ShareRecord> {
  const row = await getDb()
    .insertInto('share_records')
    .values({ nanoid, record_id: recordId, user_id: userId })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toShareRecord(row);
}

export async function deleteShareByRecordId(recordId: number): Promise<boolean> {
  const result = await getDb().deleteFrom('share_records').where('record_id', '=', recordId).executeTakeFirst();
  return (result?.numDeletedRows ?? 0n) > 0n;
}
