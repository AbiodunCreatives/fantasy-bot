-- Migration: 001_fantasy_safety
-- Safe to run multiple times (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS throughout).
-- Apply in Supabase SQL editor before deploying the updated bot.

-- 1. Pending refund tracking table
CREATE TABLE IF NOT EXISTS fantasy_pending_refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  game_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'failed')),
  retry_count INT NOT NULL DEFAULT 0,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fantasy_pending_refunds_status
  ON fantasy_pending_refunds (status, created_at);

-- 2. Prize transfer status columns on fantasy_payouts
ALTER TABLE fantasy_payouts
  ADD COLUMN IF NOT EXISTS prize_transfer_status TEXT NOT NULL DEFAULT 'pending';

ALTER TABLE fantasy_payouts
  ADD COLUMN IF NOT EXISTS transfer_retry_count INT NOT NULL DEFAULT 0;

-- Mark any existing confirmed payouts (rows that existed before this migration)
-- as already confirmed so they are not retried.
UPDATE fantasy_payouts
SET prize_transfer_status = 'confirmed'
WHERE prize_transfer_status = 'pending';

-- 3. RPC: insert a payout row with status='pending' before the on-chain transfer
CREATE OR REPLACE FUNCTION record_pending_prize_transfer(
  p_game_id UUID,
  p_telegram_id BIGINT,
  p_place INT,
  p_amount NUMERIC,
  p_reference_id TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  normalized_amount NUMERIC(20,6) := ROUND(COALESCE(p_amount, 0)::NUMERIC, 6);
BEGIN
  IF normalized_amount <= 0 THEN
    RETURN FALSE;
  END IF;

  INSERT INTO fantasy_payouts (
    game_id,
    telegram_id,
    place,
    amount,
    prize_transfer_status
  )
  VALUES (
    p_game_id,
    p_telegram_id,
    p_place,
    normalized_amount,
    'pending'
  )
  ON CONFLICT (game_id, telegram_id) DO NOTHING;

  RETURN FOUND;
END;
$$;

-- 4. RPC: mark transfer confirmed and credit internal balance (called after on-chain success)
CREATE OR REPLACE FUNCTION confirm_prize_transfer(
  p_game_id UUID,
  p_member_id UUID,
  p_telegram_id BIGINT,
  p_place INT,
  p_amount NUMERIC,
  p_reference_id TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  normalized_amount NUMERIC(20,6) := ROUND(COALESCE(p_amount, 0)::NUMERIC, 6);
BEGIN
  IF normalized_amount <= 0 THEN
    RETURN FALSE;
  END IF;

  UPDATE fantasy_payouts
  SET prize_transfer_status = 'confirmed'
  WHERE game_id = p_game_id
    AND telegram_id = p_telegram_id
    AND prize_transfer_status = 'pending';

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  UPDATE fantasy_users
  SET
    wallet_balance = ROUND((wallet_balance + normalized_amount)::NUMERIC, 6),
    updated_at = NOW()
  WHERE telegram_id = p_telegram_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet user not found.';
  END IF;

  INSERT INTO fantasy_wallet_ledger (
    telegram_id,
    entry_type,
    direction,
    amount,
    asset,
    status,
    reference_type,
    reference_id,
    idempotency_key,
    metadata
  )
  VALUES (
    p_telegram_id,
    'fantasy_prize',
    'credit',
    normalized_amount,
    'USDC',
    'confirmed',
    'fantasy_game',
    COALESCE(p_reference_id, p_game_id::TEXT),
    'fantasy_prize:' || p_game_id::TEXT || ':' || p_telegram_id::TEXT,
    jsonb_build_object(
      'game_id', p_game_id,
      'member_id', p_member_id,
      'place', p_place
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN TRUE;
END;
$$;
