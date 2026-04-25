# fantasy-bot

Standalone fantasy-only bot scaffold extracted from the main `edgetrader-bot` codebase.

## Included

- `/league` command flow
- `flt:` fantasy trade callbacks
- fantasy join confirmation callbacks
- round monitoring job
- fantasy activation, settlement, and finalization job
- repo-owned virtual wallet and commission tracking

## Intentionally left out

- signal monitors and trade handlers
- Bayse connect / user trading account flow
- search, picks, alerts, and signal UX
- deposit / withdraw commands

## Current funding model

This repo is now virtual-only.
User profiles, play balances, payouts, and commission records all live in this project's own
Supabase tables, so a brand-new Supabase project is enough.

## Private beta defaults

- New users start with a `$40` virtual beta wallet.
- Arena entries use only that virtual balance.
- Manual deposits and withdrawals stay off until the beta period is over.
- Run a single bot instance for the beta, backed by real Redis.

## Quick start

1. Copy `.env.example` to `.env` and fill in Telegram and Supabase values.
2. Choose one cache mode:
   `REDIS_MODE=redis` with a valid `redis://` or `rediss://` `REDIS_URL`, or
   `REDIS_MODE=memory` for single-instance local/test runs.
3. Run [`src/db/schema.sql`](./src/db/schema.sql) in the Supabase SQL editor.
4. Install dependencies with `pnpm install`.
5. Run `pnpm start`.

## Render notes

Use Node 22 and point the service at the source entry with a TypeScript-aware command.

- Build command: `pnpm install --frozen-lockfile`
- Start command: `pnpm start`

If you prefer to run Node directly on Render, `node src/index.ts` also works with the current import setup.
For private beta, keep the bot on one instance and use `REDIS_MODE=redis`.
`REDIS_MODE=memory` is best kept for local smoke checks only.

## Database notes

The full self-contained schema lives in [src/db/schema.sql](./src/db/schema.sql).
New Telegram users are auto-created in `fantasy_users` with the configured
`VIRTUAL_WALLET_START_BALANCE`, so fresh projects do not need any manual ledger setup.
