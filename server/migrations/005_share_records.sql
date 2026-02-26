CREATE TABLE share_records (
  id SERIAL PRIMARY KEY,
  nanoid VARCHAR(21) UNIQUE NOT NULL,
  record_id INTEGER UNIQUE NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_share_records_nanoid ON share_records (nanoid);
CREATE INDEX idx_share_records_record_id ON share_records (record_id);
