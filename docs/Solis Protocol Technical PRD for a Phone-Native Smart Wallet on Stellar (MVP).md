# Solis: Technical PRD for a Phone-Native Smart Wallet on Stellar (MVP)

Version 1.1 | November 10, 2026 | Status: Draft for hackathon build | Network: Stellar testnet

## 1. Summary

Solis is a phone-number-first payment layer on Stellar. A user signs up with a phone number and an OTP, gets a passkey-secured Soroban smart wallet with sponsored fees, and sends USDC to any phone number, including numbers that have not signed up yet. Unregistered recipients are paid through an escrow that releases when they verify their number.

The MVP reuses existing building blocks (OpenZeppelin Smart Account via Smart Account Kit, OpenZeppelin Relayer for fee sponsorship) and builds only the parts that are new: the phone identity registry, the pay-to-phone escrow, the sponsor policy engine, and the app. The whole off-chain platform is one Next.js (App Router, TypeScript) app with Prisma on Supabase Postgres; the on-chain logic is two Rust contracts on Soroban.

## 2. Goals and non-goals

### Goals (MVP)

- G1: Account creation with only a phone number, OTP and a passkey. No seed phrase, no XLM.
- G2: Send USDC to a phone number in under 10 seconds end to end on testnet.
- G3: Pay an unregistered number; recipient claims after verifying.
- G4: All fees sponsored, with abuse controls.
- G5: Self-custody preserved. The backend can never move user funds.

### Non-goals (MVP)

- USSD, WhatsApp, feature-phone support
- Real fiat on/off-ramps (mocked screen only)
- Guardian-based social recovery (second passkey only)
- KYC, multi-country compliance, mainnet
- Decentralized registry attestation
- Custom wallet contract (use OpenZeppelin Smart Account as is)

## 3. Users

- **Sender/recipient (primary):** mobile-money user, smartphone with passkey-capable browser, low crypto knowledge.
- **Sponsor (secondary, simulated in MVP):** the app operator funding fees from one sponsor account.
- **Developer (post-MVP):** integrates the registry and relay via SDK.

## 4. Architecture

```
Browser (Next.js PWA)
  |-- Smart Account Kit: passkey create/sign (client components)
  |-- fetch --> Next.js server (App Router route handlers, Node runtime)
                  |-- OTP / SMS provider
                  |-- Prisma --> Supabase Postgres (pooled connection)
                  |-- Sponsor policy engine --> OpenZeppelin Relayer (Channels) --> Stellar network
                  |-- Attestor key (registry writes only), via the Stellar JS SDK
                  |-- Cron route: indexer (Soroban RPC getEvents)
Soroban contracts (Rust): PhoneRegistry, PayEscrow; OZ Smart Account per user; USDC (SAC)
```

Monorepo layout:

```
solis/
  apps/web/             Next.js app: UI, /api route handlers, lib/server modules
    prisma/schema.prisma
  contracts/            Rust workspace: phone_registry, pay_escrow
  packages/bindings/    TypeScript clients generated from the compiled contracts
```

- One language per layer: TypeScript for everything off-chain, Rust only for the two Soroban contracts.
- Contracts are built and deployed with the Stellar CLI. TypeScript bindings are generated from the contract specs and imported by the web app, so contract calls are typed end to end.
- Server code lives in modules marked `server-only`, so the attestor key, relayer credential and HMAC key can never be bundled into client code.

Trust boundaries:

- Authorization of fund movement happens on-chain via the user's passkey signer. The backend has no signing power over user wallets.
- The backend holds two secrets: the attestor key (registry writes only) and the relayer credential (fee payment only), plus the phone HMAC key.

## 5. Components

### 5.1 Smart wallet (reuse)

- OpenZeppelin Smart Account deployed per user, with a secp256r1 passkey signer registered at creation.
- Created client-side through Smart Account Kit; deployment transaction submitted through the relayer so the user needs no XLM.
- Second passkey added as a backup signer during onboarding (skippable, nudged).
- Pin the SDK and WASM hash versions. Record the account WASM hash in config.

### 5.2 PhoneRegistry contract (build)

Maps a keyed hash of the phone number to a wallet address.

Storage (persistent, TTL extended on every read/write):

- `Admin: Address` (attestor)
- `Entry(hash: BytesN<32>) -> Address`
- `Pending(hash) -> { new_wallet: Address, ready_at: u64 }`

Interface:

