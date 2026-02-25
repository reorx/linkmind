import { Generated } from 'kysely';

/* ── Application types ── */

export type RecordType = 'link' | 'note';

export interface UserRecord {
  id?: number;
  telegram_id: number;
  username?: string;
  display_name?: string;
  status: 'pending' | 'active';
  invite_id?: number;
  created_at?: string;
}

export interface InviteRecord {
  id?: number;
  code: string;
  max_uses: number;
  used_count: number;
  created_at?: string;
}

export interface RecordEntry {
  id?: number;
  user_id: number;
  type: RecordType;
  url?: string;
  content?: string;
  source_url?: string;
  user_note?: string;
  added_by_user: boolean;
  og_title?: string;
  og_description?: string;
  og_image?: string;
  og_site_name?: string;
  og_type?: string;
  markdown?: string;
  summary?: string;
  insight?: string;
  related_notes?: string;
  related_links?: string;
  tags?: string;
  images?: string;
  summary_embedding?: string;
  status: 'enqueued' | 'pending' | 'scraped' | 'analyzed' | 'error' | 'waiting_probe';
  error_message?: string;
  telegram_message_id?: number;
  telegram_chat_id?: number;
  created_at?: string;
  updated_at?: string;
}

export interface ProbeDeviceRecord {
  id: string;
  user_id: number;
  access_token: string;
  name?: string;
  last_seen_at?: string;
  created_at?: string;
}

export interface ProbeEventRecord {
  id: string;
  user_id: number;
  link_id?: number;
  url: string;
  url_type: string;
  status: string;
  result?: any;
  error?: string;
  created_at?: string;
  sent_at?: string;
  completed_at?: string;
}

export interface DeviceAuthRequestRecord {
  device_code: string;
  user_code: string;
  user_id?: number;
  status: string;
  expires_at: string;
  created_at?: string;
}

export interface RecordRelation {
  id?: number;
  record_id: number;
  related_record_id: number;
  score: number;
  created_at?: string;
}

/* ── Kysely table types ── */

export interface InvitesTable {
  id: Generated<number>;
  code: string;
  max_uses: number;
  used_count: number;
  created_at: Generated<Date>;
}

export interface UsersTable {
  id: Generated<number>;
  telegram_id: number;
  username: string | null;
  display_name: string | null;
  status: string;
  invite_id: number | null;
  created_at: Generated<Date>;
}

export interface RecordsTable {
  id: Generated<number>;
  user_id: number;
  type: string;
  url: string | null;
  content: string | null;
  source_url: string | null;
  user_note: string | null;
  added_by_user: boolean;
  og_title: string | null;
  og_description: string | null;
  og_image: string | null;
  og_site_name: string | null;
  og_type: string | null;
  markdown: string | null;
  summary: string | null;
  insight: string | null;
  related_notes: string | null;
  related_links: string | null;
  tags: string | null;
  images: string | null;
  summary_embedding: string | null;
  status: string;
  error_message: string | null;
  telegram_message_id: number | null;
  telegram_chat_id: number | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface RecordRelationsTable {
  id: Generated<number>;
  record_id: number;
  related_record_id: number;
  score: number;
  created_at: Generated<Date>;
}

export interface RecordDerivationsTable {
  source_record_id: number;
  derived_record_id: number;
  created_at: Generated<Date>;
}

export interface ProbeDevicesTable {
  id: string;
  user_id: number;
  access_token: string;
  name: string | null;
  last_seen_at: Date | null;
  created_at: Generated<Date>;
}

export interface ProbeEventsTable {
  id: string;
  user_id: number;
  link_id: number | null;
  url: string;
  url_type: string;
  status: string;
  result: any | null;
  error: string | null;
  created_at: Generated<Date>;
  sent_at: Date | null;
  completed_at: Date | null;
}

export interface DeviceAuthRequestsTable {
  device_code: string;
  user_code: string;
  user_id: number | null;
  status: string;
  expires_at: Date;
  created_at: Generated<Date>;
}

export interface AgentSessionsTable {
  id: string;
  ref_type: string;
  ref_id: string;
  agent_name: string;
  status: string;
  error_message: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AgentEventsTable {
  id: Generated<number>;
  session_id: string;
  event_type: string;
  name: string | null;
  data: any | null;
  created_at: Generated<Date>;
}

export interface Database {
  invites: InvitesTable;
  users: UsersTable;
  records: RecordsTable;
  record_relations: RecordRelationsTable;
  record_derivations: RecordDerivationsTable;
  probe_devices: ProbeDevicesTable;
  probe_events: ProbeEventsTable;
  device_auth_requests: DeviceAuthRequestsTable;
  agent_session: AgentSessionsTable;
  agent_event: AgentEventsTable;
}
