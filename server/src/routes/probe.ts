import type { Router, Response } from 'express';
import {
  getProbeDevicesByUserId,
  getProbeEventById,
  updateProbeEventStatus,
  getPendingProbeEvents,
} from '../db/index.js';
import { handleProbeResult } from '../pipeline.js';
import { requireAuth, requireProbeAuth, type AuthRequest, type ProbeAuthRequest } from './middleware.js';

/* ── SSE connection tracking ── */

const probeConnections = new Map<number, Set<Response>>();

export function pushEventToProbe(userId: number, eventType: string, eventData: any): void {
  const connections = probeConnections.get(userId);
  if (!connections || connections.size === 0) return;

  const msg = `event: ${eventType}\ndata: ${JSON.stringify(eventData)}\n\n`;
  for (const res of connections) {
    res.write(msg);
  }
}

export function registerProbeRoutes(router: Router): void {
  // GET /api/probe/subscribe_events — SSE endpoint for probe devices
  router.get('/api/probe/subscribe_events', requireProbeAuth, (req: ProbeAuthRequest, res: Response) => {
    const userId = req.userId!;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');

    if (!probeConnections.has(userId)) {
      probeConnections.set(userId, new Set());
    }
    probeConnections.get(userId)!.add(res);

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

    const pingInterval = setInterval(() => {
      res.write('event: ping\ndata: {}\n\n');
    }, 30000);

    req.on('close', () => {
      clearInterval(pingInterval);
      const conns = probeConnections.get(userId);
      if (conns) {
        conns.delete(res);
        if (conns.size === 0) probeConnections.delete(userId);
      }
    });
  });

  // POST /api/probe/receive_result
  router.post('/api/probe/receive_result', requireProbeAuth, async (req: ProbeAuthRequest, res: Response) => {
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

  // GET /api/probe/status
  router.get('/api/probe/status', requireAuth, async (req: AuthRequest, res: Response) => {
    const devices = await getProbeDevicesByUserId(req.userId!);
    const pendingEvents = await getPendingProbeEvents(req.userId!);
    res.json({
      devices,
      pending_events_count: pendingEvents.length,
    });
  });
}
