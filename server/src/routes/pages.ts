import type { Router, Response } from 'express';
import { marked } from 'marked';
import {
  getRecord,
  getPaginatedRecords,
  getRelatedRecords,
  getLatestAgentSession,
  getAgentEventsBySessionId,
} from '../db/index.js';
import { requireAuth, type AuthRequest } from './middleware.js';
import { renderPage, safeParseJson, getDayLabel } from './helpers.js';

/** Render markdown string to HTML. Returns empty string for falsy input. */
function renderMarkdown(text: string | null | undefined): string {
  if (!text) return '';
  return marked.parse(text, { async: false }) as string;
}
import { logger } from '../logger.js';

const log = logger.child({ module: 'pages' });

export function registerPageRoutes(router: Router): void {
  // GET / — homepage with timeline
  router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
      const { records, total, page: safePage, totalPages } = await getPaginatedRecords(req.userId!, page, 50);

      const linksWithDay = records.map((l) => ({
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
  router.get('/link/:id', requireAuth, async (req: AuthRequest, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).send('Invalid ID');
      return;
    }

    const record = await getRecord(id);
    if (!record || record.user_id !== req.userId) {
      res.status(404).send('Not found');
      return;
    }

    const tags = safeParseJson(record.tags);
    const images = safeParseJson(record.images);
    const rawNotes = safeParseJson(record.related_notes);
    const relatedNotes = rawNotes.map((n: any) => ({
      ...n,
      noteUrl: n.path ? `/note?path=${encodeURIComponent(n.path)}` : undefined,
    }));

    const relatedLinkData = await getRelatedRecords(record.id!);
    const relatedLinks: {
      linkId: number;
      title: string;
      url: string;
      sourceUrl: string;
      tags: string[];
      score: number;
    }[] = [];
    for (const item of relatedLinkData) {
      const relatedRecord = await getRecord(item.relatedRecordId);
      if (relatedRecord) {
        relatedLinks.push({
          linkId: item.relatedRecordId,
          title: relatedRecord.og_title || relatedRecord.url || '',
          url: `/link/${item.relatedRecordId}`,
          sourceUrl: relatedRecord.url || '',
          tags: safeParseJson(relatedRecord.tags),
          score: item.score,
        });
      }
    }

    // Fetch latest agent session + events for processing history
    const latestSession = await getLatestAgentSession('record', String(record.id));
    let agentEvents: any[] = [];
    if (latestSession) {
      agentEvents = await getAgentEventsBySessionId(latestSession.id);
    }

    try {
      const detailTitle = record.type === 'note' ? `笔记 — LinkMind` : `${record.og_title || record.url} — LinkMind`;
      const html = await renderPage('link-detail', {
        pageTitle: detailTitle,
        link: record,
        tags,
        images,
        relatedNotes,
        relatedLinks,
        agentSession: latestSession,
        agentEvents,
        user: req.user,
        summaryHtml: renderMarkdown(record.summary),
        insightHtml: renderMarkdown(record.insight),
        markdownHtml: renderMarkdown(record.markdown),
        contentHtml: record.type === 'note' ? renderMarkdown(record.content) : '',
      });
      res.type('html').send(html);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Detail render failed');
      res.status(500).send('Internal error');
    }
  });

  // GET /settings
  router.get('/settings', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const html = await renderPage('settings', {
        pageTitle: 'Settings — LinkMind',
        user: req.user,
      });
      res.type('html').send(html);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Settings render failed');
      res.status(500).send('Internal error');
    }
  });
}
