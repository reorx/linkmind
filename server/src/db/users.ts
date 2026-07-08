import crypto from 'crypto';
import { sql } from 'kysely';
import { getDb } from './connection.js';
import { toUserRecord } from './helpers.js';
import type { UserRecord, InviteRecord } from './types.js';

export async function findOrCreateUser(
  telegramId: number,
  username?: string,
  displayName?: string,
): Promise<UserRecord> {
  const existing = await getDb()
    .selectFrom('users')
    .selectAll()
    .where('telegram_id', '=', telegramId)
    .executeTakeFirst();

  if (existing) {
    if ((username && username !== existing.username) || (displayName && displayName !== existing.display_name)) {
      await getDb()
        .updateTable('users')
        .set({
          ...(username ? { username } : {}),
          ...(displayName ? { display_name: displayName } : {}),
        })
        .where('id', '=', existing.id)
        .execute();
    }
    return toUserRecord(existing);
  }

  const result = await getDb()
    .insertInto('users')
    .values({
      telegram_id: telegramId,
      username: username || null,
      display_name: displayName || null,
      status: 'pending',
      invite_id: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return toUserRecord(result);
}

export async function getInviteByCode(code: string): Promise<InviteRecord | undefined> {
  const row = await getDb().selectFrom('invites').selectAll().where('code', '=', code).executeTakeFirst();
  if (!row) return undefined;
  return {
    ...row,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

export async function useInvite(inviteId: number, userId: number): Promise<boolean> {
  const result = await getDb()
    .updateTable('invites')
    .set({ used_count: sql`used_count + 1` })
    .where('id', '=', inviteId)
    .where(sql<boolean>`used_count < max_uses`)
    .executeTakeFirst();

  if (!result.numUpdatedRows || result.numUpdatedRows === 0n) {
    return false;
  }

  await getDb().updateTable('users').set({ status: 'active', invite_id: inviteId }).where('id', '=', userId).execute();
  return true;
}

export async function getUserById(id: number): Promise<UserRecord | undefined> {
  const row = await getDb().selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? toUserRecord(row) : undefined;
}

export async function getUserByTelegramId(telegramId: number): Promise<UserRecord | undefined> {
  const row = await getDb().selectFrom('users').selectAll().where('telegram_id', '=', telegramId).executeTakeFirst();
  return row ? toUserRecord(row) : undefined;
}

export async function getUserByUsername(username: string): Promise<UserRecord | undefined> {
  const row = await getDb().selectFrom('users').selectAll().where('username', '=', username).executeTakeFirst();
  return row ? toUserRecord(row) : undefined;
}

function toInviteRecord(row: any): InviteRecord {
  return {
    ...row,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

export async function getAllInvites(): Promise<(InviteRecord & { actual_user_count: number })[]> {
  const rows = await getDb()
    .selectFrom('invites')
    .leftJoin('users', 'users.invite_id', 'invites.id')
    .select([
      'invites.id',
      'invites.code',
      'invites.max_uses',
      'invites.used_count',
      'invites.created_at',
      sql<number>`count(users.id)::int`.as('actual_user_count'),
    ])
    .groupBy(['invites.id', 'invites.code', 'invites.max_uses', 'invites.used_count', 'invites.created_at'])
    .orderBy('invites.created_at', 'desc')
    .execute();

  return rows.map((r) => ({
    ...toInviteRecord(r),
    actual_user_count: r.actual_user_count,
  }));
}

export async function getInviteById(id: number): Promise<{ invite: InviteRecord; users: UserRecord[] } | undefined> {
  const row = await getDb().selectFrom('invites').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) return undefined;

  const userRows = await getDb()
    .selectFrom('users')
    .selectAll()
    .where('invite_id', '=', id)
    .orderBy('created_at', 'asc')
    .execute();

  return {
    invite: toInviteRecord(row),
    users: userRows.map(toUserRecord),
  };
}

export async function createInvite(maxUses: number): Promise<InviteRecord> {
  const code = crypto.randomBytes(6).toString('hex');
  const row = await getDb()
    .insertInto('invites')
    .values({ code, max_uses: maxUses, used_count: 0 })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toInviteRecord(row);
}
