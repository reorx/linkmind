import { sql } from 'kysely';
import { getDb } from './connection.js';
import { toRecordEntry } from './helpers.js';
import type { RecordEntry, RecordType } from './types.js';

export async function insertRecord(
  userId: number,
  data: {
    type?: RecordType;
    url?: string;
    content?: string;
    source_url?: string;
    user_note?: string;
    added_by_user?: boolean;
    telegram_message_id?: number;
    telegram_chat_id?: number;
    status?: RecordEntry['status'];
  },
): Promise<number> {
  const result = await getDb()
    .insertInto('records')
    .values({
      user_id: userId,
      type: data.type || 'link',
      url: data.url || null,
      content: data.content || null,
      source_url: data.source_url || null,
      user_note: data.user_note || null,
      added_by_user: data.added_by_user ?? true,
      telegram_message_id: data.telegram_message_id || null,
      telegram_chat_id: data.telegram_chat_id || null,
      status: data.status || 'pending',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return result.id;
}

export async function insertRecordWithCreatedAt(
  userId: number,
  url: string,
  createdAt: string,
  status: RecordEntry['status'] = 'pending',
): Promise<number> {
  const result = await getDb()
    .insertInto('records')
    .values({
      user_id: userId,
      type: 'link',
      url,
      added_by_user: true,
      status,
      created_at: sql`${createdAt}::timestamptz`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return result.id;
}

export async function insertNote(
  userId: number,
  content: string,
  opts?: {
    sourceUrl?: string;
    telegramMessageId?: number;
    telegramChatId?: number;
  },
): Promise<number> {
  return insertRecord(userId, {
    type: 'note',
    content,
    source_url: opts?.sourceUrl,
    telegram_message_id: opts?.telegramMessageId,
    telegram_chat_id: opts?.telegramChatId,
  });
}

export async function updateRecord(id: number, data: Partial<RecordEntry>): Promise<void> {
  const { id: _id, user_id: _uid, created_at: _ca, ...rest } = data as any;
  await getDb()
    .updateTable('records')
    .set({ ...rest, updated_at: sql`NOW()` })
    .where('id', '=', id)
    .execute();
}

export async function getRecord(id: number): Promise<RecordEntry | undefined> {
  const row = await getDb().selectFrom('records').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? toRecordEntry(row) : undefined;
}

export async function getRecordByUrl(userId: number, url: string): Promise<RecordEntry | undefined> {
  const row = await getDb()
    .selectFrom('records')
    .selectAll()
    .where('user_id', '=', userId)
    .where('url', '=', url)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? toRecordEntry(row) : undefined;
}

export async function getRecordByTelegramMessage(chatId: number, messageId: number): Promise<RecordEntry | undefined> {
  const row = await getDb()
    .selectFrom('records')
    .selectAll()
    .where('telegram_chat_id', '=', chatId)
    .where('telegram_message_id', '=', messageId)
    .executeTakeFirst();
  return row ? toRecordEntry(row) : undefined;
}

export async function getRecentRecords(userId: number, limit: number = 20): Promise<RecordEntry[]> {
  const rows = await getDb()
    .selectFrom('records')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
  return rows.map(toRecordEntry);
}

export async function getPaginatedRecords(
  userId: number,
  page: number = 1,
  perPage: number = 50,
): Promise<{ records: RecordEntry[]; total: number; page: number; totalPages: number }> {
  const { count } = await getDb()
    .selectFrom('records')
    .select(sql<number>`count(*)::int`.as('count'))
    .where('user_id', '=', userId)
    .where('added_by_user', '=', true)
    .executeTakeFirstOrThrow();

  const total = count;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const offset = (safePage - 1) * perPage;

  const rows = await getDb()
    .selectFrom('records')
    .selectAll()
    .where('user_id', '=', userId)
    .where('added_by_user', '=', true)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(perPage)
    .offset(offset)
    .execute();

  return { records: rows.map(toRecordEntry), total, page: safePage, totalPages };
}

export async function getAllUserRecords(userId: number, type?: RecordType): Promise<RecordEntry[]> {
  let query = getDb().selectFrom('records').selectAll().where('user_id', '=', userId);
  if (type) {
    query = query.where('type', '=', type);
  }
  const rows = await query.orderBy('created_at', 'desc').execute();
  return rows.map(toRecordEntry);
}

export async function getAllAnalyzedRecords(userId?: number): Promise<RecordEntry[]> {
  let query = getDb().selectFrom('records').selectAll().where('status', '=', 'analyzed');
  if (userId != null) {
    query = query.where('user_id', '=', userId);
  }
  const rows = await query.orderBy('id', 'asc').execute();
  return rows.map(toRecordEntry);
}

export async function getFailedRecords(userId?: number): Promise<RecordEntry[]> {
  let query = getDb().selectFrom('records').selectAll().where('status', '=', 'error');
  if (userId != null) {
    query = query.where('user_id', '=', userId);
  }
  const rows = await query.orderBy('id', 'desc').execute();
  return rows.map(toRecordEntry);
}

export async function getEnqueuedRecords(perUser: number): Promise<RecordEntry[]> {
  const rows = await getDb()
    .selectFrom('records')
    .selectAll()
    .where('status', '=', 'enqueued')
    .orderBy('created_at', 'asc')
    .execute();

  const byUser = new Map<number, typeof rows>();
  for (const row of rows) {
    const list = byUser.get(row.user_id) || [];
    if (list.length < perUser) {
      list.push(row);
      byUser.set(row.user_id, list);
    }
  }

  return Array.from(byUser.values()).flat().map(toRecordEntry);
}

export async function deleteRecord(id: number): Promise<void> {
  await getDb().deleteFrom('records').where('id', '=', id).execute();
}

export async function searchRecords(query: string, limit: number = 10, userId?: number): Promise<RecordEntry[]> {
  const pattern = `%${query}%`;
  let q = getDb().selectFrom('records').selectAll().where('status', '=', 'analyzed');
  if (userId != null) {
    q = q.where('user_id', '=', userId);
  }
  const rows = await q
    .where((eb) =>
      eb.or([
        eb('og_title', 'ilike', pattern),
        eb('og_description', 'ilike', pattern),
        eb('summary', 'ilike', pattern),
        eb('markdown', 'ilike', pattern),
        eb('content', 'ilike', pattern),
      ]),
    )
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
  return rows.map(toRecordEntry);
}

export async function appendUserNote(recordId: number, note: string): Promise<void> {
  const record = await getRecord(recordId);
  if (!record) return;

  const existingNote = record.user_note || '';
  const newNote = existingNote ? `${existingNote}\n\n${note}` : note;

  await updateRecord(recordId, { user_note: newNote });
}

export async function removeFromRelatedRecords(deletedRecordId: number): Promise<number> {
  const records = await getDb()
    .selectFrom('records')
    .select(['id', 'related_links'])
    .where('status', '=', 'analyzed')
    .where('related_links', 'is not', null)
    .execute();

  let updated = 0;
  for (const record of records) {
    const related: number[] = JSON.parse(
      typeof record.related_links === 'string' ? record.related_links : JSON.stringify(record.related_links || []),
    );
    const filtered = related.filter((id: number) => id !== deletedRecordId);
    if (filtered.length !== related.length) {
      await getDb()
        .updateTable('records')
        .set({ related_links: JSON.stringify(filtered), updated_at: sql`NOW()` })
        .where('id', '=', record.id)
        .execute();
      updated++;
    }
  }
  return updated;
}
