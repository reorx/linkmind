import { type Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE crawler_api_keys (
      id SERIAL PRIMARY KEY,
      crawler_type TEXT NOT NULL,
      label TEXT NOT NULL,
      api_key TEXT NOT NULL,
      total_credits BIGINT NOT NULL DEFAULT 0,
      used_credits BIGINT NOT NULL DEFAULT 0,
      exhausted BOOLEAN NOT NULL DEFAULT FALSE,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)

  await sql`
    CREATE INDEX idx_crawler_api_keys_type ON crawler_api_keys (crawler_type)
  `.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS crawler_api_keys`.execute(db)
}
