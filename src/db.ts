import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const DB_DIR = path.resolve('data');
const DB_PATH = path.join(DB_DIR, 'linkmind.db');

let db: Database.Database | null = null;

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
  related_notes?: string; // JSON array
  related_links?: string; // JSON array
  tags?: string; // JSON array
  status: 'pending' | 'scraped' | 'analyzed' | 'error';
  error_message?: string;
  created_at?: string;
  updated_at?: string;
}

export function getDb(): Database.Database {
  if (db) return db;

  fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      og_title TEXT,
      og_description TEXT,
      og_image TEXT,
      og_site_name TEXT,
      og_type TEXT,
      markdown TEXT,
      summary TEXT,
      insight TEXT,
      related_notes TEXT DEFAULT '[]',
      related_links TEXT DEFAULT '[]',
      tags TEXT DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  return db;
}

export function insertLink(url: string): number {
  const db = getDb();
  const stmt = db.prepare('INSERT INTO links (url) VALUES (?)');
  const result = stmt.run(url);
  return result.lastInsertRowid as number;
}

export function updateLink(id: number, data: Partial<LinkRecord>): void {
  const db = getDb();
  const fields = Object.keys(data)
    .map((k) => `${k} = ?`)
    .join(', ');
  const values = Object.values(data);
  db.prepare(`UPDATE links SET ${fields}, updated_at = datetime('now') WHERE id = ?`).run(...values, id);
}

export function getLink(id: number): LinkRecord | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM links WHERE id = ?').get(id) as LinkRecord | undefined;
}

export function getLinkByUrl(url: string): LinkRecord | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM links WHERE url = ? ORDER BY id DESC LIMIT 1').get(url) as LinkRecord | undefined;
}

export function getRecentLinks(limit: number = 20): LinkRecord[] {
  const db = getDb();
  return db.prepare('SELECT * FROM links ORDER BY id DESC LIMIT ?').all(limit) as LinkRecord[];
}

export function getPaginatedLinks(
  page: number = 1,
  perPage: number = 50,
): { links: LinkRecord[]; total: number; page: number; totalPages: number } {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as count FROM links').get() as { count: number }).count;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const offset = (safePage - 1) * perPage;
  const links = db
    .prepare('SELECT * FROM links ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
    .all(perPage, offset) as LinkRecord[];
  return { links, total, page: safePage, totalPages };
}

export function getAllAnalyzedLinks(): LinkRecord[] {
  const db = getDb();
  return db.prepare("SELECT * FROM links WHERE status = 'analyzed' ORDER BY id ASC").all() as LinkRecord[];
}

export function getFailedLinks(): LinkRecord[] {
  const db = getDb();
  return db.prepare("SELECT * FROM links WHERE status = 'error' ORDER BY id DESC").all() as LinkRecord[];
}

export function deleteLink(id: number): void {
  const db = getDb();
  db.prepare('DELETE FROM links WHERE id = ?').run(id);
}

/**
 * Remove a deleted linkId from all other links' related_links JSON arrays.
 */
export function removeFromRelatedLinks(deletedLinkId: number): number {
  const db = getDb();
  // Find all analyzed links that might reference this linkId
  const links = db
    .prepare("SELECT id, related_links FROM links WHERE status = 'analyzed' AND related_links IS NOT NULL")
    .all() as Pick<LinkRecord, 'id' | 'related_links'>[];

  let updated = 0;
  for (const link of links) {
    const related: any[] = JSON.parse(link.related_links || '[]');
    const filtered = related.filter((r: any) => r.linkId !== deletedLinkId);
    if (filtered.length !== related.length) {
      db.prepare("UPDATE links SET related_links = ?, updated_at = datetime('now') WHERE id = ?").run(
        JSON.stringify(filtered),
        link.id,
      );
      updated++;
    }
  }
  return updated;
}

export function searchLinks(query: string, limit: number = 10): LinkRecord[] {
  const db = getDb();
  const pattern = `%${query}%`;
  return db
    .prepare(
      `SELECT * FROM links
       WHERE status = 'analyzed'
       AND (og_title LIKE ? OR og_description LIKE ? OR summary LIKE ? OR markdown LIKE ?)
       ORDER BY id DESC LIMIT ?`,
    )
    .all(pattern, pattern, pattern, pattern, limit) as LinkRecord[];
}
