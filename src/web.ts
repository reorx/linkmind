/**
 * Web server: serves permanent link pages for analyzed articles.
 */

import fs from 'fs';
import path from 'path';
import ejs from 'ejs';
import express from 'express';
import { getLink, getRecentLinks, getPaginatedLinks } from './db.js';
import { processUrl } from './pipeline.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'web' });

const VIEWS_DIR = path.resolve(import.meta.dirname, 'views');

/* ── qmd → Obsidian path mapping ── */

/**
 * Normalize a filename the same way qmd does:
 * lowercase, replace spaces/dots/special chars with hyphens, collapse multiples.
 */
function qmdNormalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Build a lookup map: qmd-normalized relative path → real relative path.
 * Scans the vault directory recursively (once at startup).
 */
function buildVaultLookup(vaultPath: string): Map<string, string> {
  const lookup = new Map<string, string>();
  if (!vaultPath || !fs.existsSync(vaultPath)) return lookup;

  function walk(dir: string, rel: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const realRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), realRel);
      } else if (e.name.endsWith('.md')) {
        // Build normalized key: each path segment gets normalized independently
        // For the filename, strip .md before normalizing, then add it back
        const parts = realRel.split('/');
        const normalizedParts = parts.map((part, i) => {
          if (i === parts.length - 1 && part.endsWith('.md')) {
            return qmdNormalize(part.slice(0, -3)) + '.md';
          }
          return qmdNormalize(part);
        });
        const key = normalizedParts.join('/');
        lookup.set(key, realRel);
      }
    }
  }

  walk(vaultPath, '');
  log.info({ entries: lookup.size }, 'Obsidian vault lookup built');
  return lookup;
}

// Initialized lazily in startWebServer (after dotenv has loaded)
let OBSIDIAN_VAULT = 'Obsidian-Base';
let QMD_NOTES_COLLECTION = 'notes';
let vaultLookup = new Map<string, string>();

/* ── helpers ── */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeParseJson(s?: string): any[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Convert a qmd path (e.g. qmd://notes/80-zettelkasten-notes/foo-bar.md)
 * to an obsidian:// URL using the vault filesystem lookup.
 */
function buildObsidianUrl(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  const prefix = `qmd://${QMD_NOTES_COLLECTION}/`;
  let qmdRel = filePath;
  if (qmdRel.startsWith(prefix)) {
    qmdRel = qmdRel.slice(prefix.length);
  }

  // Try to find real path from lookup
  const realRel = vaultLookup.get(qmdRel);
  let notePath: string;
  if (realRel) {
    notePath = realRel;
  } else {
    // Fallback: use qmd path as-is (better than nothing)
    notePath = qmdRel;
  }

  // Remove .md extension for Obsidian URL
  if (notePath.endsWith('.md')) {
    notePath = notePath.slice(0, -3);
  }
  return `obsidian://open?vault=${encodeURIComponent(OBSIDIAN_VAULT)}&file=${encodeURIComponent(notePath)}`;
}

function getDayLabel(dateStr?: string): string {
  if (!dateStr) return 'Unknown';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return 'Unknown';

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (target.getTime() === today.getTime()) return 'Today';
  if (target.getTime() === yesterday.getTime()) return 'Yesterday';

  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

async function renderPage(template: string, data: Record<string, any>): Promise<string> {
  const layoutPath = path.join(VIEWS_DIR, 'layout.ejs');
  const contentPath = path.join(VIEWS_DIR, `${template}.ejs`);

  const body = await ejs.renderFile(contentPath, data);
  return ejs.renderFile(layoutPath, { ...data, body });
}

/* ── server ── */

export function startWebServer(port: number): void {
  // Read env vars here (after dotenv has loaded in index.ts)
  OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT || 'Obsidian-Base';
  QMD_NOTES_COLLECTION = process.env.QMD_NOTES_COLLECTION || 'notes';
  vaultLookup = buildVaultLookup(process.env.OBSIDIAN_VAULT_PATH || '');

  const app = express();

  app.use(express.json());

  // POST /api/links — add a new link and process it
  app.post('/api/links', async (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: "Missing or invalid 'url' field" });
      return;
    }

    try {
      const result = await processUrl(url);
      const link = getLink(result.linkId);
      res.json({
        id: result.linkId,
        url: result.url,
        title: result.title,
        status: result.status,
        error: result.error,
        link: link ? `/link/${result.linkId}` : undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // GET /api/links — list recent links
  app.get('/api/links', (req, res) => {
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const links = getRecentLinks(limit);
    res.json(
      links.map((l) => ({
        id: l.id,
        url: l.url,
        title: l.og_title,
        status: l.status,
        created_at: l.created_at,
        link: `/link/${l.id}`,
      })),
    );
  });

  // GET /api/links/:id — get a single link detail
  app.get('/api/links/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }
    const link = getLink(id);
    if (!link) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json({
      ...link,
      tags: safeParseJson(link.tags),
      related_notes: safeParseJson(link.related_notes),
      related_links: safeParseJson(link.related_links),
    });
  });

  // GET / — homepage with timeline
  app.get('/', async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
      const { links, total, page: safePage, totalPages } = getPaginatedLinks(page, 50);

      const linksWithDay = links.map((l) => ({
        ...l,
        _dayLabel: getDayLabel(l.created_at),
      }));

      const html = await renderPage('home', {
        pageTitle: 'LinkMind',
        links: linksWithDay,
        page: safePage,
        total,
        totalPages,
      });
      res.type('html').send(html);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Home render failed');
      res.status(500).send('Internal error');
    }
  });

  // GET /link/:id — link detail page
  app.get('/link/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).send('Invalid ID');
      return;
    }

    const link = getLink(id);
    if (!link) {
      res.status(404).send('Not found');
      return;
    }

    const tags = safeParseJson(link.tags);
    const rawNotes = safeParseJson(link.related_notes);
    const relatedNotes = rawNotes.map((n: any) => ({
      ...n,
      obsidianUrl: buildObsidianUrl(n.path || n.file),
    }));
    const relatedLinks = safeParseJson(link.related_links);

    try {
      const html = await renderPage('link-detail', {
        pageTitle: `${link.og_title || link.url} — LinkMind`,
        link,
        tags,
        relatedNotes,
        relatedLinks,
      });
      res.type('html').send(html);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Detail render failed');
      res.status(500).send('Internal error');
    }
  });

  app.listen(port, () => {
    log.info({ port }, `Server listening on http://localhost:${port}`);
  });
}
