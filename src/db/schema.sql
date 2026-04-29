-- Fantasy bot schema.
-- Apply this whole file to a fresh Supabase project before starting the bot.

CREATE TABLE IF NOT EXISTS fantasy_users (
  telegram_id BIGINT PRIMARY KEY,
  username TEXT,
  wallet_balance NUMERIC(20,6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fantasy_revenue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT,
  type TEXT NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fantasy_revenue_type
  ON fantasy_revenue (type);

CREATE TABLE IF NOT EXISTS fantasy_games (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  creator_telegram_id BIGINT NOT NULL,
  asset TEXT NOT NULL DEFAULT 'BTC'
    CHECK (asset IN ('BTC')),
  entry_fee NUMERIC(10,2) NOT NULL,
  virtual_start_balance NUMERIC(10,2) NOT NULL,
  prize_pool NUMERIC(10,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'active', 'completed', 'cancelled')),
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  last_round_event_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS fantasy_game_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id UUID NOT NULL REFERENCES fantasy_games (id) ON DELETE CASCADE,
  telegram_id BIGINT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entry_fee_paid NUMERIC(10,2) NOT NULL,
  virtual_balance NUMERIC(10,2) NOT NULL,
  total_trades INT NOT NULL DEFAULT 0,
  last_traded_round INT,
  consecutive_missed_rounds INT NOT NULL DEFAULT 0,
  wins INT NOT NULL DEFAULT 0,
  losses INT NOT NULL DEFAULT 0,
  prize_awarded NUMERIC(10,2) NOT NULL DEFAULT 0,
  UNIQUE (game_id, telegram_id)
);

ALTER TABLE IF EXISTS fantasy_game_members
  ADD COLUMN IF NOT EXISTS last_traded_round INT;

ALTER TABLE IF EXISTS fantasy_game_members
  ADD COLUMN IF NOT EXISTS consecutive_missed_rounds INT NOT NULL DEFAULT 0;

UPDATE fantasy_game_members
SET consecutive_missed_rounds = 0
WHERE consecutive_missed_rounds IS NULL;

CREATE TABLE IF NOT EXISTS fantasy_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id UUID NOT NULL REFERENCES fantasy_games (id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES fantasy_game_members (id) ON DELETE CASCADE,
  telegram_id BIGINT NOT NULL,
  event_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('UP', 'DOWN')),
  stake NUMERIC(10,2) NOT NULL,
  entry_price NUMERIC(10,4) NOT NULL,
  shares NUMERIC(18,6) NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (outcome IN ('PENDING', 'WIN', 'LOSS')),
  payout NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (game_id, member_id, event_id)
);

CREATE TABLE IF NOT EXISTS fantasy_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id UUID NOT NULL REFERENCES fantasy_games (id) ON DELETE CASCADE,
  telegram_id BIGINT NOT NULL,
  place INT NOT NULL,
  amount NUMERIC(20,6) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (game_id, telegram_id)
);

