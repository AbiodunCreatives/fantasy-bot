## PajCash SDK review handoff

Date: 2026-05-06

### Workspace context
- Main app repo: `C:\Users\USER\OneDrive\Desktop\fantasybot`
- Cloned PajCash SDK repo: `C:\Users\USER\OneDrive\Desktop\fantasybot\tmp\paj_ramp_sdk_review`

### User goal
Figure out whether PajCash can support NGN onramp/offramp for the Telegram fantasy bot, and whether the SDK/repo answers the production-readiness questions around auth, webhook trust, statuses, and flow semantics.

### What was inspected
- `tmp/paj_ramp_sdk_review/lib/API_REFERENCE.md`
- `tmp/paj_ramp_sdk_review/lib/utility/session/initiate.ts`
- `tmp/paj_ramp_sdk_review/lib/utility/session/verify.ts`
- `tmp/paj_ramp_sdk_review/lib/on_ramp/createOrder.ts`
- `tmp/paj_ramp_sdk_review/lib/off_ramp/createOrder.ts`
- `tmp/paj_ramp_sdk_review/lib/utility/transaction/getTransaction.ts`
- `tmp/paj_ramp_sdk_review/utils/enums.ts`
- `tmp/paj_ramp_sdk_review/utils/onramp-socket.ts`
- `tmp/paj_ramp_sdk_review/examples/webhook-integration/server.js`
- `tmp/paj_ramp_sdk_review/examples/webhook-integration/README.md`

### Confirmed answers
1. Auth model:
   - Business `apiKey` is only used for `/pub/initiate` and `/pub/verify`.
   - A `sessionToken` is returned by verify and is used for all other authenticated endpoints.
   - `expiresAt` is returned; API reference says to re-verify when expired.
   - There is no refresh endpoint in the repo.

2. Session flow implication:
   - SDK suggests OTP goes to the email/phone you pass into `initiate(...)`.
   - This looks like a server/operator/business session, not a per-end-user Telegram session.
   - Good fit: one operator session cached server-side until `expiresAt`, then re-verify.

3. Onramp flow:
   - `createOnrampOrder` posts to `/pub/onramp`.
   - `recipient` is explicitly the destination wallet address that will receive crypto.
   - This matches the bot design where each user already has a Solana wallet.

4. Offramp flow:
   - `createOfframpOrder` posts to `/pub/offramp`.
   - Response includes `address`, which API reference explicitly describes as the deposit address to send crypto to.
   - Good fit: bot treasury sends USDC there after debiting internal balance.

5. Transaction statuses:
   - API enum and API reference define `INIT`, `PAID`, `COMPLETED`.
   - Webhook example README also discusses `FAILED` and `CANCELLED`, but these are not present in `utils/enums.ts`.
   - This is an inconsistency that needs defensive handling in integration code.

6. Webhook semantics:
   - API reference says PAJ POSTs a JSON body to the provided `webhookURL`.
   - API reference says to treat the webhook as the authoritative source of truth for final order state.
   - Example README says “validate webhook signatures (if provided by PAJ Ramp)”, which implies signature verification is not concretely documented here.

7. `signature` field meaning:
   - API reference webhook payload example shows `"signature": "OnChainTxSignature..."`.
   - `getTransaction` type also includes `signature` and calls it `SolanaTxSignature...`.
   - Strong inference: this is blockchain transaction signature, not webhook HMAC/signature proof.

8. Supported chain/mint usage:
   - Chain enum in SDK is `SOLANA` or `MONAD`.
   - API reference examples use Solana USDC mint format like `EPjFW...`.
   - Still should confirm exact production mint acceptance with PajCash before launch.

### Important risks still unresolved
1. Webhook authentication:
   - No documented webhook signing scheme, timestamp header, or replay protection found in the repo.
   - Because of that, webhook receipt alone should not trigger final credit/debit without verification.

2. Status inconsistency:
   - API enum only has `INIT`, `PAID`, `COMPLETED`.
   - Example webhook docs mention `FAILED`, `CANCELLED`.
   - Integration should store raw status strings and handle unknown future values safely.

3. Session expiry operations:
   - No refresh flow found.
   - Need app logic to detect expiry and re-initiate/re-verify operationally.

### Recommended integration stance
- Onramp:
  - Create PajCash onramp to the user’s existing Solana wallet address.
  - Let existing Solana wallet monitor detect incoming USDC and credit via existing deposit path.
  - Use Paj webhook as an early signal, but verify with `getTransaction` and/or on-chain balance change before final notification.

- Offramp:
  - Debit internal user balance first into a pending offramp record.
  - Create PajCash offramp order and get deposit `address`.
  - Send treasury USDC there.
  - Mark completed only after Paj webhook and `getTransaction` confirm terminal success.
  - Refund internal balance on failure/timeout path.

### Next concrete code work if continuing
1. Add PajCash env vars:
   - `PAJCASH_ENV`
   - `PAJCASH_API_KEY`
   - `PAJCASH_SESSION_RECIPIENT`
   - `PAJCASH_WEBHOOK_PATH_SECRET`
   - optional `PAJCASH_SESSION_TOKEN_CACHE`

2. Add DB tables:
   - `fantasy_fiat_onramps`
   - `fantasy_fiat_offramps`
   - optional saved bank accounts table

3. Add server module:
   - `src/pajcash.ts` for auth/token caching, create order helpers, transaction verification
   - `POST /webhook/pajcash/:secret` route

4. Add bot UX:
   - `/wallet fund-ngn`
   - `/wallet withdraw-ngn`

5. Add safety logic:
   - idempotency per Paj order id
   - raw webhook event logging
   - status reconciliation via `getTransaction`
   - timeout/failure refund flow for offramp

### Likely answer to user
- Yes, PajCash integration is possible and the repo confirms the key flows.
- The repo answers most flow questions.
- The main remaining production concern is webhook authentication; the repo does not clearly document a signed webhook verification scheme.
