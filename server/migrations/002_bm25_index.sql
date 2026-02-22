-- Migration 002: BM25 full-text search index (requires pg_search / ParadeDB on Neon)
-- This migration is optional — only run on databases with pg_search extension.

CREATE EXTENSION IF NOT EXISTS pg_search;

CREATE INDEX idx_records_bm25
ON records USING bm25 (id, og_title, summary, markdown)
WITH (key_field = 'id');
