# Post-Beta Security Fix Instructions For Codex

This document captures the security audit findings that should be addressed after the private beta phase.

The current beta goal is limited:

- onboard about 10 private testers
- validate join/trade flow
- validate game resolution
- validate payout behavior

Because this is a small play-money beta, some risks are temporarily acceptable if the bot is run in a tightly controlled way. This document is for the next phase, when we want to harden the system before broader rollout.

## Current Operating Assumptions During Beta

These are temporary assumptions, not permanent design decisions:

- run a single bot instance
- prefer long polling over a public webhook during the private beta
- keep `REDIS_MODE=redis`
- keep tester access limited to a known small group
- treat balances and payouts as manually reviewable during the beta

## Goal For The Post-Beta Fix Pass

Codex should harden the system so it is safe for a broader beta or public-facing deployment. The priority is to preserve game integrity, prevent spoofed updates or abuse, and make balance/payout logic transactional and recoverable.

## Scope

Review and patch all relevant code in:

- [src/index.ts](/abs/path/c:/Users/USER/OneDrive/Desktop/fantasybot/src/index.ts)
- [src/config.ts](/abs/path/c:/Users/USER/OneDrive/Desktop/fantasybot/src/config.ts)
- [src/fantasy-league.ts](/abs/path/c:/Users/USER/OneDrive/Desktop/fantasybot/src/fantasy-league.ts)
- [src/fantasy-monitor.ts](/abs/path/c:/Users/USER/OneDrive/Desktop/fantasybot/src/fantasy-monitor.ts)
- [src/fantasy-settlement.ts](/abs/path/c:/Users/USER/OneDrive/Desktop/fantasybot/src/fantasy-settlement.ts)
- [src/db/schema.sql](/abs/path/c:/Users/USER/OneDrive/Desktop/fantasybot/src/db/schema.sql)
- [src/db/fantasy.ts](/abs/path/c:/Users/USER/OneDrive/Desktop/fantasybot/src/db/fantasy.ts)
- [src/db/balances.ts](/abs/path/c:/Users/USER/OneDrive/Desktop/fantasybot/src/db/balances.ts)
- [src/db/users.ts](/abs/path/c:/Users/USER/OneDrive/Desktop/fantasybot/src/db/users.ts)
- [src/utils/rateLimit.ts](/abs/path/c:/Users/USER/OneDrive/Desktop/fantasybot/src/utils/rateLimit.ts)
- [README.md](/abs/path/c:/Users/USER/OneDrive/Desktop/fantasybot/README.md)
- [.env.example](/abs/path/c:/Users/USER/OneDrive/Desktop/fantasybot/.env.example)

If schema changes are needed, update the SQL and keep the application code aligned. If the project later adopts a migrations folder, split the changes into forward-only migrations instead of editing the base schema in place.

## Priority Order

1. Webhook and ingress hardening
2. Atomic settlement and payout integrity
3. Access control for onboarding and starter balances
4. Abuse controls and rate limiting
5. Upstream resilience and replay safety
6. Dependency and low-severity cleanup

## Findings To Fix

### 1. Fail-Open Webhook And Environment Hardening

Current concern:

- security-sensitive checks are only enforced when `NODE_ENV === "production"`
- `NODE_ENV` defaults to `development`
- the webhook path secret can fall back to a predictable default
- `WEBHOOK_SECRET` is optional outside explicit production mode
- `/health` can be left open
- the full webhook URL, including the secret path, is logged
- incoming webhook bodies are passed to `bot.handleUpdate` without replay protection

Files to inspect:

- `src/config.ts`
- `src/index.ts`
- `.env.example`
- `README.md`

Required fixes:

- fail closed whenever `WEBHOOK_URL` is set, even if `NODE_ENV` is misconfigured
- require a non-default `WEBHOOK_PATH_SECRET` when webhooks are enabled
- require `WEBHOOK_SECRET` when webhooks are enabled
- require `HEALTH_CHECK_TOKEN` whenever the service exposes `/health` publicly, or provide an explicit way to disable the route
- stop logging secrets or secret-bearing URLs
- add replay protection for webhook updates, keyed by Telegram `update_id`
- optionally add source IP validation or deployment guidance for reverse-proxy allowlisting

