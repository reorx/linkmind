CREATE TABLE record_files (
  id SERIAL PRIMARY KEY,
  record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  -- file source
  source TEXT NOT NULL,            -- 'telegram_photo' | 'twitter_media' | 'og_image' | 'scrape'
  source_ref TEXT,                 -- e.g. telegram file_id, twitter media URL
  -- storage
  storage_provider TEXT NOT NULL,  -- 'r2' | 'local'
  storage_key TEXT NOT NULL,
  -- file metadata
  mime_type TEXT,
  size_bytes INTEGER,
  width INTEGER,
  height INTEGER,
  -- extensible
  metadata JSONB DEFAULT '{}',
  -- timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_record_files_record_id ON record_files (record_id);
CREATE INDEX idx_record_files_storage_key ON record_files (storage_key);
