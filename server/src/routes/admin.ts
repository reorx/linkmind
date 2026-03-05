import path from 'path';
import type { Router, Response, Request } from 'express';
import ejs from 'ejs';
import { sql } from 'kysely';
import { requireAdmin, requireAdminPage } from './middleware.js';
import { scrapeWithFallbackChain } from '../scraper.js';
import { retryRecord } from '../pipeline.js';
import { getRecord, getDb, getUserById, getAllInvites, getInviteById, createInvite } from '../db/index.js';
import { toRecordEntry, toUserRecord } from '../db/helpers.js';
import { getAllBalancesWithUsers, getTransactionsByUserId, getBalance } from '../db/usage.js';
import { getNextCycleStart } from '../usage.js';
import { getCrawlerKeys } from '../crawler-keys.js';
import { logger } from '../logger.js';

const BOT_USERNAME = process.env.BOT_USERNAME || 'linkmind_bot';

const log = logger.child({ module: 'admin' });
const ADMIN_VIEWS_DIR = path.resolve(import.meta.dirname, '../views/admin');

async function renderAdminPage(template: string, data: Record<string, any> = {}): Promise<string> {
  const body = await ejs.renderFile(path.join(ADMIN_VIEWS_DIR, `${template}.ejs`), data);
  return ejs.renderFile(path.join(ADMIN_VIEWS_DIR, 'layout.ejs'), { ...data, body });
}

