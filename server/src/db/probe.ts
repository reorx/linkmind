import { sql } from 'kysely';
import { getDb } from './connection.js';
import { toProbeEventRecord, toDeviceAuthRecord } from './helpers.js';
import type { ProbeDeviceRecord, ProbeEventRecord, DeviceAuthRequestRecord } from './types.js';

/* ── Probe Devices ── */

export async function createProbeDevice(
  id: string,
  userId: number,
  accessToken: string,
  name?: string,
): Promise<ProbeDeviceRecord> {
  const row = await getDb()
    .insertInto('probe_devices')
    .values({
      id,
      user_id: userId,
      access_token: accessToken,
      name: name || null,
      last_seen_at: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return {
    ...row,
    name: row.name ?? undefined,
    last_seen_at: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : undefined,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

export async function getProbeDeviceByToken(token: string): Promise<ProbeDeviceRecord | undefined> {
  const row = await getDb()
    .selectFrom('probe_devices')
    .selectAll()
    .where('access_token', '=', token)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    ...row,
    name: row.name ?? undefined,
    last_seen_at: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : undefined,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

export async function updateProbeDeviceLastSeen(id: string): Promise<void> {
  await getDb().updateTable('probe_devices').set({ last_seen_at: sql`NOW()` }).where('id', '=', id).execute();
}

export async function getProbeDevicesByUserId(userId: number): Promise<ProbeDeviceRecord[]> {
  const rows = await getDb()
    .selectFrom('probe_devices')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map((row) => ({
    ...row,
    name: row.name ?? undefined,
    last_seen_at: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : undefined,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
}

/* ── Probe Events ── */

export async function createProbeEvent(
  id: string,
  userId: number,
  linkId: number | undefined,
  url: string,
  urlType: string,
): Promise<ProbeEventRecord> {
  const row = await getDb()
    .insertInto('probe_events')
    .values({
      id,
      user_id: userId,
      link_id: linkId ?? null,
      url,
      url_type: urlType,
      status: 'pending',
      result: null,
      error: null,
      sent_at: null,
      completed_at: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toProbeEventRecord(row);
}

export async function getProbeEventById(id: string): Promise<ProbeEventRecord | undefined> {
  const row = await getDb().selectFrom('probe_events').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) return undefined;
  return toProbeEventRecord(row);
}

export async function updateProbeEventStatus(id: string, status: string, result?: any, error?: string): Promise<void> {
  const update: Record<string, any> = { status };
  if (result !== undefined) update.result = JSON.stringify(result);
  if (error !== undefined) update.error = error;
  if (status === 'sent') update.sent_at = sql`NOW()`;
  if (status === 'completed' || status === 'error') update.completed_at = sql`NOW()`;
  await getDb().updateTable('probe_events').set(update).where('id', '=', id).execute();
}

export async function getPendingProbeEvents(userId: number): Promise<ProbeEventRecord[]> {
  const rows = await getDb()
    .selectFrom('probe_events')
    .selectAll()
    .where('user_id', '=', userId)
    .where('status', '=', 'pending')
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map(toProbeEventRecord);
}

/* ── Device Auth Requests ── */

export async function createDeviceAuthRequest(
  deviceCode: string,
  userCode: string,
  expiresAt: Date,
): Promise<DeviceAuthRequestRecord> {
  const row = await getDb()
    .insertInto('device_auth_requests')
    .values({
      device_code: deviceCode,
      user_code: userCode,
      user_id: null,
      status: 'pending',
      expires_at: expiresAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toDeviceAuthRecord(row);
}

export async function getDeviceAuthRequest(deviceCode: string): Promise<DeviceAuthRequestRecord | undefined> {
  const row = await getDb()
    .selectFrom('device_auth_requests')
    .selectAll()
    .where('device_code', '=', deviceCode)
    .executeTakeFirst();
  if (!row) return undefined;
  return toDeviceAuthRecord(row);
}

export async function getDeviceAuthRequestByUserCode(userCode: string): Promise<DeviceAuthRequestRecord | undefined> {
  const row = await getDb()
    .selectFrom('device_auth_requests')
    .selectAll()
    .where('user_code', '=', userCode)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  if (!row) return undefined;
  return toDeviceAuthRecord(row);
}

export async function authorizeDeviceAuthRequest(deviceCode: string, userId: number): Promise<void> {
  await getDb()
    .updateTable('device_auth_requests')
    .set({ status: 'authorized', user_id: userId })
    .where('device_code', '=', deviceCode)
    .execute();
}
