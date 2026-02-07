-- Probe device registration
CREATE TABLE probe_devices (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  access_token TEXT UNIQUE NOT NULL,
  name TEXT,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Probe event queue
CREATE TABLE probe_events (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  link_id INTEGER REFERENCES links(id),
  url TEXT NOT NULL,
  url_type TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

-- Device auth temporary state
CREATE TABLE device_auth_requests (
  device_code TEXT PRIMARY KEY,
  user_code TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  status TEXT DEFAULT 'pending',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
