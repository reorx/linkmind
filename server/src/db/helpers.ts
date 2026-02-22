import type { RecordEntry, UserRecord, ProbeEventRecord, DeviceAuthRequestRecord } from './types.js';

/** Convert a DB row to RecordEntry (dates to ISO strings, nulls to undefined) */
export function toRecordEntry(row: any): RecordEntry {
  return {
    ...row,
    type: row.type || 'link',
    url: row.url ?? undefined,
    content: row.content ?? undefined,
    source_url: row.source_url ?? undefined,
    user_note: row.user_note ?? undefined,
    added_by_user: row.added_by_user ?? true,
    related_notes:
      row.related_notes != null
        ? typeof row.related_notes === 'string'
          ? row.related_notes
          : JSON.stringify(row.related_notes)
        : undefined,
    related_links:
      row.related_links != null
        ? typeof row.related_links === 'string'
          ? row.related_links
          : JSON.stringify(row.related_links)
        : undefined,
    tags: row.tags != null ? (typeof row.tags === 'string' ? row.tags : JSON.stringify(row.tags)) : undefined,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    og_title: row.og_title ?? undefined,
    og_description: row.og_description ?? undefined,
    og_image: row.og_image ?? undefined,
    og_site_name: row.og_site_name ?? undefined,
    og_type: row.og_type ?? undefined,
    markdown: row.markdown ?? undefined,
    summary: row.summary ?? undefined,
    insight: row.insight ?? undefined,
    images: row.images ?? undefined,
    error_message: row.error_message ?? undefined,
    telegram_message_id: row.telegram_message_id ?? undefined,
    telegram_chat_id: row.telegram_chat_id ?? undefined,
  };
}

export function toUserRecord(row: any): UserRecord {
  return {
    ...row,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    username: row.username ?? undefined,
    display_name: row.display_name ?? undefined,
    invite_id: row.invite_id ?? undefined,
  };
}

export function toProbeEventRecord(row: any): ProbeEventRecord {
  return {
    ...row,
    link_id: row.link_id ?? undefined,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    sent_at: row.sent_at instanceof Date ? row.sent_at.toISOString() : undefined,
    completed_at: row.completed_at instanceof Date ? row.completed_at.toISOString() : undefined,
  };
}

export function toDeviceAuthRecord(row: any): DeviceAuthRequestRecord {
  return {
    ...row,
    user_id: row.user_id ?? undefined,
    expires_at: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}
