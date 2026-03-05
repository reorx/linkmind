import { sql } from 'kysely';
import { getDb } from './connection.js';
import type { UserBalancesTable } from './types.js';

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
