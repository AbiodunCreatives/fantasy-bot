-- Fantasy bot schema.
-- Apply this whole file to a fresh Supabase project before starting the bot.

CREATE TABLE IF NOT EXISTS fantasy_users (
  telegram_id BIGINT PRIMARY KEY,
  username TEXT,
  wallet_balance NUMERIC(10,2) NOT NULL DEFAULT 0,
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
  wins INT NOT NULL DEFAULT 0,
  losses INT NOT NULL DEFAULT 0,
  prize_awarded NUMERIC(10,2) NOT NULL DEFAULT 0,
  UNIQUE (game_id, telegram_id)
);

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
  amount NUMERIC(10,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (game_id, telegram_id)
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