CREATE TABLE IF NOT EXISTS fantasy_wallets (
  telegram_id BIGINT PRIMARY KEY REFERENCES fantasy_users (telegram_id) ON DELETE CASCADE,
  chain TEXT NOT NULL DEFAULT 'solana'
    CHECK (chain IN ('solana')),
  owner_address TEXT NOT NULL UNIQUE,
  usdc_ata TEXT NOT NULL UNIQUE,
  encrypted_secret_key TEXT NOT NULL,
  last_seen_usdc_balance_raw BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fantasy_wallet_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT NOT NULL REFERENCES fantasy_users (telegram_id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL,
  direction TEXT NOT NULL
    CHECK (direction IN ('credit', 'debit')),
  amount NUMERIC(20,6) NOT NULL CHECK (amount > 0),
  asset TEXT NOT NULL DEFAULT 'USDC'
    CHECK (asset IN ('USDC')),
  status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('pending', 'confirmed', 'failed', 'cancelled')),
  reference_type TEXT,
  reference_id TEXT,
  idempotency_key TEXT UNIQUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fantasy_wallet_deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT NOT NULL REFERENCES fantasy_users (telegram_id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  usdc_ata TEXT NOT NULL,
  amount NUMERIC(20,6) NOT NULL CHECK (amount > 0),
  amount_raw BIGINT NOT NULL CHECK (amount_raw > 0),
  previous_raw_balance BIGINT NOT NULL DEFAULT 0,
  new_raw_balance BIGINT NOT NULL CHECK (new_raw_balance >= previous_raw_balance),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fantasy_wallet_withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT NOT NULL REFERENCES fantasy_users (telegram_id) ON DELETE CASCADE,
  destination_address TEXT NOT NULL,
  destination_usdc_ata TEXT,
  amount NUMERIC(20,6) NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  tx_signature TEXT,
  failure_reason TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_fantasy_games_status_start_at
  ON fantasy_games (status, start_at);

CREATE INDEX IF NOT EXISTS idx_fantasy_games_status_end_at
  ON fantasy_games (status, end_at);

CREATE INDEX IF NOT EXISTS idx_fantasy_game_members_game_id
  ON fantasy_game_members (game_id);

CREATE INDEX IF NOT EXISTS idx_fantasy_game_members_telegram_id
  ON fantasy_game_members (telegram_id);

CREATE INDEX IF NOT EXISTS idx_fantasy_trades_game_id_created_at
  ON fantasy_trades (game_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fantasy_trades_event_id_outcome
  ON fantasy_trades (event_id, outcome);

CREATE INDEX IF NOT EXISTS idx_fantasy_wallet_ledger_telegram_id_created_at
  ON fantasy_wallet_ledger (telegram_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fantasy_wallet_withdrawals_status_requested_at
  ON fantasy_wallet_withdrawals (status, requested_at);

CREATE OR REPLACE FUNCTION create_fantasy_game_with_entry(
  p_code TEXT,
  p_creator_telegram_id BIGINT,
  p_entry_fee NUMERIC,
  p_virtual_start_balance NUMERIC,
  p_start_at TIMESTAMPTZ,
  p_end_at TIMESTAMPTZ,
  p_commission_rate NUMERIC DEFAULT 0
)
RETURNS SETOF fantasy_games
LANGUAGE plpgsql
AS $$
DECLARE
  normalized_code TEXT := UPPER(BTRIM(p_code));
  normalized_entry_fee NUMERIC(10,2) := ROUND(p_entry_fee::NUMERIC, 2);
  normalized_virtual_start_balance NUMERIC(10,2) :=
    ROUND(p_virtual_start_balance::NUMERIC, 2);
  normalized_commission_rate NUMERIC := GREATEST(COALESCE(p_commission_rate, 0), 0);
  game_row fantasy_games%ROWTYPE;
  member_count INTEGER;
  gross_prize_pool NUMERIC(10,2);
  commission_amount NUMERIC(10,2);
  net_prize_pool NUMERIC(10,2);
BEGIN
  UPDATE fantasy_users
  SET
    wallet_balance = ROUND((wallet_balance - normalized_entry_fee)::NUMERIC, 6),
    updated_at = NOW()
  WHERE telegram_id = p_creator_telegram_id
    AND wallet_balance >= normalized_entry_fee;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient play balance to create an arena.';
  END IF;

  INSERT INTO fantasy_games (
    code,
    creator_telegram_id,
    asset,
    entry_fee,
    virtual_start_balance,
    prize_pool,
    status,
    start_at,
    end_at
  )
  VALUES (
    normalized_code,
    p_creator_telegram_id,
    'BTC',
    normalized_entry_fee,
    normalized_virtual_start_balance,
    normalized_entry_fee,
    'open',
    p_start_at,
    p_end_at
  )
  RETURNING * INTO game_row;

  INSERT INTO fantasy_game_members (
    game_id,
    telegram_id,
    entry_fee_paid,
    virtual_balance
  )
  VALUES (
    game_row.id,
    p_creator_telegram_id,
    normalized_entry_fee,
    normalized_virtual_start_balance
  );

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
    p_creator_telegram_id,
    'arena_entry',
    'debit',
    normalized_entry_fee,
    'USDC',
    'confirmed',
    'fantasy_game',
    game_row.code,
    'arena_entry:' || game_row.id::TEXT || ':' || p_creator_telegram_id::TEXT,
    jsonb_build_object(
      'game_id',
      game_row.id,
      'code',
      game_row.code,
      'role',
      'creator'
    )
  );

  SELECT COUNT(*) INTO member_count
  FROM fantasy_game_members
  WHERE game_id = game_row.id;

  gross_prize_pool := ROUND((member_count * game_row.entry_fee)::NUMERIC, 2);
  commission_amount := ROUND(
    (gross_prize_pool * normalized_commission_rate)::NUMERIC,
    2
  );
  net_prize_pool := ROUND(
    GREATEST(0, gross_prize_pool - commission_amount)::NUMERIC,
    2
  );

  UPDATE fantasy_games
  SET prize_pool = net_prize_pool
  WHERE id = game_row.id
  RETURNING * INTO game_row;

  RETURN NEXT game_row;
END;
$$;

CREATE OR REPLACE FUNCTION join_fantasy_game_with_entry(
  p_code TEXT,
  p_telegram_id BIGINT,
  p_commission_rate NUMERIC DEFAULT 0
)
RETURNS SETOF fantasy_games
LANGUAGE plpgsql
AS $$
DECLARE
  normalized_code TEXT := UPPER(BTRIM(p_code));
  normalized_commission_rate NUMERIC := GREATEST(COALESCE(p_commission_rate, 0), 0);
  game_row fantasy_games%ROWTYPE;
  member_count INTEGER;
  gross_prize_pool NUMERIC(10,2);
  commission_amount NUMERIC(10,2);
  net_prize_pool NUMERIC(10,2);
BEGIN
  SELECT *
  INTO game_row
  FROM fantasy_games
  WHERE code = normalized_code
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Arena not found.';
  END IF;

  IF game_row.status <> 'open' OR game_row.start_at <= NOW() THEN
    RAISE EXCEPTION 'This arena has already started.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM fantasy_game_members
    WHERE game_id = game_row.id
      AND telegram_id = p_telegram_id
  ) THEN
    RAISE EXCEPTION 'You already joined this arena.';
  END IF;

  UPDATE fantasy_users
  SET
    wallet_balance = ROUND((wallet_balance - game_row.entry_fee)::NUMERIC, 6),
    updated_at = NOW()
  WHERE telegram_id = p_telegram_id
    AND wallet_balance >= game_row.entry_fee;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient play balance.';
  END IF;

  BEGIN
    INSERT INTO fantasy_game_members (
      game_id,
      telegram_id,
      entry_fee_paid,
      virtual_balance
    )
    VALUES (
      game_row.id,
      p_telegram_id,
      game_row.entry_fee,
      game_row.virtual_start_balance
    );
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'You already joined this arena.';
  END;

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
    'arena_entry',
    'debit',
    game_row.entry_fee,
    'USDC',
    'confirmed',
    'fantasy_game',
    game_row.code,
    'arena_entry:' || game_row.id::TEXT || ':' || p_telegram_id::TEXT,
    jsonb_build_object(
      'game_id',
      game_row.id,
      'code',
      game_row.code,
      'role',
      'joiner'
    )
  );

  SELECT COUNT(*) INTO member_count
  FROM fantasy_game_members
  WHERE game_id = game_row.id;

  gross_prize_pool := ROUND((member_count * game_row.entry_fee)::NUMERIC, 2);
  commission_amount := ROUND(
    (gross_prize_pool * normalized_commission_rate)::NUMERIC,
    2
  );
  net_prize_pool := ROUND(
    GREATEST(0, gross_prize_pool - commission_amount)::NUMERIC,
    2
  );

  UPDATE fantasy_games
  SET prize_pool = net_prize_pool
  WHERE id = game_row.id
  RETURNING * INTO game_row;

  RETURN NEXT game_row;
END;
$$;

CREATE OR REPLACE FUNCTION place_fantasy_trade_with_debit(
  p_game_id UUID,
  p_member_id UUID,
  p_telegram_id BIGINT,
  p_event_id TEXT,
  p_market_id TEXT,
  p_direction TEXT,
  p_stake NUMERIC,
  p_entry_price NUMERIC,
  p_shares NUMERIC
)
RETURNS SETOF fantasy_trades
LANGUAGE plpgsql
AS $$
DECLARE
  normalized_stake NUMERIC(10,2) := ROUND(p_stake::NUMERIC, 2);
  game_row fantasy_games%ROWTYPE;
  trade_row fantasy_trades%ROWTYPE;
BEGIN
  SELECT *
  INTO game_row
  FROM fantasy_games
  WHERE id = p_game_id
  FOR UPDATE;

  IF NOT FOUND OR game_row.status <> 'active' THEN
    RAISE EXCEPTION 'This league is not active right now.';
  END IF;

  IF game_row.end_at <= NOW() THEN
    RAISE EXCEPTION 'This league has already ended.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM fantasy_game_members
    WHERE id = p_member_id
      AND game_id = p_game_id
      AND telegram_id = p_telegram_id
  ) THEN
    RAISE EXCEPTION 'You are not a member of this league.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM fantasy_trades
    WHERE game_id = p_game_id
      AND member_id = p_member_id
      AND event_id = p_event_id
  ) THEN
    RAISE EXCEPTION 'You already placed a fantasy trade for this round.';
  END IF;

  UPDATE fantasy_game_members
  SET
    virtual_balance = ROUND((virtual_balance - normalized_stake)::NUMERIC, 2),
    total_trades = total_trades + 1
  WHERE id = p_member_id
    AND game_id = p_game_id
    AND telegram_id = p_telegram_id
    AND virtual_balance >= normalized_stake;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient virtual balance.';
  END IF;

  BEGIN
    INSERT INTO fantasy_trades (
      game_id,
      member_id,
      telegram_id,
      event_id,
      market_id,
      direction,
      stake,
      entry_price,
      shares,
      outcome,
      payout
    )
    VALUES (
      p_game_id,
      p_member_id,
      p_telegram_id,
      p_event_id,
      p_market_id,
      p_direction,
      normalized_stake,
      p_entry_price,
      p_shares,
      'PENDING',
      0
    )
    RETURNING * INTO trade_row;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'You already placed a fantasy trade for this round.';
  END;

  RETURN NEXT trade_row;
