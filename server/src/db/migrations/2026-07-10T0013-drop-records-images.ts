import { type Kysely, sql } from 'kysely';

/**
 * Drop the legacy records.images column.
 *
 * Images are now stored in record_files + object storage. Nothing writes this
 * column anymore, and all readers (bot photo-send, link-detail / shared pages,
 * admin record view) were migrated to record_files in the same change.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE records DROP COLUMN IF EXISTS images`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // forward-only, no rollback
}
