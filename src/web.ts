/**
 * Web server: serves permanent link pages for analyzed articles.
 * Auth via JWT cookie (issued by Telegram bot /login command).
 */

import crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import path from 'path';
import ejs from 'ejs';
import express, { type Request, type Response, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import {
  getLink,
  getRecentLinks,
  getPaginatedLinks,
  getFailedLinks,
  getUserById,
  getRelatedLinks,
  getProbeDeviceByToken,
  updateProbeDeviceLastSeen,
  createProbeDevice,
  getProbeDevicesByUserId,
  createDeviceAuthRequest,
  getDeviceAuthRequest,
  getDeviceAuthRequestByUserCode,
  authorizeDeviceAuthRequest,
  createProbeEvent,
  getProbeEventById,
  updateProbeEventStatus,
  getPendingProbeEvents,
} from './db.js';
import { retryLink, deleteLinkFull, spawnProcessLink, handleProbeResult } from './pipeline.js';
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

// TODO: 未来可能会换成 mykb 调用
// /**
//  * Fetch note content via `qmd get`.
//  */
// async function qmdGet(qmdPath: string): Promise<string | undefined> {
//   try {
//     const { stdout } = await execAsync(`qmd get "${qmdPath.replace(/"/g, '\\"')}"`, {
//       encoding: 'utf-8',
//       timeout: 10000,
//     });
//     return stdout.trim();
//   } catch (err) {
//     log.warn({ path: qmdPath, err: err instanceof Error ? err.message : String(err) }, 'qmd get failed');
//     return undefined;
//   }
// }

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

/* ── Probe auth middleware ── */

interface ProbeAuthRequest extends Request {
  userId?: number;
  deviceId?: string;
}

function requireProbeAuth(req: ProbeAuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  getProbeDeviceByToken(token).then((device) => {
    if (!device) {
      res.status(401).json({ error: 'Invalid access token' });
      return;
    }
    req.userId = device.user_id;
    req.deviceId = device.id;
    updateProbeDeviceLastSeen(device.id);
    next();
  });
}

/* ── SSE connection tracking ── */

const probeConnections = new Map<number, Set<Response>>();

/**
 * Push a probe event to connected probe devices for a user via SSE.
 * Uses proper SSE format: event: <type>\ndata: <json>\n\n
 */
export function pushEventToProbe(userId: number, eventType: string, eventData: any): void {
  const connections = probeConnections.get(userId);
  if (!connections || connections.size === 0) return;

  const msg = `event: ${eventType}\ndata: ${JSON.stringify(eventData)}\n\n`;
  for (const res of connections) {
    res.write(msg);
  }
}

/* ── server ── */

export function startWebServer(port: number): void {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  // Serve images from data/images directory
  const imagesDir = path.resolve(import.meta.dirname, '../data/images');
  app.use('/images', express.static(imagesDir));

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

  // ── Probe device auth (public) ──

  // POST /api/auth/device — initiate device auth flow
  app.post('/api/auth/device', async (req, res) => {
    const deviceCode = crypto.randomBytes(16).toString('hex');
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1 to avoid confusion
    let userCode = '';
    for (let i = 0; i < 8; i++) {
      if (i === 4) userCode += '-';
      userCode += chars[crypto.randomInt(chars.length)];
    }

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await createDeviceAuthRequest(deviceCode, userCode, expiresAt);

    const webBaseUrl = process.env.WEB_BASE_URL || `http://localhost:${port}`;
    res.json({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${webBaseUrl}/auth/device`,
      expires_in: 900,
      interval: 5,
    });
  });

  // POST /api/auth/token — poll for device auth completion
  app.post('/api/auth/token', async (req, res) => {
    const { device_code } = req.body;
    if (!device_code) {
      res.status(400).json({ error: 'missing_device_code' });
      return;
    }

    const authReq = await getDeviceAuthRequest(device_code);
    if (!authReq) {
      res.status(400).json({ error: 'invalid_device_code' });
      return;
    }

    if (new Date(authReq.expires_at) < new Date()) {
      res.status(400).json({ error: 'expired_token' });
      return;
    }

    if (authReq.status === 'pending') {
      res.status(400).json({ error: 'authorization_pending' });
      return;
    }

    if (authReq.status === 'authorized' && authReq.user_id) {
      const deviceId = crypto.randomBytes(8).toString('hex');
      const accessToken = 'lmp_' + crypto.randomBytes(16).toString('hex');
      await createProbeDevice(deviceId, authReq.user_id, accessToken);
      log.info({ userId: authReq.user_id, deviceId }, 'Probe device registered');
      res.json({ access_token: accessToken, user_id: authReq.user_id });
      return;
    }

    res.status(400).json({ error: 'unknown_status' });
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
    const { taskId } = await retryLink(id);
    res.json({ taskId, linkId: id, status: 'queued', message: 'Link queued for retry' });
  });

  // ── Probe API routes (probe device auth) ──

  // GET /api/probe/subscribe_events — SSE endpoint for probe devices
  app.get('/api/probe/subscribe_events', requireProbeAuth, (req: ProbeAuthRequest, res) => {
    const userId = req.userId!;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');

    // Register this connection
    if (!probeConnections.has(userId)) {
      probeConnections.set(userId, new Set());
    }
    probeConnections.get(userId)!.add(res);

    // Send pending events immediately
    getPendingProbeEvents(userId).then(async (events) => {
      for (const event of events) {
        const eventData = {
          event_id: event.id,
          url: event.url,
          url_type: event.url_type,
          link_id: event.link_id,
          created_at: event.created_at,
        };
        res.write(`event: scrape_request\ndata: ${JSON.stringify(eventData)}\n\n`);
        await updateProbeEventStatus(event.id, 'sent');
      }
    });

    // Ping every 30s to keep connection alive
    const pingInterval = setInterval(() => {
      res.write('event: ping\ndata: {}\n\n');
    }, 30000);

    // Cleanup on close
    req.on('close', () => {
      clearInterval(pingInterval);
      const conns = probeConnections.get(userId);
      if (conns) {
        conns.delete(res);
        if (conns.size === 0) probeConnections.delete(userId);
      }
    });
  });

  // POST /api/probe/receive_result — receive scrape result from probe
  app.post('/api/probe/receive_result', requireProbeAuth, async (req: ProbeAuthRequest, res) => {
    const { event_id, success, data, error } = req.body;
    if (!event_id) {
      res.status(400).json({ error: 'Missing event_id' });
      return;
    }

    const event = await getProbeEventById(event_id);
    if (!event || event.user_id !== req.userId) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    if (success) {
      await updateProbeEventStatus(event_id, 'completed', data);
      await handleProbeResult(event_id, data);
    } else {
      await updateProbeEventStatus(event_id, 'error', undefined, error || 'Unknown error');
    }

    res.json({ ok: true });
  });

  // GET /api/probe/status — get probe devices and pending events
  app.get('/api/probe/status', requireAuth, async (req: AuthRequest, res) => {
    const devices = await getProbeDevicesByUserId(req.userId!);
    const pendingEvents = await getPendingProbeEvents(req.userId!);
    res.json({
      devices,
      pending_events_count: pendingEvents.length,
    });
  });

  // ── Device auth page routes (cookie auth) ──

  // GET /auth/device — show device authorization page
  app.get('/auth/device', requireAuth, async (req: AuthRequest, res) => {
    const userCode = (req.query.code as string) || '';
    const html = await renderPage('device-auth', {
      pageTitle: 'Authorize Device — LinkMind',
      user_code: userCode,
    });
    res.type('html').send(html);
  });

  // POST /auth/device/authorize — authorize a device
  app.post('/auth/device/authorize', requireAuth, async (req: AuthRequest, res) => {
    const userCode = req.body.user_code as string;
    if (!userCode) {
      res.status(400).send('Missing user_code');
      return;
    }

    const authReq = await getDeviceAuthRequestByUserCode(userCode);
    if (!authReq) {
      res.status(404).send('Invalid or expired code');
      return;
    }

    if (new Date(authReq.expires_at) < new Date()) {
      res.status(400).send('Code expired');
      return;
    }

    await authorizeDeviceAuthRequest(authReq.device_code, req.userId!);
    log.info({ userId: req.userId, deviceCode: authReq.device_code }, 'Device auth request authorized');

    const html = await renderPage('device-auth', {
      pageTitle: 'Device Authorized — LinkMind',
      user_code: userCode,
      success: true,
    });
    res.type('html').send(html);
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
        _images: safeParseJson(l.images),
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
    const images = safeParseJson(link.images);
    const rawNotes = safeParseJson(link.related_notes);
    const relatedNotes = rawNotes.map((n: any) => ({
      ...n,
      noteUrl: n.path ? `/note?path=${encodeURIComponent(n.path)}` : undefined,
    }));
    // Get related links from link_relations table
    const relatedLinkData = await getRelatedLinks(link.id!);
    const relatedLinks: {
      linkId: number;
      title: string;
      url: string;
      sourceUrl: string;
      tags: string[];
      score: number;
    }[] = [];
    for (const item of relatedLinkData) {
      const relatedLink = await getLink(item.relatedLinkId);
      if (relatedLink) {
        relatedLinks.push({
          linkId: item.relatedLinkId,
          title: relatedLink.og_title || relatedLink.url,
          url: `/link/${item.relatedLinkId}`,
          sourceUrl: relatedLink.url,
          tags: safeParseJson(relatedLink.tags),
          score: item.score,
        });
      }
    }

    try {
      const html = await renderPage('link-detail', {
        pageTitle: `${link.og_title || link.url} — LinkMind`,
        link,
        tags,
        images,
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

  // TODO: 未来可能会换成 mykb 调用
  // // GET /note — view a note fetched via qmd
  // app.get('/note', requireAuth, async (req: AuthRequest, res) => {
  //   const qmdPath = req.query.path as string;
  //   if (!qmdPath || !qmdPath.startsWith('qmd://')) {
  //     res.status(400).send('Invalid path');
  //     return;
  //   }

  //   const content = await qmdGet(qmdPath);
  //   if (content === undefined) {
  //     res.status(404).send('Note not found');
  //     return;
  //   }

  //   const segments = qmdPath.split('/');
  //   const fileName = segments[segments.length - 1] || 'Note';
  //   const title = fileName.replace(/\.md$/, '').replace(/-/g, ' ');

  //   try {
  //     const html = await renderPage('note', {
  //       pageTitle: `${title} — LinkMind`,
  //       title,
  //       qmdPath,
  //       content,
  //       user: req.user,
  //     });
  //     res.type('html').send(html);
  //   } catch (err) {
  //     log.error({ err: err instanceof Error ? err.message : String(err) }, 'Note render failed');
  //     res.status(500).send('Internal error');
  //   }
  // });

  app.listen(port, () => {
    log.info({ port }, `Server listening on http://localhost:${port}`);
  });
}