END;
$$;

CREATE OR REPLACE FUNCTION apply_wallet_balance_change(
  p_telegram_id BIGINT,
  p_delta NUMERIC,
  p_allow_negative BOOLEAN DEFAULT FALSE,
  p_entry_type TEXT DEFAULT 'adjustment',
  p_reference_type TEXT DEFAULT NULL,
  p_reference_id TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS NUMERIC
LANGUAGE plpgsql
AS $$
DECLARE
  normalized_delta NUMERIC(20,6) := ROUND(COALESCE(p_delta, 0)::NUMERIC, 6);
  normalized_amount NUMERIC(20,6) := ABS(normalized_delta);
  next_balance NUMERIC(20,6);
BEGIN
  IF normalized_amount <= 0 THEN
    SELECT wallet_balance
    INTO next_balance
    FROM fantasy_users
    WHERE telegram_id = p_telegram_id;

    RETURN COALESCE(next_balance, 0);
  END IF;

  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1
    FROM fantasy_wallet_ledger
    WHERE idempotency_key = p_idempotency_key
  ) THEN
    SELECT wallet_balance
    INTO next_balance
    FROM fantasy_users
    WHERE telegram_id = p_telegram_id;

    RETURN COALESCE(next_balance, 0);
  END IF;

  UPDATE fantasy_users
  SET
    wallet_balance = ROUND((wallet_balance + normalized_delta)::NUMERIC, 6),
    updated_at = NOW()
  WHERE telegram_id = p_telegram_id
    AND (p_allow_negative OR wallet_balance + normalized_delta >= 0)
  RETURNING wallet_balance INTO next_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient wallet balance.';
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
    COALESCE(NULLIF(BTRIM(p_entry_type), ''), 'adjustment'),
    CASE
      WHEN normalized_delta >= 0 THEN 'credit'
      ELSE 'debit'
    END,
    normalized_amount,
    'USDC',
    'confirmed',
    p_reference_type,
    p_reference_id,
    p_idempotency_key,
    COALESCE(p_metadata, '{}'::jsonb)
  );

  RETURN next_balance;
