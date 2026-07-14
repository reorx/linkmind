import { sql } from 'kysely';
import { getDb } from './connection.js';

export interface UserBalance {
  id: number;
  user_id: number;
  cycle_limit_usd: string;
  cycle_anchor: Date;
  current_cycle_usage_usd: string;
  current_cycle_start: Date;
  updated_at: Date;
}

export async function getOrCreateBalance(userId: number, defaultLimitUsd?: number): Promise<UserBalance> {
  const db = getDb();
  const values: Record<string, any> = { user_id: userId };
  if (defaultLimitUsd !== undefined) {
    values.cycle_limit_usd = String(defaultLimitUsd);
  }
  await db
    .insertInto('user_balances')
    .values(values as any)
    .onConflict((oc) => oc.column('user_id').doNothing())
    .execute();

  const row = await db.selectFrom('user_balances').selectAll().where('user_id', '=', userId).executeTakeFirstOrThrow();

  return row as UserBalance;
}

export async function getBalance(userId: number): Promise<UserBalance | undefined> {
  const row = await getDb().selectFrom('user_balances').selectAll().where('user_id', '=', userId).executeTakeFirst();

  return row as UserBalance | undefined;
}

export async function insertTransactionAndUpdateBalance(params: {
  userId: number;
  recordId: number | null;
  step: string | null;
  type: string;
  provider: string;
  amountUsd: number;
  metadata: any | null;
}): Promise<void> {
  const db = getDb();
  await db.transaction().execute(async (trx) => {
    const inserted = await trx
      .insertInto('usage_transactions')
      .values({
        user_id: params.userId,
        record_id: params.recordId,
        step: params.step,
        type: params.type,
        provider: params.provider,
        amount_usd: String(params.amountUsd),
        metadata: params.metadata ? JSON.stringify(params.metadata) : null,
      })
      .onConflict((oc) =>
        oc.columns(['record_id', 'step']).where('record_id', 'is not', null).where('step', 'is not', null).doNothing(),
      )
      .returning('id')
      .executeTakeFirst();

    if (inserted) {
      await trx
        .updateTable('user_balances')
        .set({
          current_cycle_usage_usd: sql`current_cycle_usage_usd + ${String(params.amountUsd)}::NUMERIC(10,6)`,
          updated_at: sql`NOW()`,
        })
        .where('user_id', '=', params.userId)
        .execute();
    }
  });
}

export async function updateBalanceCycleReset(userId: number, newCycleStart: Date): Promise<void> {
  await getDb()
    .updateTable('user_balances')
    .set({
      current_cycle_start: newCycleStart,
      current_cycle_usage_usd: '0',
      updated_at: sql`NOW()`,
    })
    .where('user_id', '=', userId)
    .execute();
}

export async function updateCycleLimit(userId: number, limitUsd: number): Promise<void> {
  await getDb()
    .updateTable('user_balances')
    .set({
      cycle_limit_usd: String(limitUsd),
      updated_at: sql`NOW()`,
    })
    .where('user_id', '=', userId)
    .execute();
}

export interface ReconcileBalanceRow {
  user_id: number;
  username: string;
  current_cycle_start: Date;
  current_cycle_usage_usd: string;
  tx_sum_usd: string;
}

/** Per-user sum of usage_transactions within the current cycle window, alongside the balance counter. */
export async function getBalancesWithTxSums(userId?: number): Promise<ReconcileBalanceRow[]> {
  let q = getDb()
    .selectFrom('user_balances as b')
    .innerJoin('users as u', 'u.id', 'b.user_id')
    .select([
      'b.user_id',
      'u.username',
      'b.current_cycle_start',
      'b.current_cycle_usage_usd',
      sql<string>`COALESCE((
        SELECT SUM(t.amount_usd) FROM usage_transactions t
        WHERE t.user_id = b.user_id AND t.created_at >= b.current_cycle_start
      ), 0)`.as('tx_sum_usd'),
    ])
    .orderBy('b.user_id');
  if (userId !== undefined) {
    q = q.where('b.user_id', '=', userId);
  }
  const rows = await q.execute();
  return rows as ReconcileBalanceRow[];
}

export async function updateCycleAnchorAndReset(userId: number, newAnchor: Date, newCycleStart: Date): Promise<void> {
  await getDb()
    .updateTable('user_balances')
    .set({
      cycle_anchor: newAnchor,
      current_cycle_start: newCycleStart,
      current_cycle_usage_usd: '0',
      updated_at: sql`NOW()`,
    })
    .where('user_id', '=', userId)
    .execute();
}

export async function getAllBalancesWithUsers(): Promise<
  Array<UserBalance & { username: string; display_name: string | null }>
> {
  const rows = await getDb()
    .selectFrom('user_balances')
    .innerJoin('users', 'users.id', 'user_balances.user_id')
    .select([
      'user_balances.id',
      'user_balances.user_id',
      'user_balances.cycle_limit_usd',
      'user_balances.cycle_anchor',
      'user_balances.current_cycle_usage_usd',
      'user_balances.current_cycle_start',
      'user_balances.updated_at',
      'users.username',
      'users.display_name',
    ])
    .orderBy(sql`user_balances.current_cycle_usage_usd::numeric`, 'desc')
    .execute();

  return rows as any;
}

export async function getTransactionsByUserId(userId: number, limit = 200): Promise<any[]> {
  return getDb()
    .selectFrom('usage_transactions')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();
}

export async function getTransactionsByRecordId(recordId: number): Promise<any[]> {
  return getDb()
    .selectFrom('usage_transactions')
    .selectAll()
    .where('record_id', '=', recordId)
    .orderBy('created_at', 'asc')
    .execute();
}

/**
 * Detach usage transactions from a record before deleting it (FK has no ON DELETE).
 * Billing history is preserved with record_id = NULL.
 */
export async function detachUsageFromRecord(recordId: number): Promise<number> {
  const result = await getDb()
    .updateTable('usage_transactions')
    .set({ record_id: null })
    .where('record_id', '=', recordId)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}
