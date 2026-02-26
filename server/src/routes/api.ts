import type { Router, Response } from 'express';
import multer from 'multer';
import { nanoid } from 'nanoid';
import {
  getRecord,
  getRecentRecords,
  getFailedRecords,
  getAllUserRecords,
  getRecordByUrl,
  insertRecordWithCreatedAt,
  getLatestAgentSession,
  getAgentEventsAfterCursor,
  getAgentEventsBySessionId,
  getShareByRecordId,
  createShare,
  deleteShareByRecordId,
} from '../db/index.js';
import { spawnProcessLink, retryRecord, deleteRecordFull } from '../pipeline.js';
import { requireAuth, type AuthRequest } from './middleware.js';
import { safeParseJson, csvEscape, parseCsvLine } from './helpers.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'api' });

export function registerApiRoutes(router: Router): void {
  // POST /api/links — add a new link and process it
  router.post('/api/links', requireAuth, async (req: AuthRequest, res: Response) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: "Missing or invalid 'url' field" });
      return;
    }

    try {
      const { taskId } = await spawnProcessLink(req.userId!, url);
      res.json({ taskId, url, status: 'queued', message: 'Link queued for processing' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // GET /api/links — list recent links
  router.get('/api/links', requireAuth, async (req: AuthRequest, res: Response) => {
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const records = await getRecentRecords(req.userId!, limit);
    res.json(
      records.map((l) => ({
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
  router.get('/api/links/:id', requireAuth, async (req: AuthRequest, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }
    const record = await getRecord(id);
    if (!record || record.user_id !== req.userId) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json({
      ...record,
      tags: safeParseJson(record.tags),
      related_notes: safeParseJson(record.related_notes),
      related_links: safeParseJson(record.related_links),
    });
  });

  // DELETE /api/links/:id — delete a link and clean up references
  router.delete('/api/links/:id', requireAuth, async (req: AuthRequest, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }
    const record = await getRecord(id);
    if (!record || record.user_id !== req.userId) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const result = await deleteRecordFull(id);
    log.info(
      { linkId: id, url: result.url, relatedRecordsUpdated: result.relatedRecordsUpdated },
      'Link deleted via API',
    );
    res.json({ message: 'Link deleted', ...result });
  });

  // POST /api/retry — retry all failed links
  router.post('/api/retry', requireAuth, async (req: AuthRequest, res: Response) => {
    const failed = await getFailedRecords(req.userId!);
    if (failed.length === 0) {
      res.json({ message: 'No failed links to retry', retried: 0 });
      return;
    }

    log.info({ count: failed.length }, 'Retrying failed links');
    const ids = failed.map((l) => l.id!);
    res.json({ message: `Retrying ${ids.length} failed link(s)`, ids });

    for (const id of ids) {
      try {
        await retryRecord(id);
      } catch (err) {
        log.error({ linkId: id, err: err instanceof Error ? err.message : String(err) }, 'Retry failed');
      }
    }
  });

  // POST /api/retry/:id — retry a single failed link
  router.post('/api/retry/:id', requireAuth, async (req: AuthRequest, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }

    const record = await getRecord(id);
    if (!record || record.user_id !== req.userId) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    log.info({ linkId: id, url: record.url }, 'Retrying single link');
    const { taskId } = await retryRecord(id);
    res.json({ taskId, linkId: id, status: 'queued', message: 'Link queued for retry' });
  });

  // GET /api/settings/export — export links as CSV
  router.get('/api/settings/export', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const records = await getAllUserRecords(req.userId!);
      const today = new Date().toISOString().slice(0, 10);
      const filename = `linkmind-export-${today}.csv`;

      const csvRows = ['url,title,created_at'];
      for (const record of records) {
        csvRows.push(`${csvEscape(record.url || '')},${csvEscape(record.og_title || '')},${record.created_at || ''}`);
      }

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csvRows.join('\n'));
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Export failed');
      res.status(500).json({ error: 'Export failed' });
    }
  });

  // POST /api/settings/import — import links from CSV
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

  router.post('/api/settings/import', requireAuth, upload.single('file'), async (req: AuthRequest, res: Response) => {
    try {
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }

      const content = file.buffer.toString('utf-8');
      const lines = content.split(/\r?\n/).filter((l) => l.trim());

      if (lines.length < 1) {
        res.status(400).json({ error: 'Empty CSV file' });
        return;
      }

      const firstLine = lines[0].toLowerCase();
      const startIdx = firstLine.startsWith('url') ? 1 : 0;

      let imported = 0;
      let skipped = 0;
      const errors: string[] = [];

      for (let i = startIdx; i < lines.length; i++) {
        const fields = parseCsvLine(lines[i]);
        if (fields.length < 1 || !fields[0].trim()) {
          errors.push(`Line ${i + 1}: missing URL`);
          continue;
        }

        const url = fields[0].trim();
        const createdAt = fields.length >= 3 && fields[2].trim() ? fields[2].trim() : new Date().toISOString();

        try {
          new URL(url);
        } catch {
          errors.push(`Line ${i + 1}: invalid URL "${url}"`);
          continue;
        }

        const existing = await getRecordByUrl(req.userId!, url);
        if (existing) {
          skipped++;
          continue;
        }

        try {
          await insertRecordWithCreatedAt(req.userId!, url, createdAt, 'enqueued');
          imported++;
        } catch (err) {
          errors.push(`Line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      res.json({ imported, skipped, errors });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Import failed');
      res.status(500).json({ error: 'Import failed' });
    }
  });

  // GET /api/records/:id/session — get latest agent session for a record
  router.get('/api/records/:id/session', requireAuth, async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;
    const session = await getLatestAgentSession('record', id);
    if (!session) {
      res.json({ session: null });
      return;
    }
    res.json({ session });
  });

  // GET /api/agent-events/stream — SSE endpoint for streaming agent events
  router.get('/api/agent-events/stream', requireAuth, async (req: AuthRequest, res: Response) => {
    const sessionId = req.query.session_id as string;
    if (!sessionId) {
      res.status(400).json({ error: 'Missing session_id' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();

    let cursor = parseInt(req.query.cursor as string, 10) || 0;
    let closed = false;

    req.on('close', () => {
      closed = true;
    });

    const poll = async () => {
      while (!closed) {
        const events = await getAgentEventsAfterCursor(sessionId, cursor);

        let sessionEnded = false;
        for (const event of events) {
          if (closed) break;
          res.write(`event: agent_event\ndata: ${JSON.stringify(event)}\n\n`);
          cursor = event.id;
          if (event.event_type === 'session_end') {
            sessionEnded = true;
          }
        }

        if (closed || sessionEnded) {
          if (!closed) res.end();
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    };

    poll();
  });

  // GET /api/records/:id/events — get all events for a record's latest session
  router.get('/api/records/:id/events', requireAuth, async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;
    const session = await getLatestAgentSession('record', id);
    if (!session) {
      res.json({ session: null, events: [] });
      return;
    }
    const events = await getAgentEventsBySessionId(session.id);
    res.json({ session, events });
  });

  // POST /api/links/:id/share — create or return existing share link
  router.post('/api/links/:id/share', requireAuth, async (req: AuthRequest, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }
    const record = await getRecord(id);
    if (!record || record.user_id !== req.userId) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    // Idempotent: return existing share if already shared
    const existing = await getShareByRecordId(id);
    if (existing) {
      res.json({ nanoid: existing.nanoid, url: `/shared/${existing.nanoid}` });
      return;
    }

    const share = await createShare(nanoid(), id, req.userId!);
    log.info({ recordId: id, nanoid: share.nanoid }, 'Share created');
    res.json({ nanoid: share.nanoid, url: `/shared/${share.nanoid}` });
  });

  // DELETE /api/links/:id/share — stop sharing
  router.delete('/api/links/:id/share', requireAuth, async (req: AuthRequest, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }
    const record = await getRecord(id);
    if (!record || record.user_id !== req.userId) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const deleted = await deleteShareByRecordId(id);
    if (deleted) {
      log.info({ recordId: id }, 'Share deleted');
    }
    res.json({ success: true });
  });
}
