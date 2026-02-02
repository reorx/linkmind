/**
 * Web server: serves permanent link pages for analyzed articles.
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import path from 'path';
import ejs from 'ejs';
import express from 'express';
import { getLink, getRecentLinks, getPaginatedLinks, getFailedLinks } from './db.js';
import { processUrl, retryLink, deleteLinkFull } from './pipeline.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'web' });

const VIEWS_DIR = path.resolve(import.meta.dirname, 'views');

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
 * Fetch note content via `qmd get`.
 */
async function qmdGet(qmdPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync(`qmd get "${qmdPath.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    return stdout.trim();
  } catch (err) {
    log.warn({ path: qmdPath, err: err instanceof Error ? err.message : String(err) }, 'qmd get failed');
    return undefined;
  }
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
        duplicate: result.duplicate || false,
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

  // DELETE /api/links/:id — delete a link and clean up references
  app.delete('/api/links/:id', (req, res) => {
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

    const result = deleteLinkFull(id);
    log.info({ linkId: id, url: result.url, relatedLinksUpdated: result.relatedLinksUpdated }, 'Link deleted via API');
    res.json({
      message: 'Link deleted',
      ...result,
    });
  });

  // POST /api/retry — retry all failed links
  app.post('/api/retry', async (req, res) => {
    const failed = getFailedLinks();
    if (failed.length === 0) {
      res.json({ message: 'No failed links to retry', retried: 0 });
      return;
    }

    log.info({ count: failed.length }, 'Retrying failed links');

    // Run retries in background, return immediately
    const ids = failed.map((l) => l.id!);
    res.json({ message: `Retrying ${ids.length} failed link(s)`, ids });

    for (const id of ids) {
      try {
        await retryLink(id);
      } catch (err) {
        log.error({ linkId: id, err: err instanceof Error ? err.message : String(err) }, 'Retry failed');
      }
    }
  });

  // POST /api/retry/:id — retry a single failed link
  app.post('/api/retry/:id', async (req, res) => {
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

    log.info({ linkId: id, url: link.url }, 'Retrying single link');
    const result = await retryLink(id);
    res.json(result);
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
      noteUrl: n.path ? `/note?path=${encodeURIComponent(n.path)}` : undefined,
    }));
    const relatedLinks = safeParseJson(link.related_links).map((l: any) => ({
      ...l,
      url: l.linkId ? `/link/${l.linkId}` : l.url,
    }));

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

  // GET /note — view a note fetched via qmd
  app.get('/note', async (req, res) => {
    const qmdPath = req.query.path as string;
    if (!qmdPath || !qmdPath.startsWith('qmd://')) {
      res.status(400).send('Invalid path');
      return;
    }

    const content = await qmdGet(qmdPath);
    if (content === undefined) {
      res.status(404).send('Note not found');
      return;
    }

    // Extract a title from the path (last segment without .md)
    const segments = qmdPath.split('/');
    const fileName = segments[segments.length - 1] || 'Note';
    const title = fileName.replace(/\.md$/, '').replace(/-/g, ' ');

    try {
      const html = await renderPage('note', {
        pageTitle: `${title} — LinkMind`,
        title,
        qmdPath,
        content,
      });
      res.type('html').send(html);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Note render failed');
      res.status(500).send('Internal error');
    }
  });

  app.listen(port, () => {
    log.info({ port }, `Server listening on http://localhost:${port}`);
  });
}