- `init(admin: Address)`
- `register(hash: BytesN<32>, wallet: Address)`: admin auth required; fails if hash already bound.
- `resolve(hash: BytesN<32>) -> Option<Address>`: public read.
- `propose_rebind(hash, new_wallet)`: admin auth; sets `ready_at = now + COOLDOWN` (default 72h).
- `cancel_rebind(hash)`: requires auth of the currently bound wallet. This is the SIM-swap defense hook.
- `finalize_rebind(hash)`: admin auth; only after `ready_at` and not cancelled.

Events: `registered`, `rebind_proposed`, `rebind_cancelled`, `rebound`.

Rebind is a stretch goal for the hackathon. Register and resolve are required.

### 5.3 PayEscrow contract (build)

Holds funds for a phone hash until the matching wallet claims them.

Storage: `Registry: Address`, `Payment(id: u64) -> { sender, hash, token, amount, expires_at, status }`, `NextId`.

Interface:

- `deposit(sender, hash, token, amount, expires_at) -> u64`: `sender.require_auth()`; transfers `amount` of `token` from sender to the contract; stores payment as `Pending`.
- `claim(id)`: loads payment; calls `registry.resolve(hash)`; requires the resolved address to exist, calls `require_auth()` on it, transfers funds to it, marks `Claimed`. Fails if expired.
- `refund(id)`: `sender.require_auth()`; only after `expires_at`; marks `Refunded`.

Rules:

- Maximum expiry window 30 days; minimum amount enforced to block dust spam.
- One status transition per payment; reject double claim/refund.
- Token must be on an allow-list (testnet USDC SAC) set at init.
- Events: `deposited`, `claimed`, `refunded`.

Direct send to an already-registered number does not use escrow: the app resolves the hash and sends a plain token transfer from the sender's smart wallet.

### 5.4 Backend (Next.js route handlers)

Responsibilities: OTP verification, phone normalization and HMAC, attestor writes, sponsor policy and relay submission, resolution API, escrow indexing, SMS notifications. All of it runs as Next.js route handlers on the Node runtime (never Edge), with logic in `lib/server` modules.

- Secrets (attestor key, relayer credential, phone HMAC key, database URL) live in server-only environment variables.
- Transaction submission is asynchronous: the route returns a pending status and the client polls `/api/payments`. No request waits for ledger close, which keeps serverless time limits out of the picture.
- Rate-limit counters (OTP, sponsor caps) live in a Postgres table through Prisma for the MVP, using atomic upserts. Move to Redis if traffic demands it.

Phone hash: `hash = HMAC-SHA256(key = PHONE_HMAC_KEY, msg = E.164(phone))`. Never store or put plaintext numbers on-chain. Rotating the key requires re-registration, so version it (`hmac_v1`).

### 5.5 Sponsor policy engine (build)

Sits in front of the relayer. A transaction is sponsored only if all hold:

- Invoked contract and function are on the allow-list: registry (none directly from users), escrow `deposit/claim/refund`, USDC `transfer`, smart account init and signer management.
- Authenticated session exists (OTP-verified).
- Per-user limits not exceeded: transactions per day, total sponsored fee per day.
- Global daily budget not exceeded; per-transaction max fee cap.
- Simulation succeeds before submission.

All decisions are logged to `sponsored_txs` with reason codes.

### 5.6 Indexer

A cron-triggered route handler (`/api/cron/index`, protected by a secret header, scheduled about once a minute by Vercel Cron or Supabase pg\_cron) polls Soroban RPC `getEvents` for escrow and registry events, upserts them through Prisma, and drives SMS notifications and the activity feed. The job is idempotent: it persists the last processed ledger in `IndexerState` and backfills on restart, which also covers RPC event retention limits.

### 5.7 Frontend (PWA)

Screens: onboarding (phone, OTP, passkey), home (balance, recent activity), send (phone + amount, confirm with passkey), pending/claim, receive (shows own phone as identifier), cash-out (mock), settings (add backup passkey).

Passkeys require HTTPS and a stable relying-party ID. Configure the RP ID for the deployed domain early, since changing it invalidates existing passkeys.

Implementation: App Router pages, with data screens (home, activity) rendered as server components and passkey and signing flows in client components. The PWA manifest and service worker make it installable.

## 6. Core flows

### 6.1 Onboarding

