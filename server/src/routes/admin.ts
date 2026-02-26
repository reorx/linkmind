import type { Router, Response, Request } from 'express';
import { requireAdmin } from './middleware.js';
import { scrapeUrl } from '../scraper.js';
import { retryRecord } from '../pipeline.js';
import { getRecord } from '../db/index.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'admin' });

export function registerAdminRoutes(router: Router): void {
  // POST /api/admin/test-scrape — synchronously scrape a URL and return full result
  router.post('/api/admin/test-scrape', requireAdmin, async (req: Request, res: Response) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: "Missing or invalid 'url' field" });
      return;
    }

    log.info({ url }, '[admin] test-scrape starting');
    const startTime = Date.now();

    try {
      const result = await scrapeUrl(url);
      const elapsed = Date.now() - startTime;

      log.info({ url, elapsed, markdownLength: result.markdown.length }, '[admin] test-scrape complete');

      res.json({
        success: true,
        elapsed_ms: elapsed,
        url: result.url,
        title: result.title,
        author: result.author,
        published: result.published,
        og: result.og,
        markdown_length: result.markdown.length,
        markdown: result.markdown,
      });
    } catch (err) {
      const elapsed = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;

      log.error({ url, elapsed, err: message }, '[admin] test-scrape failed');

      res.status(500).json({
        success: false,
        elapsed_ms: elapsed,
        url,
        error: message,
        stack,
      });
    }
  });

  // GET /api/admin/records.get — get full record details
  router.get('/api/admin/records.get', requireAdmin, async (req: Request, res: Response) => {
    const id = parseInt(req.query.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Missing or invalid 'id' query parameter" });
      return;
    }

    try {
      const record = await getRecord(id);
      if (!record) {
        res.status(404).json({ error: `Record ${id} not found` });
        return;
      }

      log.info({ recordId: id }, '[admin] records.get');
      res.json(record);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ recordId: id, err: message }, '[admin] records.get failed');
      res.status(500).json({ error: message });
    }
  });

  // POST /api/admin/retry/:id — retry a record's full pipeline
  router.post('/api/admin/retry/:id', requireAdmin, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid record id' });
      return;
    }

    try {
      const { taskId } = await retryRecord(id);
      log.info({ recordId: id, taskId }, '[admin] retry queued');
      res.json({ taskId, recordId: id, status: 'queued' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ recordId: id, err: message }, '[admin] retry failed');
      res.status(500).json({ error: message });
    }
  });
}