Acceptance criteria:

- app startup fails if webhook mode is enabled without hardened secrets
- webhook logs do not expose raw secret material
- duplicate webhook deliveries for the same `update_id` are ignored safely
- README clearly documents safe deployment modes

### 2. Make Trade Settlement Atomic

Current concern:

- settling a trade updates the trade row and the member row in separate steps
- rollback only reopens the trade row and does not fully compensate member stats or balances
- crashes or transient failures can produce duplicate or missing settlement effects

Files to inspect:

- `src/fantasy-league.ts`
- `src/db/fantasy.ts`
- `src/db/schema.sql`

Required fixes:

- move trade settlement into a single transactional database function or equivalent atomic RPC
- ensure the following happen together:
  - trade transitions from `PENDING` to final outcome
  - payout amount is recorded
  - member `wins` and `losses` are updated
  - member `virtual_balance` is updated
- make the operation idempotent so retries cannot double-apply winnings
- add a reconciliation path for partially settled rounds from older deployments

Acceptance criteria:

- repeated settlement attempts do not duplicate balance changes
- a crash between steps cannot leave trade status and member balance out of sync
- round settlement can be retried safely after failure

### 3. Make Prize Awards And Wallet Credits Atomic

Current concern:

- payout marker insertion and wallet credit are separate actions
- failures can leave a payout row without a wallet credit, or a wallet credit without a reliable payout record
- finalization is not fully transactional

Files to inspect:

- `src/fantasy-league.ts`
- `src/db/fantasy.ts`
- `src/db/balances.ts`
- `src/db/schema.sql`

Required fixes:

- replace the current two-step payout flow with one atomic operation
- ensure prize award record creation and `fantasy_users.wallet_balance` credit happen in one transaction
- add idempotency based on `game_id` and `telegram_id`
- strongly consider introducing an append-only wallet ledger instead of direct balance mutation
- if a ledger is introduced, derive or reconcile balances from ledger entries

Acceptance criteria:

- payouts cannot be double-credited
- payouts cannot be marked complete without funding the winner
- retries after failure remain safe

### 4. Add Explicit Tester Access Control

Current concern:

- any Telegram user who reaches the bot is auto-created
- each new user gets the starter wallet balance automatically
- there is no allowlist, invite code, or approval gate

Files to inspect:

- `src/index.ts`
- `src/db/users.ts`
- `src/config.ts`
- `README.md`
- `.env.example`

Required fixes:

- add an allowlist or invite-based onboarding path
- separate profile creation from starter-balance issuance
- ensure starter balance is granted exactly once and only after authorization
- support a small private beta mode and a broader mode with clear configuration

Acceptance criteria:

- unauthorized Telegram IDs cannot receive a funded account
- authorized testers can still onboard smoothly
- the starter balance is never granted more than once per approved user

### 5. Add Real Rate Limiting And Abuse Controls

Current concern:

- there is no effective per-user or per-IP rate limiting
- expensive commands can trigger repeated Supabase and Bayse calls
- arena creation, join preview, live views, and trade callbacks are abuseable

Files to inspect:

- `src/index.ts`
- `src/utils/rateLimit.ts`
- `src/bot/handlers/league.ts`
- `src/fantasy-league.ts`

Required fixes:

- implement Redis-backed throttling for:
  - webhook ingress by IP or trusted upstream identity
  - bot commands per Telegram ID
  - arena creation
  - join preview / lookup spam
  - trade placement attempts
- add backoff-friendly user messages instead of generic failures
- keep limits configurable

Acceptance criteria:

- high-frequency spam is throttled before it can degrade the bot
- a single user cannot flood Bayse quote calls or settlement-adjacent paths
- normal use by legitimate players remains smooth

### 6. Add Timeouts, Retries, And Recovery Around Bayse Calls

