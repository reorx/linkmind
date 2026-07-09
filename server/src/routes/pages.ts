import type { Router, Request, Response } from 'express';
import { marked } from 'marked';
import {
  getRecord,
  getPaginatedRecords,
  getRelatedRecords,
  getLatestAgentSession,
  getAgentEventsBySessionId,
  getShareByRecordId,
  getShareByNanoid,
  getRecordFiles,
} from '../db/index.js';
import { requireAuth, type AuthRequest } from './middleware.js';
import { renderPage, safeParseJson, getDayLabel, isAdminUser } from './helpers.js';
import { getProbeWaitTtlHours } from '../probe-timeout-cron.js';
import { getTransactionsByRecordId } from '../db/usage.js';
import { logger } from '../logger.js';

/** Render markdown string to HTML. Returns empty string for falsy input. */
function renderMarkdown(text: string | null | undefined): string {
  if (!text) return '';
  return marked.parse(text, { async: false }) as string;
}

const log = logger.child({ module: 'pages' });

/** Extract hostname from a URL for display. Returns empty string when invalid. */
function urlDomain(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Strip markdown syntax and produce a short plain-text snippet. */
function summarySnippet(text: string | null | undefined, maxLen = 120): string {
  if (!text) return '';
  const plain = text
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[->*+]\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > maxLen ? plain.slice(0, maxLen) + '…' : plain;
}

export function registerPageRoutes(router: Router): void {
  // GET / — homepage with timeline
  router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
      const { records, total, page: safePage, totalPages } = await getPaginatedRecords(req.userId!, page, 50);

      const linksWithDay = records.map((l) => ({
        ...l,
        _dayLabel: getDayLabel(l.created_at),
        _time: l.created_at ? l.created_at.slice(11, 16) : '',
        _domain: l.type === 'note' ? '笔记' : urlDomain(l.url),
        _tags: safeParseJson(l.tags),
        _summaryText: summarySnippet(l.summary, 200),
      }));

      // Group consecutive records by day label for the grouped list view
      const groups: { date: string; items: typeof linksWithDay }[] = [];
      for (const item of linksWithDay) {
        const last = groups[groups.length - 1];
        if (last && last.date === item._dayLabel) {
          last.items.push(item);
        } else {
          groups.push({ date: item._dayLabel, items: [item] });
        }
      }

      const html = await renderPage('home', {
        pageTitle: 'LinkMind',
        links: linksWithDay,
        groups,
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

  // GET /probe — probe installation guide (public, no auth)
  router.get('/probe', async (_req: Request, res: Response) => {
    const html = await renderPage('probe', {
      pageTitle: '安装 Probe - LinkMind',
      ttlHours: getProbeWaitTtlHours(),
    });
    res.type('html').send(html);
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
    const recordFiles = await getRecordFiles(record.id!);
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
      snippet: string;
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
          snippet: summarySnippet(relatedRecord.summary),
        });
      }
    }

    // Check if current user is admin
    const isAdmin = req.user?.id ? isAdminUser(req.user.id) : false;

    // Fetch latest agent session + events for processing history (admin only)
    let latestSession = null;
    let agentEvents: any[] = [];
    let recordTransactions: any[] = [];
    if (isAdmin) {
      latestSession = await getLatestAgentSession('record', String(record.id));
      if (latestSession) {
        agentEvents = await getAgentEventsBySessionId(latestSession.id);
      }
      recordTransactions = await getTransactionsByRecordId(record.id!);
    }

    const shareRecord = await getShareByRecordId(record.id!);

    try {
      const detailTitle = record.type === 'note' ? `笔记 — LinkMind` : `${record.og_title || record.url} — LinkMind`;
      const html = await renderPage('link-detail', {
        pageTitle: detailTitle,
        link: record,
        tags,
        recordFiles,
        relatedNotes,
        relatedLinks,
        agentSession: latestSession,
        agentEvents: agentEvents,
        recordTransactions,
        isAdmin,
        isShared: false,
        shareNanoid: shareRecord?.nanoid || null,
        domain: urlDomain(record.url),
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

  // GET /shared/:nanoid — public shared record page
  router.get('/shared/:nanoid', async (req: Request, res: Response) => {
    const nanoid = req.params.nanoid as string;
    const share = await getShareByNanoid(nanoid);
    if (!share) {
      res.status(404).send('Not found');
      return;
    }

    const record = await getRecord(share.record_id);
    if (!record) {
      res.status(404).send('Not found');
      return;
    }

    const tags = safeParseJson(record.tags);
    const recordFiles = await getRecordFiles(record.id!);

    // Related links: title + sourceUrl only (no internal link)
    const relatedLinkData = await getRelatedRecords(record.id!);
    const relatedLinks: {
      linkId: number;
      title: string;
      url: string;
      sourceUrl: string;
      tags: string[];
      score: number;
      snippet: string;
    }[] = [];
    for (const item of relatedLinkData) {
      const relatedRecord = await getRecord(item.relatedRecordId);
      if (relatedRecord) {
        relatedLinks.push({
          linkId: item.relatedRecordId,
          title: relatedRecord.og_title || relatedRecord.url || '',
          url: '', // no internal link in shared mode
          sourceUrl: relatedRecord.url || '',
          tags: safeParseJson(relatedRecord.tags),
          score: item.score,
          snippet: summarySnippet(relatedRecord.summary),
        });
      }
    }

    try {
      const detailTitle = record.type === 'note' ? '笔记 — LinkMind' : `${record.og_title || record.url} — LinkMind`;

      const html = await renderPage('link-detail', {
        pageTitle: detailTitle,
        link: record,
        tags,
        recordFiles,
        relatedNotes: [], // hide related notes in shared mode
        relatedLinks,
        agentSession: null,
        agentEvents: [],
        recordTransactions: [],
        isAdmin: false,
        isShared: true,
        domain: urlDomain(record.url),
        user: null,
        summaryHtml: renderMarkdown(record.summary),
        insightHtml: renderMarkdown(record.insight),
        markdownHtml: renderMarkdown(record.markdown),
        contentHtml: record.type === 'note' ? renderMarkdown(record.content) : '',
      });
      res.type('html').send(html);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Shared page render failed');
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
