import { Generated, Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

/* ── Types ── */

export interface LinkRecord {
  id?: number;
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
  status: 'pending' | 'scraped' | 'analyzed' | 'error';
  error_message?: string;
  created_at?: string;
  updated_at?: string;
}

interface LinksTable {
  id: Generated<number>;
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
  status: string;
  error_message: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

interface Database {
  links: LinksTable;
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
function toRecord(row: any): LinkRecord {
  return {
    ...row,
    related_notes: row.related_notes != null ? (typeof row.related_notes === 'string' ? row.related_notes : JSON.stringify(row.related_notes)) : undefined,
    related_links: row.related_links != null ? (typeof row.related_links === 'string' ? row.related_links : JSON.stringify(row.related_links)) : undefined,
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
    error_message: row.error_message ?? undefined,
  };
}

/* ── CRUD ── */

export async function insertLink(url: string): Promise<number> {
  const result = await getDb()
    .insertInto('links')
    .values({ url, status: 'pending' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return result.id;
}

export async function updateLink(id: number, data: Partial<LinkRecord>): Promise<void> {
  const { id: _id, created_at: _ca, ...rest } = data as any;
  await getDb()
    .updateTable('links')
    .set({ ...rest, updated_at: sql`NOW()` })
    .where('id', '=', id)
    .execute();
}

export async function getLink(id: number): Promise<LinkRecord | undefined> {
  const row = await getDb()
    .selectFrom('links')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return row ? toRecord(row) : undefined;
}

export async function getLinkByUrl(url: string): Promise<LinkRecord | undefined> {
  const row = await getDb()
    .selectFrom('links')
    .selectAll()
    .where('url', '=', url)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? toRecord(row) : undefined;
}

export async function getRecentLinks(limit: number = 20): Promise<LinkRecord[]> {
  const rows = await getDb()
    .selectFrom('links')
    .selectAll()
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
  return rows.map(toRecord);
}

export async function getPaginatedLinks(
  page: number = 1,
  perPage: number = 50,
): Promise<{ links: LinkRecord[]; total: number; page: number; totalPages: number }> {
  const { count } = await getDb()
    .selectFrom('links')
    .select(sql<number>`count(*)::int`.as('count'))
    .executeTakeFirstOrThrow();

  const total = count;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const offset = (safePage - 1) * perPage;

  const rows = await getDb()
    .selectFrom('links')
    .selectAll()
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(perPage)
    .offset(offset)
    .execute();

  return { links: rows.map(toRecord), total, page: safePage, totalPages };
}

export async function getAllAnalyzedLinks(): Promise<LinkRecord[]> {
  const rows = await getDb()
    .selectFrom('links')
    .selectAll()
    .where('status', '=', 'analyzed')
    .orderBy('id', 'asc')
    .execute();
  return rows.map(toRecord);
}

export async function getFailedLinks(): Promise<LinkRecord[]> {
  const rows = await getDb()
    .selectFrom('links')
    .selectAll()
    .where('status', '=', 'error')
    .orderBy('id', 'desc')
    .execute();
  return rows.map(toRecord);
}

export async function deleteLink(id: number): Promise<void> {
  await getDb()
    .deleteFrom('links')
    .where('id', '=', id)
    .execute();
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
    const related: any[] = JSON.parse(
      typeof link.related_links === 'string' ? link.related_links : JSON.stringify(link.related_links || []),
    );
    const filtered = related.filter((r: any) => r.linkId !== deletedLinkId);
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

export async function searchLinks(query: string, limit: number = 10): Promise<LinkRecord[]> {
  const pattern = `%${query}%`;
  const rows = await getDb()
    .selectFrom('links')
    .selectAll()
    .where('status', '=', 'analyzed')
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
  return rows.map(toRecord);
}
