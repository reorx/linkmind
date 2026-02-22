import { getDb } from './connection.js';

export async function saveRelatedRecords(
  recordId: number,
  relations: { relatedRecordId: number; score: number }[],
): Promise<void> {
  const db = getDb();

  await db.deleteFrom('record_relations').where('record_id', '=', recordId).execute();

  if (relations.length > 0) {
    await db
      .insertInto('record_relations')
      .values(
        relations.map((r) => ({
          record_id: recordId,
          related_record_id: r.relatedRecordId,
          score: r.score,
        })),
      )
      .execute();
  }
}

/**
 * Get related records (bidirectional). Deduplicates and returns top 5 by score.
 */
export async function getRelatedRecords(recordId: number): Promise<{ relatedRecordId: number; score: number }[]> {
  const db = getDb();

  const outgoing = await db
    .selectFrom('record_relations')
    .select(['related_record_id as other_id', 'score'])
    .where('record_id', '=', recordId)
    .execute();

  const incoming = await db
    .selectFrom('record_relations')
    .select(['record_id as other_id', 'score'])
    .where('related_record_id', '=', recordId)
    .execute();

  const scoreMap = new Map<number, number>();
  for (const row of [...outgoing, ...incoming]) {
    const otherId = (row as any).other_id;
    const existing = scoreMap.get(otherId);
    if (!existing || row.score > existing) {
      scoreMap.set(otherId, row.score);
    }
  }

  return Array.from(scoreMap.entries())
    .map(([relatedRecordId, score]) => ({ relatedRecordId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

export async function addDerivation(sourceRecordId: number, derivedRecordId: number): Promise<void> {
  await getDb()
    .insertInto('record_derivations')
    .values({ source_record_id: sourceRecordId, derived_record_id: derivedRecordId })
    .onConflict((oc) => oc.columns(['source_record_id', 'derived_record_id']).doNothing())
    .execute();
}

export async function getDerivationSources(recordId: number): Promise<number[]> {
  const rows = await getDb()
    .selectFrom('record_derivations')
    .select('source_record_id')
    .where('derived_record_id', '=', recordId)
    .execute();
  return rows.map((r) => r.source_record_id);
}

export async function getDerivedRecords(recordId: number): Promise<number[]> {
  const rows = await getDb()
    .selectFrom('record_derivations')
    .select('derived_record_id')
    .where('source_record_id', '=', recordId)
    .execute();
  return rows.map((r) => r.derived_record_id);
}