END;
$$;

CREATE OR REPLACE FUNCTION record_solana_wallet_deposit_delta(
  p_telegram_id BIGINT,
  p_wallet_address TEXT,
  p_usdc_ata TEXT,
  p_previous_raw_balance BIGINT,
  p_new_raw_balance BIGINT,
  p_amount NUMERIC,
  p_amount_raw BIGINT
)
RETURNS NUMERIC
LANGUAGE plpgsql
AS $$
DECLARE
  normalized_amount NUMERIC(20,6) := ROUND(COALESCE(p_amount, 0)::NUMERIC, 6);
  deposit_key TEXT :=
    'solana_deposit:' ||
    p_telegram_id::TEXT ||
    ':' ||
    p_previous_raw_balance::TEXT ||
    ':' ||
    p_new_raw_balance::TEXT;
  next_balance NUMERIC(20,6);
BEGIN
  IF p_new_raw_balance <= p_previous_raw_balance OR p_amount_raw <= 0 OR normalized_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid Solana deposit delta.';
  END IF;

  UPDATE fantasy_wallets
  SET
    last_seen_usdc_balance_raw = p_new_raw_balance,
    updated_at = NOW()
  WHERE telegram_id = p_telegram_id
    AND owner_address = p_wallet_address
    AND usdc_ata = p_usdc_ata
    AND last_seen_usdc_balance_raw = p_previous_raw_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stale wallet deposit state.';
  END IF;

  INSERT INTO fantasy_wallet_deposits (
    telegram_id,
    wallet_address,
    usdc_ata,
    amount,
    amount_raw,
    previous_raw_balance,
    new_raw_balance,
    idempotency_key
  )
  VALUES (
    p_telegram_id,
    p_wallet_address,
    p_usdc_ata,
    normalized_amount,
    p_amount_raw,
    p_previous_raw_balance,
    p_new_raw_balance,
    deposit_key
  );

  UPDATE fantasy_users
  SET
    wallet_balance = ROUND((wallet_balance + normalized_amount)::NUMERIC, 6),
    updated_at = NOW()
  WHERE telegram_id = p_telegram_id
  RETURNING wallet_balance INTO next_balance;

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
    'deposit',
    'credit',
    normalized_amount,
    'USDC',
    'confirmed',
    'solana_wallet',
    p_wallet_address,
    deposit_key,
    jsonb_build_object(
      'wallet_address',
      p_wallet_address,
      'usdc_ata',
      p_usdc_ata,
      'previous_raw_balance',
      p_previous_raw_balance,
      'new_raw_balance',
      p_new_raw_balance,
      'amount_raw',
      p_amount_raw
    )
  );

  RETURN next_balance;