1. User enters phone; backend normalizes to E.164 and sends OTP (rate-limited).
2. User enters OTP; backend issues a session token.
3. Client creates a passkey and a smart account deployment transaction via Smart Account Kit.
4. Client submits through the backend; policy engine approves; relayer sponsors; account deployed.
5. Backend computes hash and calls `registry.register(hash, wallet)` with the attestor key.
6. Backend checks for pending escrow payments for this hash and surfaces them as claimable.

### 6.2 Send to a registered number

1. Client calls `GET /resolve?phone=` (authenticated, rate-limited); gets wallet address or not found.
2. Client builds USDC `transfer` from the user's smart wallet, signs the auth entry with the passkey.
3. Backend policy check, relayer submits, indexer records the result.

### 6.3 Send to an unregistered number

1. Resolve returns not found. Client builds `escrow.deposit(sender, hash, usdc, amount, expires_at)`.
2. Passkey signs; sponsored submission.
3. Backend sends an SMS with a claim link. The message contains no amount-sensitive secrets, only a link to the app.
4. Recipient signs up (flow 6.1), then calls `claim(id)`; funds land in their wallet.
5. If unclaimed by `expires_at`, sender calls `refund(id)`.

### 6.4 Recovery (MVP)

Lost device: the user signs in with a synced passkey (iCloud/Google password manager) or uses the backup passkey. If both are lost, funds are unrecoverable in the MVP. This is documented honestly in the UI. Guardian recovery is post-MVP.

## 7. Backend API

All endpoints are Next.js route handlers under `/api` (paths below are relative to it), served over HTTPS. Authenticated endpoints use a short-lived signed session cookie (httpOnly, SameSite=Lax).

| Method | Path | Purpose |
| --- | --- | --- |
| POST | /auth/otp/request | Send OTP to phone (rate-limited per phone and IP) |
| POST | /auth/otp/verify | Verify OTP, return session |
| POST | /wallets/register | After deployment, bind phone hash to wallet (attestor write) |
| POST | /relay/submit | Submit signed transaction for sponsorship (policy enforced) |
| GET | /resolve | Resolve phone to wallet address (auth, rate-limited) |
| GET | /payments | Activity feed and claimable escrow payments |
| POST | /notify/claim | Trigger claim SMS for an escrow deposit |

Resolution is served only through the backend. The raw HMAC key never leaves the server, so third parties cannot brute-force the registry offline.

## 8. Data model (Prisma on Supabase Postgres)

Prisma schema (abridged):

```prisma
model User {
  id            String   @id @default(uuid())
  phoneHash     String   @unique        // versioned HMAC, e.g. hmac_v1:<hex>
  walletAddress String?  @unique
  createdAt     DateTime @default(now())
  sessions      Session[]
  sponsoredTxs  SponsoredTx[]
}
model OtpChallenge { id String @id @default(uuid()); phoneHash String; codeHash String; expiresAt DateTime; attempts Int @default(0) }
model Session      { id String @id @default(uuid()); userId String; expiresAt DateTime }
model SponsoredTx  { id String @id @default(uuid()); userId String; txHash String?; fn String; feeStroops BigInt; decision String; reason String?; createdAt DateTime @default(now()) }
model EscrowPayment {
  id            String @id @default(uuid())
  onchainId     BigInt @unique
  senderWallet  String
  phoneHash     String
  token         String
  amount        BigInt
  status        PaymentStatus @default(PENDING)
  expiresAt     DateTime
  notifiedAt    DateTime?
}
enum PaymentStatus { PENDING CLAIMED REFUNDED }
model IndexerState { id Int @id @default(1); lastLedger Int }
model RateLimit    { key String @id; count Int; windowStart DateTime }
```

- Plaintext phone numbers are not stored. The number is used for OTP and for the one-time claim SMS, then discarded; if retention is ever needed, encrypt it at rest with an app-level key.
- Supabase is used as managed Postgres only. Prisma connects server-side: `DATABASE_URL` points at the pooled connection (pgbouncer mode) for runtime, and `DIRECT_URL` at the direct connection for migrations.
- Enable row level security on every table with no public policies, so the Supabase anon key cannot read anything. Never ship the Supabase client or keys to the browser.
- Supabase Auth, Storage and Realtime are not used in the MVP. Realtime is a candidate later for live claim and balance updates.

## 9. Security and threat model

