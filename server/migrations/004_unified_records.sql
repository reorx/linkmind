-- Migration 004: Unified Records Model
-- Renames links → records, adds type/note support, derivation tracking

-- 1. Rename table
ALTER TABLE links RENAME TO records;

-- 2. Add new columns
ALTER TABLE records ADD COLUMN type TEXT NOT NULL DEFAULT 'link';
ALTER TABLE records ADD COLUMN content TEXT;
ALTER TABLE records ADD COLUMN source_url TEXT;
ALTER TABLE records ADD COLUMN user_note TEXT;
ALTER TABLE records ADD COLUMN added_by_user BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE records ADD COLUMN telegram_message_id BIGINT;
ALTER TABLE records ADD COLUMN telegram_chat_id BIGINT;

-- 3. Update existing records (all existing links are user-added)
UPDATE records SET type = 'link', added_by_user = TRUE;

-- 4. Rename link_relations table references
ALTER TABLE link_relations RENAME COLUMN link_id TO record_id;
ALTER TABLE link_relations RENAME COLUMN related_link_id TO related_record_id;
ALTER TABLE link_relations RENAME TO record_relations;

-- 5. Record derivations (many-to-many: who derived whom)
CREATE TABLE record_derivations (
  source_record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  derived_record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_record_id, derived_record_id)
);

-- 6. Indexes
CREATE INDEX idx_records_type ON records(type);
CREATE INDEX idx_records_added_by_user ON records(added_by_user);
CREATE INDEX idx_records_telegram_msg ON records(telegram_chat_id, telegram_message_id);
CREATE INDEX idx_derivations_derived ON record_derivations(derived_record_id);
