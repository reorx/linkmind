import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getUserById, getProbeDeviceByToken, updateProbeDeviceLastSeen } from '../db/index.js';
import { COOKIE_NAME, getJwtSecret } from './helpers.js';

export interface AuthRequest extends Request {
  userId?: number;
  user?: { id: number; display_name?: string; username?: string };
}

export interface ProbeAuthRequest extends Request {
  userId?: number;
  deviceId?: string;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    return sendUnauth(req, res);
  }

  try {
    const payload = jwt.verify(token, getJwtSecret()) as { userId: number };
    req.userId = payload.userId;
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

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    res.status(503).json({ error: 'Admin API not configured' });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${adminToken}`) {
    res.status(401).json({ error: 'Invalid admin token' });
    return;
  }

  next();
}

export function requireProbeAuth(req: ProbeAuthRequest, res: Response, next: NextFunction): void {
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
