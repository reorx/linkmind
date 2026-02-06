-- Migration: Rename embedding to summary_embedding
-- This field will only store the embedding of the summary text

ALTER TABLE links RENAME COLUMN embedding TO summary_embedding;
