/**
 * Web server: serves permanent link pages for analyzed articles.
 * Auth via JWT cookie (issued by Telegram bot /login command).
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import path from 'path';
import ejs from 'ejs';
import express, { type Request, type Response, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { getLink, getRecentLinks, getPaginatedLinks, getFailedLinks, getUserById } from './db.js';
import { retryLink, deleteLinkFull } from './pipeline.js';
import { spawnProcessLink } from './worker.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'web' });

const VIEWS_DIR = path.resolve(import.meta.dirname, 'views');
const COOKIE_NAME = 'lm_session';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required');
  return secret;
}

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

/* ── Auth middleware ── */

interface AuthRequest extends Request {
  userId?: number;
  user?: { id: number; display_name?: string; username?: string };
}

/**
 * Auth middleware: verify session cookie and attach userId to request.
 * Returns 401 JSON for API routes, redirects to login page for HTML routes.
 */
function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    return sendUnauth(req, res);
  }

  try {
    const payload = jwt.verify(token, getJwtSecret()) as { userId: number };
    req.userId = payload.userId;
    // Load user info asynchronously
    getUserById(payload.userId).then((user) => {
      if (!user) {
        return sendUnauth(req, res);
      }
      req.user = { id: user.id!, display_name: user.display_name, username: user.username };
      next();
    });
  } catch {
    return sendUnauth(req, res);
  }
}

function sendUnauth(req: Request, res: Response): void {
  if (req.path.startsWith('/api/')) {
    res.status(401).json({ error: 'Unauthorized. Use /login in the Telegram bot to get a login link.' });
  } else {
    res.redirect('/login');
  }
}

/* ── server ── */

export function startWebServer(port: number): void {
  const app = express();

  app.use(express.json());
  app.use(cookieParser());

  // ── Public routes ──

  // GET /auth/callback — handle login from Telegram bot
  app.get('/auth/callback', async (req, res) => {
    const loginToken = req.query.token as string;
    if (!loginToken) {
      res.status(400).send('Missing token');
      return;
    }

    try {
      const payload = jwt.verify(loginToken, getJwtSecret()) as { userId: number; telegramId: number };

      // Issue a longer-lived session cookie
      const sessionToken = jwt.sign({ userId: payload.userId }, getJwtSecret(), { expiresIn: '7d' });

      res.cookie(COOKIE_NAME, sessionToken, {
        httpOnly: true,
        maxAge: COOKIE_MAX_AGE,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
      });

      log.info({ userId: payload.userId, telegramId: payload.telegramId }, 'User logged in via callback');
      res.redirect('/');
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Invalid login token');
      res.status(401).send('登录链接已过期或无效，请在 Telegram Bot 中重新发送 /login');
    }
  });

  // GET /login — login prompt page
  app.get('/login', async (req, res) => {
    // If already logged in, redirect to home
    const token = req.cookies?.[COOKIE_NAME];
    if (token) {
      try {
        jwt.verify(token, getJwtSecret());
        res.redirect('/');
        return;
      } catch {
        // Invalid token, show login page
      }
    }

    try {
      const html = await renderPage('login', { pageTitle: '登录 — LinkMind' });
      res.type('html').send(html);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Login page render failed');
      res.status(500).send('Internal error');
    }
  });

  // GET /logout
  app.get('/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME);
    res.redirect('/login');
  });

  // ── Protected API routes ──

  // POST /api/links — add a new link and process it
  app.post('/api/links', requireAuth, async (req: AuthRequest, res) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: "Missing or invalid 'url' field" });
      return;
    }

    try {
      const { taskId } = await spawnProcessLink(req.userId!, url);
      res.json({
        taskId,
        url,
        status: 'queued',
        message: 'Link queued for processing',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // GET /api/links — list recent links
  app.get('/api/links', requireAuth, async (req: AuthRequest, res) => {
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const links = await getRecentLinks(req.userId!, limit);
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
  app.get('/api/links/:id', requireAuth, async (req: AuthRequest, res) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }
    const link = await getLink(id);
    if (!link || link.user_id !== req.userId) {
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
  app.delete('/api/links/:id', requireAuth, async (req: AuthRequest, res) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }
    const link = await getLink(id);
    if (!link || link.user_id !== req.userId) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const result = await deleteLinkFull(id);
    log.info({ linkId: id, url: result.url, relatedLinksUpdated: result.relatedLinksUpdated }, 'Link deleted via API');
    res.json({
      message: 'Link deleted',
      ...result,
    });
  });

  // POST /api/retry — retry all failed links
  app.post('/api/retry', requireAuth, async (req: AuthRequest, res) => {
    const failed = await getFailedLinks(req.userId!);
    if (failed.length === 0) {
      res.json({ message: 'No failed links to retry', retried: 0 });
      return;
    }

    log.info({ count: failed.length }, 'Retrying failed links');

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
  app.post('/api/retry/:id', requireAuth, async (req: AuthRequest, res) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }

    const link = await getLink(id);
    if (!link || link.user_id !== req.userId) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    log.info({ linkId: id, url: link.url }, 'Retrying single link');
    const result = await retryLink(id);
    res.json(result);
  });

  // ── Protected page routes ──

  // GET / — homepage with timeline
  app.get('/', requireAuth, async (req: AuthRequest, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
      const { links, total, page: safePage, totalPages } = await getPaginatedLinks(req.userId!, page, 50);

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
        user: req.user,
      });
      res.type('html').send(html);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Home render failed');
      res.status(500).send('Internal error');
    }
  });

  // GET /link/:id — link detail page
  app.get('/link/:id', requireAuth, async (req: AuthRequest, res) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).send('Invalid ID');
      return;
    }

    const link = await getLink(id);
    if (!link || link.user_id !== req.userId) {
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
        user: req.user,
      });
      res.type('html').send(html);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Detail render failed');
      res.status(500).send('Internal error');
    }
  });

  // GET /note — view a note fetched via qmd
  app.get('/note', requireAuth, async (req: AuthRequest, res) => {
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

    const segments = qmdPath.split('/');
    const fileName = segments[segments.length - 1] || 'Note';
    const title = fileName.replace(/\.md$/, '').replace(/-/g, ' ');

    try {
      const html = await renderPage('note', {
        pageTitle: `${title} — LinkMind`,
        title,
        qmdPath,
        content,
        user: req.user,
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