export function registerAdminRoutes(router: Router): void {
  // ── Dashboard ──
  router.get('/admin', requireAdminPage, async (req: Request, res: Response) => {
    const db = getDb();

    const [{ count: userCount }, { count: recordCount }, { count: todayProcessedCount }] = await Promise.all([
      db.selectFrom('users').select(sql<number>`count(*)::int`.as('count')).executeTakeFirstOrThrow(),
      db.selectFrom('records').select(sql<number>`count(*)::int`.as('count')).executeTakeFirstOrThrow(),
      db
        .selectFrom('records')
        .select(sql<number>`count(*)::int`.as('count'))
        .where('status', '=', 'analyzed')
        .where(sql<boolean>`updated_at >= date_trunc('day', NOW())`)
        .executeTakeFirstOrThrow(),
    ]);

    const { rows: hourlyData } = await sql<{ hour: string; new_count: number; processed_count: number }>`
      WITH hours AS (
        SELECT generate_series(
          date_trunc('hour', NOW() - INTERVAL '23 hours'),
          date_trunc('hour', NOW()),
          '1 hour'::interval
        ) AS hour
      ),
      new_counts AS (
        SELECT date_trunc('hour', created_at) AS hour, count(*)::int AS count
        FROM records
        WHERE created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY 1
      ),
      processed_counts AS (
        SELECT date_trunc('hour', updated_at) AS hour, count(*)::int AS count
        FROM records
        WHERE updated_at >= NOW() - INTERVAL '24 hours' AND status = 'analyzed'
        GROUP BY 1
      )
      SELECT
        to_char(h.hour, 'MM-DD HH24:00') AS hour,
        COALESCE(n.count, 0)::int AS new_count,
        COALESCE(p.count, 0)::int AS processed_count
      FROM hours h
      LEFT JOIN new_counts n ON n.hour = h.hour
      LEFT JOIN processed_counts p ON p.hour = h.hour
      ORDER BY h.hour
    `.execute(db);

    const maxHourly = Math.max(1, ...hourlyData.map((r) => Math.max(r.new_count, r.processed_count)));

    const anomalousRows = await db
      .selectFrom('records')
      .selectAll()
      .where('status', '!=', 'analyzed')
      .orderBy('updated_at', 'desc')
      .limit(50)
      .execute();

    const html = await renderAdminPage('dashboard', {
      pageTitle: 'Dashboard',
      userCount,
      recordCount,
      todayProcessedCount,
      hourlyData,
      maxHourly,
      anomalousRecords: anomalousRows.map(toRecordEntry),
    });
    res.send(html);
  });

  // ── Users List ──
  router.get('/admin/users', requireAdminPage, async (req: Request, res: Response) => {
    const db = getDb();

    const usersRaw = await db.selectFrom('users').selectAll().orderBy('id', 'asc').execute();

    const recordCounts = await db
      .selectFrom('records')
      .select(['user_id', sql<number>`count(*)::int`.as('count')])
      .groupBy('user_id')
      .execute();
    const countMap = new Map(recordCounts.map((r) => [r.user_id, r.count]));

    const users = usersRaw.map((u) => ({
      ...toUserRecord(u),
      record_count: countMap.get(u.id) || 0,
    }));

    const html = await renderAdminPage('users', { pageTitle: 'Users', users });
    res.send(html);
  });

  // ── User Detail ──
  router.get('/admin/users/:id', requireAdminPage, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).send('Invalid user id');
      return;
    }

    const user = await getUserById(id);
    if (!user) {
      res.status(404).send('User not found');
      return;
    }

    const records = await getDb()
      .selectFrom('records')
      .selectAll()
      .where('user_id', '=', id)
      .orderBy('id', 'desc')
      .limit(100)
      .execute();

    const html = await renderAdminPage('user-detail', {
      pageTitle: `User #${id}`,
      user,
      records: records.map(toRecordEntry),
    });
    res.send(html);
  });

  // ── Invites List ──
  router.get('/admin/invites', requireAdminPage, async (req: Request, res: Response) => {
    const invites = await getAllInvites();
    const html = await renderAdminPage('invites', { pageTitle: 'Invites', invites });
    res.send(html);
  });

  // ── Create Invite ──
  router.get('/admin/invites/create', requireAdminPage, async (req: Request, res: Response) => {
    const html = await renderAdminPage('invite-create', { pageTitle: 'Create Invite' });
    res.send(html);
  });

  router.post('/admin/invites/create', requireAdminPage, async (req: Request, res: Response) => {
    const maxUses = Math.max(1, parseInt(req.body.max_uses, 10) || 1);
    const invite = await createInvite(maxUses);
    res.redirect(`/admin/invites/${invite.id}`);
  });

  // ── Invite Detail ──
  router.get('/admin/invites/:id', requireAdminPage, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).send('Invalid invite id');
      return;
    }

    const result = await getInviteById(id);
    if (!result) {
      res.status(404).send('Invite not found');
      return;
    }

    const deepLink = `https://t.me/${BOT_USERNAME}?start=invite_${result.invite.code}`;

    const html = await renderAdminPage('invite-detail', {
      pageTitle: `Invite #${id}`,
      invite: result.invite,
      users: result.users,
      deepLink,
    });
    res.send(html);
  });

  // ── Records List ──
  router.get('/admin/records', requireAdminPage, async (req: Request, res: Response) => {
    const db = getDb();
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const perPage = 50;
    const statusFilter = typeof req.query.status === 'string' ? req.query.status : '';

    let countQuery = db.selectFrom('records').select(sql<number>`count(*)::int`.as('count'));
    let listQuery = db
      .selectFrom('records')
      .innerJoin('users', 'users.id', 'records.user_id')
      .select([
        'records.id',
        'records.url',
        'records.type',
        'records.status',
        'records.og_title',
        'records.error_message',
        'records.created_at',
        'records.updated_at',
        'users.username',
      ]);

    if (statusFilter) {
      countQuery = countQuery.where('status', '=', statusFilter);
      listQuery = listQuery.where('records.status', '=', statusFilter);
    }

    const { count: total } = await countQuery.executeTakeFirstOrThrow();
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const safePage = Math.max(1, Math.min(page, totalPages));

    const records = await listQuery
      .orderBy('records.id', 'desc')
      .limit(perPage)
      .offset((safePage - 1) * perPage)
      .execute();

    const normalizedRecords = records.map((r) => ({
      ...r,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
    }));

    const html = await renderAdminPage('records', {
      pageTitle: 'Records',
      records: normalizedRecords,
      page: safePage,
      totalPages,
      total,
      statusFilter,
    });
    res.send(html);
  });

  // ── Record Detail ──
  router.get('/admin/records/:id', requireAdminPage, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).send('Invalid record id');
      return;
    }

    const record = await getRecord(id);
    if (!record) {
      res.status(404).send('Record not found');
      return;
    }

    const user = await getUserById(record.user_id);

    const session = await getDb()
      .selectFrom('agent_session')
      .selectAll()
      .where('ref_type', '=', 'record')
      .where('ref_id', '=', String(id))
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();

    let agentEvents: any[] = [];
    if (session) {
      agentEvents = await getDb()
        .selectFrom('agent_event')
        .selectAll()
        .where('session_id', '=', session.id)
        .orderBy('created_at', 'asc')
        .execute();
    }

    const html = await renderAdminPage('record-detail', {
      pageTitle: `Record #${id}`,
      record,
      user,
      session: session
        ? {
            ...session,
            created_at: session.created_at instanceof Date ? session.created_at.toISOString() : session.created_at,
            updated_at: session.updated_at instanceof Date ? session.updated_at.toISOString() : session.updated_at,
          }
        : null,
      agentEvents: agentEvents.map((e) => ({
        ...e,
        created_at: e.created_at instanceof Date ? e.created_at.toISOString() : e.created_at,
        data: e.data,
      })),
    });
    res.send(html);
  });

  // ── Crawler API Keys ──
  router.get('/admin/crawler-keys', requireAdminPage, async (req: Request, res: Response) => {
    const keys = await getCrawlerKeys();
    const html = await renderAdminPage('crawler-keys', { pageTitle: 'Crawler API Keys', keys });
    res.send(html);
  });

  router.post('/admin/crawler-keys', requireAdminPage, async (req: Request, res: Response) => {
    const { crawler_type, label, api_key, total_credits } = req.body;
    if (!crawler_type || !label || !api_key) {
      res.status(400).send('Missing required fields');
      return;
    }
    const db = getDb();
    await db
      .insertInto('crawler_api_keys')
      .values({
        crawler_type,
        label,
        api_key,
        total_credits: parseInt(total_credits, 10) || 0,
      })
      .execute();
    res.redirect('/admin/crawler-keys');
  });

  router.post('/admin/crawler-keys/:id/toggle', requireAdminPage, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).send('Invalid id');
      return;
    }
    const db = getDb();
    await db
      .updateTable('crawler_api_keys')
      .set({ enabled: sql`NOT enabled`, updated_at: sql`NOW()` } as any)
      .where('id', '=', id)
      .execute();
    res.redirect('/admin/crawler-keys');
  });

  router.post('/admin/crawler-keys/:id/reset', requireAdminPage, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).send('Invalid id');
      return;
    }
    const db = getDb();
    await db
      .updateTable('crawler_api_keys')
      .set({ used_credits: 0, exhausted: false, updated_at: sql`NOW()` } as any)
      .where('id', '=', id)
      .execute();
    res.redirect('/admin/crawler-keys');
  });

  router.post('/admin/crawler-keys/:id/delete', requireAdminPage, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).send('Invalid id');
      return;
    }
    const db = getDb();
    await db.deleteFrom('crawler_api_keys').where('id', '=', id).execute();
    res.redirect('/admin/crawler-keys');
  });

  // ── Usage Billing ──
  router.get('/admin/usage', requireAdminPage, async (req: Request, res: Response) => {
    const balances = await getAllBalancesWithUsers();

    const rows = balances.map((b) => {
      const anchorDay = b.cycle_anchor.getDate();
      const cycleEnd = getNextCycleStart(b.current_cycle_start, anchorDay);
      const usage = Number(b.current_cycle_usage_usd);
      const limit = Number(b.cycle_limit_usd);
      const usagePct = limit > 0 ? Math.min(100, Math.round((usage / limit) * 100)) : 0;
      return {
        ...b,
        usage_pct: usagePct,
        current_cycle_start:
          b.current_cycle_start instanceof Date ? b.current_cycle_start.toISOString() : b.current_cycle_start,
        cycle_anchor: b.cycle_anchor instanceof Date ? b.cycle_anchor.toISOString() : b.cycle_anchor,
        updated_at: b.updated_at instanceof Date ? b.updated_at.toISOString() : b.updated_at,
        cycle_end: cycleEnd.toISOString(),
      };
    });

    const html = await renderAdminPage('usage', { pageTitle: 'Usage', rows });
    res.send(html);
  });

  router.get('/admin/usage/:userId', requireAdminPage, async (req: Request, res: Response) => {
    const userId = parseInt(req.params.userId as string, 10);
    if (isNaN(userId)) {
      res.status(400).send('Invalid user id');
      return;
    }

    const user = await getUserById(userId);
    if (!user) {
      res.status(404).send('User not found');
      return;
    }

    const balance = await getBalance(userId);
    if (!balance) {
      res.status(404).send('No billing data for this user');
      return;
    }

    const transactions = await getTransactionsByUserId(userId);

    const anchorDay = balance.cycle_anchor.getDate();
    const cycleEnd = getNextCycleStart(balance.current_cycle_start, anchorDay);
    const usage = Number(balance.current_cycle_usage_usd);
    const limit = Number(balance.cycle_limit_usd);
    const usagePct = limit > 0 ? Math.min(100, Math.round((usage / limit) * 100)) : 0;

    const enrichedBalance = {
      ...balance,
      cycle_end: cycleEnd.toISOString(),
      usage_pct: usagePct,
      cycle_anchor: balance.cycle_anchor instanceof Date ? balance.cycle_anchor.toISOString() : balance.cycle_anchor,
      current_cycle_start:
        balance.current_cycle_start instanceof Date
          ? balance.current_cycle_start.toISOString()
          : balance.current_cycle_start,
      updated_at: balance.updated_at instanceof Date ? balance.updated_at.toISOString() : balance.updated_at,
    };

    const normalizedTxns = transactions.map((t: any) => ({
      ...t,
      created_at: t.created_at instanceof Date ? t.created_at.toISOString() : t.created_at,
    }));

    const html = await renderAdminPage('usage-detail', {
      pageTitle: `Usage — ${user.username}`,
      user,
      balance: enrichedBalance,
      transactions: normalizedTxns,
    });
    res.send(html);
  });

  // ══════════════════════════════════════════
  // Admin API Routes (Bearer ADMIN_TOKEN auth)
  // ══════════════════════════════════════════

  router.post('/api/admin/test-scrape', requireAdmin, async (req: Request, res: Response) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: "Missing or invalid 'url' field" });
      return;
    }

    log.info({ url }, '[admin] test-scrape starting');
    const startTime = Date.now();

    try {
      const chainResult = await scrapeWithFallbackChain(url);
      const elapsed = Date.now() - startTime;
      const data = chainResult.data;

      log.info(
        { url, elapsed, source: chainResult.source, markdownLength: data?.markdown.length ?? 0 },
        '[admin] test-scrape complete',
      );

      res.json({
        success: !!chainResult.source,
        elapsed_ms: elapsed,
        source: chainResult.source,
        url: data?.url ?? url,
        title: data?.title,
        author: data?.author,
        published: data?.published,
        og: data?.og,
        markdown_length: data?.markdown.length ?? 0,
        markdown: data?.markdown ?? '',
        trace: chainResult.trace,
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
