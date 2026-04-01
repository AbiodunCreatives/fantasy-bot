# fantasy-bot

Standalone fantasy-only bot scaffold extracted from the main `edgetrader-bot` codebase.

## Included

- `/league` command flow
- `flt:` fantasy trade callbacks
- fantasy join confirmation callbacks
- round monitoring job
- fantasy activation, settlement, and finalization job
- shared internal balance and revenue wiring

## Intentionally left out

- signal monitors and trade handlers
- Bayse connect / user trading account flow
- search, picks, alerts, and signal UX
- deposit / withdraw commands

## Current funding model

This scaffold still uses the existing internal balance ledger via `apply_balance_delta`.
That means the target database must already have the shared `user_access`, `balance_ledger`,
`revenue`, `users`, `upsert_user`, and `apply_balance_delta` objects available.

## Quick start

1. Copy `.env.example` to `.env` and fill in Telegram, Supabase, and Redis values.
2. Install dependencies with `pnpm install`.
3. Run `pnpm start`.

## Database notes

The fantasy tables and related commission index live in [src/db/schema.sql](./src/db/schema.sql).
If you later decide to go virtual-only, the main files to replace are:

- `src/db/balances.ts`
- `src/db/revenue.ts`
- the entry-fee and payout calls inside `src/fantasy-league.ts`
