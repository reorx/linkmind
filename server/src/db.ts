import { Generated, Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

/* ── Types ── */

export type RecordType = 'link' | 'note';

export interface UserRecord {
  id?: number;
  telegram_id: number;
  username?: string;
  display_name?: string;
  status: 'pending' | 'active';
  invite_id?: number;
  created_at?: string;
}

export interface InviteRecord {
  id?: number;
  code: string;
  max_uses: number;
  used_count: number;
  created_at?: string;
}

export interface RecordEntry {
  id?: number;
  user_id: number;
  type: RecordType;
  url?: string;
  content?: string;
  source_url?: string;
  user_note?: string;
  added_by_user: boolean;
  og_title?: string;
  og_description?: string;
  og_image?: string;
  og_site_name?: string;
  og_type?: string;
  markdown?: string;
  summary?: string;
  insight?: string;
  related_notes?: string; // JSON string (for compat with existing code)
  related_links?: string; // JSON string
  tags?: string; // JSON string
  images?: string; // JSON string (ImageInfo[])
  summary_embedding?: string; // PostgreSQL vector string format: [0.1,0.2,...] - embedding of summary only
  status: 'enqueued' | 'pending' | 'scraped' | 'analyzed' | 'error' | 'waiting_probe';
  error_message?: string;
  telegram_message_id?: number;
  telegram_chat_id?: number;
  created_at?: string;
  updated_at?: string;
}

export interface ProbeDeviceRecord {
  id: string;
  user_id: number;
  access_token: string;
  name?: string;
  last_seen_at?: string;
  created_at?: string;
}

export interface ProbeEventRecord {
  id: string;
  user_id: number;
  link_id?: number;
  url: string;
  url_type: string;
  status: string;
  result?: any;
  error?: string;
  created_at?: string;
  sent_at?: string;
  completed_at?: string;
}

export interface DeviceAuthRequestRecord {
  device_code: string;
  user_code: string;
  user_id?: number;
  status: string;
  expires_at: string;
  created_at?: string;
}

/* ── Kysely table types ── */

interface InvitesTable {
  id: Generated<number>;
  code: string;
  max_uses: number;
  used_count: number;
  created_at: Generated<Date>;
}

interface UsersTable {
  id: Generated<number>;
  telegram_id: number;
  username: string | null;
  display_name: string | null;
  status: string;
  invite_id: number | null;
  created_at: Generated<Date>;
}

interface RecordsTable {
  id: Generated<number>;
  user_id: number;
  type: string;
  url: string | null;
  content: string | null;
  source_url: string | null;
  user_note: string | null;
  added_by_user: boolean;
  og_title: string | null;
  og_description: string | null;
  og_image: string | null;
  og_site_name: string | null;
  og_type: string | null;
  markdown: string | null;
  summary: string | null;
  insight: string | null;
  related_notes: string | null;
  related_links: string | null;
  tags: string | null;
  images: string | null;
  summary_embedding: string | null;
  status: string;
  error_message: string | null;
  telegram_message_id: number | null;
  telegram_chat_id: number | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

interface RecordRelationsTable {
  id: Generated<number>;
  record_id: number;
  related_record_id: number;
  score: number;
  created_at: Generated<Date>;
}

interface RecordDerivationsTable {
  source_record_id: number;
  derived_record_id: number;
  created_at: Generated<Date>;
}

interface ProbeDevicesTable {
  id: string;
  user_id: number;
  access_token: string;
  name: string | null;
  last_seen_at: Date | null;
  created_at: Generated<Date>;
}

interface ProbeEventsTable {
  id: string;
  user_id: number;
  link_id: number | null;
  url: string;
  url_type: string;
  status: string;
  result: any | null;
  error: string | null;
  created_at: Generated<Date>;
  sent_at: Date | null;
  completed_at: Date | null;
}

interface DeviceAuthRequestsTable {
  device_code: string;
  user_code: string;
  user_id: number | null;
  status: string;
  expires_at: Date;
  created_at: Generated<Date>;
}

interface Database {
  invites: InvitesTable;
  users: UsersTable;
  records: RecordsTable;
  record_relations: RecordRelationsTable;
  record_derivations: RecordDerivationsTable;
  probe_devices: ProbeDevicesTable;
  probe_events: ProbeEventsTable;
  device_auth_requests: DeviceAuthRequestsTable;
}

/* ── Database instance ── */

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

/* ── Helpers ── */

/** Convert a DB row to RecordEntry (dates to ISO strings, nulls to undefined) */
function toRecordEntry(row: any): RecordEntry {
  return {
    ...row,
    type: row.type || 'link',
    url: row.url ?? undefined,
    content: row.content ?? undefined,
    source_url: row.source_url ?? undefined,
    user_note: row.user_note ?? undefined,
    added_by_user: row.added_by_user ?? true,
    related_notes:
      row.related_notes != null
        ? typeof row.related_notes === 'string'
          ? row.related_notes
          : JSON.stringify(row.related_notes)
        : undefined,
    related_links:
      row.related_links != null
        ? typeof row.related_links === 'string'
          ? row.related_links
          : JSON.stringify(row.related_links)
        : undefined,
    tags: row.tags != null ? (typeof row.tags === 'string' ? row.tags : JSON.stringify(row.tags)) : undefined,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    og_title: row.og_title ?? undefined,
    og_description: row.og_description ?? undefined,
    og_image: row.og_image ?? undefined,
    og_site_name: row.og_site_name ?? undefined,
    og_type: row.og_type ?? undefined,
    markdown: row.markdown ?? undefined,
    summary: row.summary ?? undefined,
    insight: row.insight ?? undefined,
    images: row.images ?? undefined,
    error_message: row.error_message ?? undefined,
    telegram_message_id: row.telegram_message_id ?? undefined,
    telegram_chat_id: row.telegram_chat_id ?? undefined,
  };
}

function toUserRecord(row: any): UserRecord {
  return {
    ...row,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    username: row.username ?? undefined,
    display_name: row.display_name ?? undefined,
    invite_id: row.invite_id ?? undefined,
  };
}

/* ── Users CRUD ── */

export async function findOrCreateUser(
  telegramId: number,
  username?: string,
  displayName?: string,
): Promise<UserRecord> {
  const existing = await getDb()
    .selectFrom('users')
    .selectAll()
    .where('telegram_id', '=', telegramId)
    .executeTakeFirst();

  if (existing) {
    // Update username/display_name if changed
    if ((username && username !== existing.username) || (displayName && displayName !== existing.display_name)) {
      await getDb()
        .updateTable('users')
        .set({
          ...(username ? { username } : {}),
          ...(displayName ? { display_name: displayName } : {}),
        })
        .where('id', '=', existing.id)
        .execute();
    }
    return toUserRecord(existing);
  }

  // New users start as pending (need invite to activate)
  const result = await getDb()
    .insertInto('users')
    .values({
      telegram_id: telegramId,
      username: username || null,
      display_name: displayName || null,
      status: 'pending',
      invite_id: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return toUserRecord(result);
}

/* ── Invites ── */

export async function getInviteByCode(code: string): Promise<InviteRecord | undefined> {
  const row = await getDb().selectFrom('invites').selectAll().where('code', '=', code).executeTakeFirst();
  if (!row) return undefined;
  return {
    ...row,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

/**
 * Try to use an invite code for a user. Returns true if successful.
 */
export async function useInvite(inviteId: number, userId: number): Promise<boolean> {
  // Increment used_count only if under max_uses (atomic)
  const result = await getDb()
    .updateTable('invites')
    .set({ used_count: sql`used_count + 1` })
    .where('id', '=', inviteId)
    .where(sql<boolean>`used_count < max_uses`)
    .executeTakeFirst();

  if (!result.numUpdatedRows || result.numUpdatedRows === 0n) {
    return false;
  }

  // Activate user
  await getDb().updateTable('users').set({ status: 'active', invite_id: inviteId }).where('id', '=', userId).execute();

  return true;
}

export async function getUserById(id: number): Promise<UserRecord | undefined> {
  const row = await getDb().selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? toUserRecord(row) : undefined;
}

export async function getUserByTelegramId(telegramId: number): Promise<UserRecord | undefined> {
  const row = await getDb().selectFrom('users').selectAll().where('telegram_id', '=', telegramId).executeTakeFirst();
  return row ? toUserRecord(row) : undefined;
}

/* ── Records CRUD ── */

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

/**
 * Insert a note record (convenience function).
 */
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

/**
 * Get enqueued records grouped by user, up to `perUser` per user, ordered by created_at asc.
 */
export async function getEnqueuedRecords(perUser: number): Promise<RecordEntry[]> {
  const rows = await getDb()
    .selectFrom('records')
    .selectAll()
    .where('status', '=', 'enqueued')
    .orderBy('created_at', 'asc')
    .execute();

  // Group by user_id, take up to perUser per user
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

export async function getAllUserRecords(userId: number, type?: RecordType): Promise<RecordEntry[]> {
  let query = getDb().selectFrom('records').selectAll().where('user_id', '=', userId);
  if (type) {
    query = query.where('type', '=', type);
  }
  const rows = await query.orderBy('created_at', 'desc').execute();
  return rows.map(toRecordEntry);
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

export async function deleteRecord(id: number): Promise<void> {
  await getDb().deleteFrom('records').where('id', '=', id).execute();
}

/**
 * Remove a deleted recordId from all other records' related_links JSON arrays.
 */
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

/**
 * Find a record by its associated Telegram message (bot reply message_id).
 */
export async function getRecordByTelegramMessage(chatId: number, messageId: number): Promise<RecordEntry | undefined> {
  const row = await getDb()
    .selectFrom('records')
    .selectAll()
    .where('telegram_chat_id', '=', chatId)
    .where('telegram_message_id', '=', messageId)
    .executeTakeFirst();
  return row ? toRecordEntry(row) : undefined;
}

/**
 * Append text to a record's user_note field.
 * If user_note already has content, appends with newline separator.
 */
export async function appendUserNote(recordId: number, note: string): Promise<void> {
  const record = await getRecord(recordId);
  if (!record) return;

  const existingNote = record.user_note || '';
  const newNote = existingNote ? `${existingNote}\n\n${note}` : note;

  await updateRecord(recordId, { user_note: newNote });
}

/* ── Record Relations ── */

export interface RecordRelation {
  id?: number;
  record_id: number;
  related_record_id: number;
  score: number;
  created_at?: string;
}

/**
 * Save related records for a given record.
 * Replaces existing relations for record_id.
 */
export async function saveRelatedRecords(
  recordId: number,
  relations: { relatedRecordId: number; score: number }[],
): Promise<void> {
  const db = getDb();

  // Delete existing relations for this record
  await db.deleteFrom('record_relations').where('record_id', '=', recordId).execute();

  // Insert new relations
  if (relations.length > 0) {
    await db
      .insertInto('record_relations')
      .values(
        relations.map((r) => ({
          record_id: recordId,
          related_record_id: r.relatedRecordId,
          score: r.score,
        })),
      )
      .execute();
  }
}

/**
 * Get related records for a given record (bidirectional).
 * Queries both directions: records I found related + records that found me related.
 * Returns deduplicated results ordered by score, max 5.
 */
export async function getRelatedRecords(recordId: number): Promise<{ relatedRecordId: number; score: number }[]> {
  const db = getDb();

  // Query 1: records I found related (record_id = me)
  const outgoing = await db
    .selectFrom('record_relations')
    .select(['related_record_id as other_id', 'score'])
    .where('record_id', '=', recordId)
    .execute();

  // Query 2: records that found me related (related_record_id = me)
  const incoming = await db
    .selectFrom('record_relations')
    .select(['record_id as other_id', 'score'])
    .where('related_record_id', '=', recordId)
    .execute();

  // Merge and dedupe (keep highest score if duplicate)
  const scoreMap = new Map<number, number>();
  for (const row of [...outgoing, ...incoming]) {
    const otherId = (row as any).other_id;
    const existing = scoreMap.get(otherId);
    if (!existing || row.score > existing) {
      scoreMap.set(otherId, row.score);
    }
  }

  // Sort by score desc, take top 5
  const results = Array.from(scoreMap.entries())
    .map(([relatedRecordId, score]) => ({ relatedRecordId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return results;
}

/* ── Record Derivations ── */

/**
 * Record a derivation relationship (source → derived).
 */
export async function addDerivation(sourceRecordId: number, derivedRecordId: number): Promise<void> {
  await getDb()
    .insertInto('record_derivations')
    .values({ source_record_id: sourceRecordId, derived_record_id: derivedRecordId })
    .onConflict((oc) => oc.columns(['source_record_id', 'derived_record_id']).doNothing())
    .execute();
}

/**
 * Get all source records that derived this record.
 */
export async function getDerivationSources(recordId: number): Promise<number[]> {
  const rows = await getDb()
    .selectFrom('record_derivations')
    .select('source_record_id')
    .where('derived_record_id', '=', recordId)
    .execute();
  return rows.map((r) => r.source_record_id);
}

/**
 * Get all records derived from this record.
 */
export async function getDerivedRecords(recordId: number): Promise<number[]> {
  const rows = await getDb()
    .selectFrom('record_derivations')
    .select('derived_record_id')
    .where('source_record_id', '=', recordId)
    .execute();
  return rows.map((r) => r.derived_record_id);
}

/* ── Probe Devices CRUD ── */

export async function createProbeDevice(
  id: string,
  userId: number,
  accessToken: string,
  name?: string,
): Promise<ProbeDeviceRecord> {
  const row = await getDb()
    .insertInto('probe_devices')
    .values({
      id,
      user_id: userId,
      access_token: accessToken,
      name: name || null,
      last_seen_at: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return {
    ...row,
    name: row.name ?? undefined,
    last_seen_at: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : undefined,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

export async function getProbeDeviceByToken(token: string): Promise<ProbeDeviceRecord | undefined> {
  const row = await getDb()
    .selectFrom('probe_devices')
    .selectAll()
    .where('access_token', '=', token)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    ...row,
    name: row.name ?? undefined,
    last_seen_at: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : undefined,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

export async function updateProbeDeviceLastSeen(id: string): Promise<void> {
  await getDb().updateTable('probe_devices').set({ last_seen_at: sql`NOW()` }).where('id', '=', id).execute();
}

export async function getProbeDevicesByUserId(userId: number): Promise<ProbeDeviceRecord[]> {
  const rows = await getDb()
    .selectFrom('probe_devices')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map((row) => ({
    ...row,
    name: row.name ?? undefined,
    last_seen_at: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : undefined,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
}

/* ── Probe Events CRUD ── */

export async function createProbeEvent(
  id: string,
  userId: number,
  linkId: number | undefined,
  url: string,
  urlType: string,
): Promise<ProbeEventRecord> {
  const row = await getDb()
    .insertInto('probe_events')
    .values({
      id,
      user_id: userId,
      link_id: linkId ?? null,
      url,
      url_type: urlType,
      status: 'pending',
      result: null,
      error: null,
      sent_at: null,
      completed_at: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toProbeEventRecord(row);
}

export async function getProbeEventById(id: string): Promise<ProbeEventRecord | undefined> {
  const row = await getDb().selectFrom('probe_events').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) return undefined;
  return toProbeEventRecord(row);
}

export async function updateProbeEventStatus(id: string, status: string, result?: any, error?: string): Promise<void> {
  const update: Record<string, any> = { status };
  if (result !== undefined) update.result = JSON.stringify(result);
  if (error !== undefined) update.error = error;
  if (status === 'sent') update.sent_at = sql`NOW()`;
  if (status === 'completed' || status === 'error') update.completed_at = sql`NOW()`;
  await getDb().updateTable('probe_events').set(update).where('id', '=', id).execute();
}

export async function getPendingProbeEvents(userId: number): Promise<ProbeEventRecord[]> {
  const rows = await getDb()
    .selectFrom('probe_events')
    .selectAll()
    .where('user_id', '=', userId)
    .where('status', '=', 'pending')
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map(toProbeEventRecord);
}

function toProbeEventRecord(row: any): ProbeEventRecord {
  return {
    ...row,
    link_id: row.link_id ?? undefined,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    sent_at: row.sent_at instanceof Date ? row.sent_at.toISOString() : undefined,
    completed_at: row.completed_at instanceof Date ? row.completed_at.toISOString() : undefined,
  };
}

/* ── Device Auth Requests CRUD ── */

export async function createDeviceAuthRequest(
  deviceCode: string,
  userCode: string,
  expiresAt: Date,
): Promise<DeviceAuthRequestRecord> {
  const row = await getDb()
    .insertInto('device_auth_requests')
    .values({
      device_code: deviceCode,
      user_code: userCode,
      user_id: null,
      status: 'pending',
      expires_at: expiresAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toDeviceAuthRecord(row);
}

export async function getDeviceAuthRequest(deviceCode: string): Promise<DeviceAuthRequestRecord | undefined> {
  const row = await getDb()
    .selectFrom('device_auth_requests')
    .selectAll()
    .where('device_code', '=', deviceCode)
    .executeTakeFirst();
  if (!row) return undefined;
  return toDeviceAuthRecord(row);
}

export async function getDeviceAuthRequestByUserCode(userCode: string): Promise<DeviceAuthRequestRecord | undefined> {
  const row = await getDb()
    .selectFrom('device_auth_requests')
    .selectAll()
    .where('user_code', '=', userCode)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  if (!row) return undefined;
  return toDeviceAuthRecord(row);
}

export async function authorizeDeviceAuthRequest(deviceCode: string, userId: number): Promise<void> {
  await getDb()
    .updateTable('device_auth_requests')
    .set({ status: 'authorized', user_id: userId })
    .where('device_code', '=', deviceCode)
    .execute();
}

function toDeviceAuthRecord(row: any): DeviceAuthRequestRecord {
  return {
    ...row,
    user_id: row.user_id ?? undefined,
    expires_at: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}