Current concern:

- all Bayse requests use raw `fetch()` without timeout controls
- the monitors use in-flight guards, so a hanging request can stall future ticks
- Bayse is a critical upstream dependency for round pricing and resolution

Files to inspect:

- `src/bayse-market.ts`
- `src/fantasy-monitor.ts`
- `src/fantasy-settlement.ts`
- `src/fantasy-league.ts`

Required fixes:

- add `AbortController`-based timeouts to all external requests
- add bounded retries where appropriate
- add circuit-breaker or cooldown behavior after repeated upstream failures
- ensure monitor loops recover from hung or slow upstream calls
- add observability around stalled rounds and delayed settlement

Acceptance criteria:

- a slow Bayse response cannot block the monitor indefinitely
- the bot continues to recover after temporary upstream failures
- operators can see when upstream issues are affecting game flow

### 7. Improve Replay Safety And State Consistency

Current concern:

- callback processing and webhook handling rely mostly on current state checks
- replayed webhook bodies or repeated callback delivery can still create avoidable noise
- join and prompt state depend on Redis TTL values without broader replay accounting

Files to inspect:

- `src/index.ts`
- `src/fantasy-league.ts`
- `src/utils/rateLimit.ts`

Required fixes:

- store recently seen `update_id` values with TTL and drop duplicates
- make sensitive handlers explicitly idempotent where possible
- document state machine assumptions around:
  - join confirmation
  - round prompt references
  - reminder state
  - settlement retries

Acceptance criteria:

- repeated deliveries do not mutate state twice
- replayed updates degrade gracefully instead of creating inconsistent outcomes

### 8. Do Not Treat Arena Codes As Secrets

Current concern:

- arena codes are generated with `Math.random()`
- current codes are fine for UX labels, but not for access control or privacy

Files to inspect:

- `src/fantasy-league.ts`

Required fixes:

- if arena codes are intended to remain human-friendly only, document that they are not a security boundary
- if private access is needed, add a separate cryptographically strong invite token
- if replacing the code generator, use crypto-safe randomness

Acceptance criteria:

- arena discovery does not rely on weak randomness if privacy matters

### 9. Clean Up Dependency Risk

Current concern:

- `pnpm audit --prod` reported vulnerable `path-to-regexp` transitively via Express/router

Files to inspect:

- `package.json`
- `pnpm-lock.yaml`

Required fixes:

- upgrade the affected dependency chain so `path-to-regexp >= 8.4.0` is used
- rerun the audit
- verify that routing behavior still matches existing handlers

Acceptance criteria:

- production dependency audit is clean or remaining exceptions are documented with justification

## Recommended Implementation Strategy

Implement the work in phases, not as one giant change.

### Phase 1

- harden webhook mode
- remove secret leakage in logs
- add update replay protection

### Phase 2

- make trade settlement atomic
- make payouts atomic
- add reconciliation tools if needed

### Phase 3

- add tester allowlist or invite gating
- separate starter-balance issuance from user profile creation

### Phase 4

- add rate limiting
- add upstream request timeouts and resilience

### Phase 5

- dependency cleanup
- arena token improvement if needed
- documentation polish

## Testing Requirements

Codex should not stop at implementation. Add or run verification for:

- duplicate webhook delivery
- join confirmation replay
- duplicate trade settlement attempts
- payout retry after transient failure
- Bayse timeout behavior
- unauthorized user onboarding attempts
- rate-limit behavior under repeated command spam

If no test harness exists yet, add at least focused smoke or integration coverage around the money-moving paths and document what was manually verified.

## Deliverables

When Codex returns to this task, the expected deliverables are:

- code changes implementing the fixes
- schema changes or migrations
- updated deployment documentation
- updated environment template
- verification notes showing how the critical integrity cases were tested

## Important Constraint

Do not weaken the current private-beta workflow while implementing post-beta hardening. If needed, introduce explicit feature flags or deployment modes so the small invite-only beta remains easy to operate while the broader launch path becomes safe by default.
