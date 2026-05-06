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

## Dashboard only mode

If you only want the admin dashboard and do not need the Telegram bot running, you can start the app in dashboard-only mode with a smaller env set:

- `DASHBOARD_ONLY_MODE=true`
- `SUPABASE_URL=...`
- `SUPABASE_SERVICE_ROLE_KEY=...`
- `ADMIN_DASHBOARD_TOKEN=...`
- `HEALTH_CHECK_TOKEN=...`
- `PORT=3000`

Then run `pnpm start` and open:

- `http://localhost:3000/admin/dashboard`

Use the admin token in the login form for the browser dashboard.
For scripted API access, send `x-admin-token: YOUR_ADMIN_DASHBOARD_TOKEN` or `Authorization: Bearer YOUR_ADMIN_DASHBOARD_TOKEN` to `/admin/api/dashboard`.

## PajCash onramp

This repo now includes a first-pass PajCash NGN onramp integration for the wallet flow.

Required env vars:

- `PAJCASH_ENV=production` or `staging`
- `PAJCASH_API_KEY=...`
- `PAJCASH_SESSION_RECIPIENT=your_business_email_or_phone`
- `PAJCASH_SESSION_TOKEN=...`
- `PAJCASH_SESSION_EXPIRES_AT=...`
- `PAJCASH_WEBHOOK_BASE_URL=https://your-public-app-url`
- `PAJCASH_WEBHOOK_PATH_SECRET=your-long-random-secret`

Before turning it on in an existing deployment, rerun [src/db/schema.sql](./src/db/schema.sql) in Supabase so the `fantasy_pajcash_onramps` table exists.

To request and verify a PajCash OTP session:

- `pnpm pajcash:session`

If `PAJCASH_OTP` is not set, the script requests an OTP.
After you receive the OTP, set `PAJCASH_OTP=...` in `.env` and run the script again.
It will print the `PAJCASH_SESSION_TOKEN` and `PAJCASH_SESSION_EXPIRES_AT` values to save into `.env`.

End-user command:

- `/wallet fund-ngn 10000`

This creates a PajCash bank transfer order and credits the in-bot wallet only after native Solana USDC actually lands in the user wallet and is picked up by the existing deposit sync.

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
