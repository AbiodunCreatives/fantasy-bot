# fantasy-bot

Standalone fantasy-only bot scaffold extracted from the main `edgetrader-bot` codebase.

## Included

- `/league` command flow
- `/wallet` Solana USDC funding flow
- `flt:` fantasy trade callbacks
- fantasy join confirmation callbacks
- round monitoring job
- fantasy activation, settlement, and finalization job
- custodial Solana USDC wallet ledger and commission tracking

## Intentionally left out

- signal monitors and trade handlers
- Bayse connect / user trading account flow
- search, picks, alerts, and signal UX

## Current funding model

This repo now uses real `USDC` on `Solana` for funding and withdrawals.

- Each Telegram user gets a separate custodial in-bot Solana wallet address for deposits.
- Deposits are detected on-chain, credited to the user's internal balance, and swept into the bot treasury.
- Arena entries debit that internal USDC balance.
- Arena gameplay remains virtual while the arena is live.
- Winnings credit back to the user's in-bot balance.
- Withdrawals are sent from the bot treasury to any Solana wallet the user specifies.

Run a single bot instance for production or beta so wallet sweeps and withdrawals are processed safely.

## Quick start

1. Copy `.env.example` to `.env` and fill in Telegram, Supabase, Redis, and Solana values.
2. Choose one cache mode:
   `REDIS_MODE=redis` with a valid `redis://` or `rediss://` `REDIS_URL`, or
   `REDIS_MODE=memory` for single-instance local/test runs.
3. Fund the Solana treasury wallet with enough `SOL` for fees and enough `USDC` for withdrawals.
4. Run [`src/db/schema.sql`](./src/db/schema.sql) in the Supabase SQL editor.
5. Install dependencies with `pnpm install`.
6. Run `pnpm start`.

## Render notes

Use Node 22 and point the service at the source entry with a TypeScript-aware command.

- Build command: `pnpm install --frozen-lockfile`
- Start command: `pnpm start`

If you prefer to run Node directly on Render, `node src/index.ts` also works with the current import setup.
For Solana wallet processing, keep the bot on one instance and use `REDIS_MODE=redis`.
`REDIS_MODE=memory` is best kept for local smoke checks only.

## Database notes

The full self-contained schema lives in [src/db/schema.sql](./src/db/schema.sql).
`fantasy_users.wallet_balance` is now an internal USDC ledger balance backed by:

- `fantasy_wallets` for per-user Solana deposit addresses
- `fantasy_wallet_ledger` for auditable credits and debits
- `fantasy_wallet_deposits` for confirmed on-chain deposit credits
- `fantasy_wallet_withdrawals` for queued and completed withdrawals
