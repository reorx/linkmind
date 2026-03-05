import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE user_balances (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
      cycle_limit_usd NUMERIC(10,4) NOT NULL DEFAULT 1.0000,
      cycle_anchor DATE NOT NULL DEFAULT CURRENT_DATE,
      current_cycle_usage_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
      current_cycle_start DATE NOT NULL DEFAULT CURRENT_DATE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (cycle_limit_usd >= 0)
    )
  `.execute(db);

  await sql`
    CREATE TABLE usage_transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      record_id INTEGER REFERENCES records(id),
      step TEXT,
      type TEXT NOT NULL CHECK (type IN ('llm', 'crawler', 'embedding')),
      provider TEXT NOT NULL,
      amount_usd NUMERIC(10,6) NOT NULL CHECK (amount_usd >= 0),
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_usage_tx_user_created ON usage_transactions (user_id, created_at)
  `.execute(db);

  await sql`
    CREATE INDEX idx_usage_tx_record ON usage_transactions (record_id)
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX idx_usage_tx_idempotent
      ON usage_transactions (record_id, step)
      WHERE record_id IS NOT NULL AND step IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {}
