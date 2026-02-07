import { Generated, Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

/* ── Types ── */

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

export interface LinkRecord {
  id?: number;
  user_id: number;
  url: string;
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
  status: 'pending' | 'scraped' | 'analyzed' | 'error' | 'waiting_probe';
  error_message?: string;
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

interface LinksTable {
  id: Generated<number>;
  user_id: number;
  url: string;
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
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

interface LinkRelationsTable {
  id: Generated<number>;
  link_id: number;
  related_link_id: number;
  score: number;
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
  links: LinksTable;
  link_relations: LinkRelationsTable;
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

/** Convert a DB row to LinkRecord (dates to ISO strings, nulls to undefined) */
function toLinkRecord(row: any): LinkRecord {
  return {
    ...row,
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

/* ── Links CRUD ── */

export async function insertLink(userId: number, url: string): Promise<number> {
  const result = await getDb()
    .insertInto('links')
    .values({ user_id: userId, url, status: 'pending' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return result.id;
}

export async function updateLink(id: number, data: Partial<LinkRecord>): Promise<void> {
  const { id: _id, user_id: _uid, created_at: _ca, ...rest } = data as any;
  await getDb()
    .updateTable('links')
    .set({ ...rest, updated_at: sql`NOW()` })
    .where('id', '=', id)
    .execute();
}

export async function getLink(id: number): Promise<LinkRecord | undefined> {
  const row = await getDb().selectFrom('links').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? toLinkRecord(row) : undefined;
}

export async function getLinkByUrl(userId: number, url: string): Promise<LinkRecord | undefined> {
  const row = await getDb()
    .selectFrom('links')
    .selectAll()
    .where('user_id', '=', userId)
    .where('url', '=', url)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? toLinkRecord(row) : undefined;
}

export async function getRecentLinks(userId: number, limit: number = 20): Promise<LinkRecord[]> {
  const rows = await getDb()
    .selectFrom('links')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
  return rows.map(toLinkRecord);
}

export async function getPaginatedLinks(
  userId: number,
  page: number = 1,
  perPage: number = 50,
): Promise<{ links: LinkRecord[]; total: number; page: number; totalPages: number }> {
  const { count } = await getDb()
    .selectFrom('links')
    .select(sql<number>`count(*)::int`.as('count'))
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();

  const total = count;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const offset = (safePage - 1) * perPage;

  const rows = await getDb()
    .selectFrom('links')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(perPage)
    .offset(offset)
    .execute();

  return { links: rows.map(toLinkRecord), total, page: safePage, totalPages };
}

export async function getAllAnalyzedLinks(userId?: number): Promise<LinkRecord[]> {
  let query = getDb().selectFrom('links').selectAll().where('status', '=', 'analyzed');
  if (userId != null) {
    query = query.where('user_id', '=', userId);
  }
  const rows = await query.orderBy('id', 'asc').execute();
  return rows.map(toLinkRecord);
}

export async function getFailedLinks(userId?: number): Promise<LinkRecord[]> {
  let query = getDb().selectFrom('links').selectAll().where('status', '=', 'error');
  if (userId != null) {
    query = query.where('user_id', '=', userId);
  }
  const rows = await query.orderBy('id', 'desc').execute();
  return rows.map(toLinkRecord);
}

export async function deleteLink(id: number): Promise<void> {
  await getDb().deleteFrom('links').where('id', '=', id).execute();
}

/**
 * Remove a deleted linkId from all other links' related_links JSON arrays.
 */
export async function removeFromRelatedLinks(deletedLinkId: number): Promise<number> {
  const links = await getDb()
    .selectFrom('links')
    .select(['id', 'related_links'])
    .where('status', '=', 'analyzed')
    .where('related_links', 'is not', null)
    .execute();

  let updated = 0;
  for (const link of links) {
    const related: number[] = JSON.parse(
      typeof link.related_links === 'string' ? link.related_links : JSON.stringify(link.related_links || []),
    );
    // related_links is now an array of IDs: [42, 37, 15, ...]
    const filtered = related.filter((id: number) => id !== deletedLinkId);
    if (filtered.length !== related.length) {
      await getDb()
        .updateTable('links')
        .set({ related_links: JSON.stringify(filtered), updated_at: sql`NOW()` })
        .where('id', '=', link.id)
        .execute();
      updated++;
    }
  }
  return updated;
}

export async function searchLinks(query: string, limit: number = 10, userId?: number): Promise<LinkRecord[]> {
  const pattern = `%${query}%`;
  let q = getDb().selectFrom('links').selectAll().where('status', '=', 'analyzed');
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
      ]),
    )
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
  return rows.map(toLinkRecord);
}

/* ── Link Relations ── */

export interface LinkRelation {
  id?: number;
  link_id: number;
  related_link_id: number;
  score: number;
  created_at?: string;
}

/**
 * Save related links for a given link.
 * Replaces existing relations for link_id.
 * @param linkId - The source link
 * @param relations - Array of {relatedLinkId, score}
 */
export async function saveRelatedLinks(
  linkId: number,
  relations: { relatedLinkId: number; score: number }[],
): Promise<void> {
  const db = getDb();

  // Delete existing relations for this link
  await db.deleteFrom('link_relations').where('link_id', '=', linkId).execute();

  // Insert new relations
  if (relations.length > 0) {
    await db
      .insertInto('link_relations')
      .values(
        relations.map((r) => ({
          link_id: linkId,
          related_link_id: r.relatedLinkId,
          score: r.score,
        })),
      )
      .execute();
  }
}

/**
 * Get related links for a given link (bidirectional).
 * Queries both directions: links I found related + links that found me related.
 * Returns deduplicated results ordered by score, max 5.
 */
export async function getRelatedLinks(linkId: number): Promise<{ relatedLinkId: number; score: number }[]> {
  const db = getDb();

  // Query 1: links I found related (link_id = me)
  const outgoing = await db
    .selectFrom('link_relations')
    .select(['related_link_id as other_id', 'score'])
    .where('link_id', '=', linkId)
    .execute();

  // Query 2: links that found me related (related_link_id = me)
  const incoming = await db
    .selectFrom('link_relations')
    .select(['link_id as other_id', 'score'])
    .where('related_link_id', '=', linkId)
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
    .map(([relatedLinkId, score]) => ({ relatedLinkId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return results;
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