END;
$$;

CREATE OR REPLACE FUNCTION request_solana_withdrawal(
  p_telegram_id BIGINT,
  p_destination_address TEXT,
  p_amount NUMERIC
)
RETURNS SETOF fantasy_wallet_withdrawals
LANGUAGE plpgsql
AS $$
DECLARE
  normalized_amount NUMERIC(20,6) := ROUND(COALESCE(p_amount, 0)::NUMERIC, 6);
  normalized_destination_address TEXT := BTRIM(COALESCE(p_destination_address, ''));
  withdrawal_row fantasy_wallet_withdrawals%ROWTYPE;
BEGIN
  IF normalized_amount <= 0 THEN
    RAISE EXCEPTION 'Withdrawal amount must be greater than zero.';
  END IF;

  IF normalized_destination_address = '' THEN
    RAISE EXCEPTION 'Destination wallet is required.';
  END IF;

  UPDATE fantasy_users
  SET
    wallet_balance = ROUND((wallet_balance - normalized_amount)::NUMERIC, 6),
    updated_at = NOW()
  WHERE telegram_id = p_telegram_id
    AND wallet_balance >= normalized_amount;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient wallet balance.';
  END IF;

  INSERT INTO fantasy_wallet_withdrawals (
    telegram_id,
    destination_address,
    amount,
    status
  )
  VALUES (
    p_telegram_id,
    normalized_destination_address,
    normalized_amount,
    'pending'
  )
  RETURNING * INTO withdrawal_row;

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
    'withdrawal_request',
    'debit',
    normalized_amount,
    'USDC',
    'pending',
    'solana_wallet_withdrawal',
    withdrawal_row.id::TEXT,
    'withdrawal_request:' || withdrawal_row.id::TEXT,
    jsonb_build_object(
      'destination_address',
      normalized_destination_address
    )
  );

  RETURN NEXT withdrawal_row;
END;
$$;

CREATE OR REPLACE FUNCTION award_fantasy_prize_with_credit(
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

  INSERT INTO fantasy_payouts (
    game_id,
    telegram_id,
    place,
    amount
  )
  VALUES (
    p_game_id,
    p_telegram_id,
    p_place,
    normalized_amount
  )
  ON CONFLICT (game_id, telegram_id) DO NOTHING;

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
      'game_id',
      p_game_id,
      'member_id',
      p_member_id,
      'place',
      p_place
    )
  );

  RETURN TRUE;
END;
$$;
