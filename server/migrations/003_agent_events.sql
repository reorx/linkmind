-- Agent session: one per pipeline run
CREATE TABLE agent_session (
  id VARCHAR(32) PRIMARY KEY,
  ref_type VARCHAR(64) NOT NULL,
  ref_id VARCHAR(32) NOT NULL,
  agent_name VARCHAR(128) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'running',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_session_ref ON agent_session(ref_type, ref_id);

-- Agent event: individual events within a session
CREATE TABLE agent_event (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(32) NOT NULL REFERENCES agent_session(id),
  event_type VARCHAR(32) NOT NULL,
  name VARCHAR(128),
  data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_event_session ON agent_event(session_id);
