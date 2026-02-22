import crypto from 'crypto';
import type { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import {
  createDeviceAuthRequest,
  getDeviceAuthRequest,
  getDeviceAuthRequestByUserCode,
  authorizeDeviceAuthRequest,
  createProbeDevice,
} from '../db/index.js';
import { COOKIE_NAME, COOKIE_MAX_AGE, getJwtSecret, renderPage } from './helpers.js';
import { requireAuth, type AuthRequest } from './middleware.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'auth' });

export function registerAuthRoutes(router: Router, port: number): void {
  // GET /auth/callback — handle login from Telegram bot
  router.get('/auth/callback', async (req: Request, res: Response) => {
    const loginToken = req.query.token as string;
    if (!loginToken) {
      res.status(400).send('Missing token');
      return;
    }

    try {
      const payload = jwt.verify(loginToken, getJwtSecret()) as { userId: number; telegramId: number };
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

  // GET /login
  router.get('/login', async (req: Request, res: Response) => {
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
  router.get('/logout', (_req: Request, res: Response) => {
    res.clearCookie(COOKIE_NAME);
    res.redirect('/login');
  });

  // POST /api/auth/device — initiate device auth flow
  router.post('/api/auth/device', async (_req: Request, res: Response) => {
    const deviceCode = crypto.randomBytes(16).toString('hex');
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
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
  router.post('/api/auth/token', async (req: Request, res: Response) => {
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

  // GET /auth/device — show device authorization page
  router.get('/auth/device', requireAuth, async (req: AuthRequest, res: Response) => {
    const userCode = (req.query.code as string) || '';
    const html = await renderPage('device-auth', {
      pageTitle: 'Authorize Device — LinkMind',
      user_code: userCode,
    });
    res.type('html').send(html);
  });

  // POST /auth/device/authorize
  router.post('/auth/device/authorize', requireAuth, async (req: AuthRequest, res: Response) => {
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
}
