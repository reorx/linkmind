import { sql } from 'kysely';
import { getDb } from './connection.js';

/* ── Agent Sessions ── */

export async function createAgentSession(data: { id: string; refType: string; refId: string; agentName: string }) {
  const row = await getDb()
    .insertInto('agent_session')
    .values({
      id: data.id,
      ref_type: data.refType,
      ref_id: data.refId,
      agent_name: data.agentName,
      status: 'running',
      error_message: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row;
}

export async function updateAgentSessionStatus(sessionId: string, status: string, errorMessage?: string) {
  const update: Record<string, any> = { status, updated_at: sql`NOW()` };
  if (errorMessage !== undefined) update.error_message = errorMessage;
  await getDb().updateTable('agent_session').set(update).where('id', '=', sessionId).execute();
}

export async function getLatestAgentSession(refType: string, refId: string) {
  const row = await getDb()
    .selectFrom('agent_session')
    .selectAll()
    .where('ref_type', '=', refType)
    .where('ref_id', '=', refId)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ?? null;
}

/* ── Agent Events ── */

export async function insertAgentEvent(data: { sessionId: string; eventType: string; name?: string; data?: any }) {
  const row = await getDb()
    .insertInto('agent_event')
    .values({
      session_id: data.sessionId,
      event_type: data.eventType,
      name: data.name ?? null,
      data: data.data != null ? JSON.stringify(data.data) : null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row;
}

export async function getAgentEventsAfterCursor(sessionId: string, cursor: number, limit: number = 100) {
  const rows = await getDb()
    .selectFrom('agent_event')
    .selectAll()
    .where('session_id', '=', sessionId)
    .where('id', '>', cursor)
    .orderBy('id', 'asc')
    .limit(limit)
    .execute();
  return rows;
}

export async function getAgentEventsBySessionId(sessionId: string) {
  const rows = await getDb()
    .selectFrom('agent_event')
    .selectAll()
    .where('session_id', '=', sessionId)
    .orderBy('id', 'asc')
    .execute();
  return rows;
}