| Threat | Mitigation |
| --- | --- |
| Offline brute force of phone hashes | Keyed HMAC, key held server-side only, resolution via authenticated API |
| SIM swap / recycled number takes over a registration | Registration binds to a wallet the user controls; rebind has a cooldown and the existing wallet can cancel; escrow claims require the bound wallet's auth |
| Compromised attestor key | Attestor can only write registry entries, never move funds; keep key in a secrets manager; rotate via admin function; alert on unexpected writes |
| Fee-sponsor drain | Allow-list, per-user and global caps, simulation before submit, fee cap per tx |
| Relayer outage | Queue and retry with idempotency keys; surface pending state in UI |
| OTP abuse and SMS pumping | Per-phone and per-IP rate limits, country allow-list, cost alerts |
| Escrow logic bugs | Small contract surface, single status transition, property tests, third-party review before any mainnet use |
| Registry state archival | Extend TTL on writes and via a scheduled keep-alive job |

Compliance note: registry and escrow handle phone-linked financial activity. Treat this as a testnet prototype; legal review per country is required before real users or mainnet.

## 10. Non-functional requirements

- Latency: p95 send confirmation under 10 seconds on testnet.
- Availability: graceful degradation when relayer or RPC is down; no silent loss of submitted transactions.
- Observability: structured logs, sponsor spend dashboard, indexer lag metric.
- Pin and record versions of Smart Account Kit, relayer service, and Soroban SDK. Both relayer and kit are young and may change.

Serverless constraints:

- Route handlers run on the Node runtime; confirmation is async and polled by the client.
- One Prisma client instance per process, pooled database connection.
- Cron jobs are idempotent and safe to run twice.
- Pin and record versions of Next.js, Prisma, the Stellar JS SDK, soroban-sdk, Smart Account Kit and the relayer.

## 11. Testing and acceptance

- Contract unit tests: register/resolve, duplicate registration rejected, deposit/claim/refund transitions, claim by wrong wallet rejected, claim after expiry rejected, refund before expiry rejected, rebind cooldown and cancel.
- Integration test on testnet: full flows 6.1 to 6.3 scripted.
- Policy tests: disallowed contract rejected, caps enforced, simulation failure not submitted.
- Manual demo checklist: two phones, one registered and one not; send, SMS arrives, signup, claim, balance updates.

MVP acceptance:

- AC1: New user completes onboarding without holding XLM.
- AC2: Send to a registered number succeeds with fee sponsored.
- AC3: Pay unregistered number, recipient claims after signup.
- AC4: Unclaimed payment refunds after expiry.
- AC5: Sponsor engine blocks a non-allow-listed call and an over-cap user.

## 12. Build plan

1. Repo and environment: monorepo with the Next.js app, Supabase project, Prisma schema and first migration, testnet accounts, USDC SAC, relayer access, Smart Account Kit sample running inside the app.
2. Sponsored passkey wallet creation end to end through `/api/relay/submit`.
3. Rust PhoneRegistry contract with tests, deploy, generate bindings, then the OTP flow and attestor write.
4. Send to a registered number, resolve route, activity feed.
5. Rust PayEscrow contract with tests, deploy, bindings, cron indexer, SMS.
6. Sponsor policy engine hardening and tests, with Postgres-backed rate limits.
7. Demo polish, mock cash-out screen, pitch material.

Cut order if time runs out: rebind flow, backup passkey nudge, activity feed polish, then refund UI. Never cut escrow claim; it is the demo.

## 13. Roadmap beyond MVP

- **Grant phase:** SDK and API for other Stellar apps, guardian recovery, SEP-24/31 anchor integration, sponsor marketplace, audit, load testing.
- **Product phase:** USSD and WhatsApp channels, telco or regulated attestors for the registry, SIM-swap signals, per-country compliance starting with Nigeria, mainnet launch.

## 14. Open questions

- Which OTP provider gives reliable delivery in Nigeria at acceptable cost?
- Should the registry attestor set be a multisig from the start, even if all keys are team-held?
- Sponsor funding model after grant: anchor-paid, merchant-paid, or per-transaction micro-fee in USDC?
- Exact hackathon deadline and judging criteria; adjust scope in section 12 accordingly.

* Custom OTP sessions (as specified) or Supabase Auth phone login? Custom keeps the OTP provider choice open; Supabase Auth saves build time if its SMS provider delivers reliably in Nigeria.
* Hosting: Vercel (simplest cron and deploys) or a self-hosted Node server, and which Supabase region is closest to the target users?
