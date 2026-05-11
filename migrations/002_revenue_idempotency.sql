-- Migration: 002_revenue_idempotency
-- Fixes the fantasy_revenue unique index so multiple revenue rows per type
-- category are allowed. Deduplication moves to idempotency_key.
-- Safe to run multiple times.

ALTER TABLE fantasy_revenue
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Backfill existing rows so the unique constraint can be applied.
UPDATE fantasy_revenue
SET idempotency_key = type
WHERE idempotency_key IS NULL;

-- Drop the old unique index on type (was too broad — blocked accumulation).
DROP INDEX IF EXISTS idx_fantasy_revenue_type;

-- Non-unique index for category queries.
CREATE INDEX IF NOT EXISTS idx_fantasy_revenue_type
  ON fantasy_revenue (type);

-- Unique constraint on idempotency_key for deduplication.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fantasy_revenue_idempotency_key
  ON fantasy_revenue (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
