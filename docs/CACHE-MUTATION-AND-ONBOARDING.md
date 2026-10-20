# Documented Setup Verification & Chain-Authoritative Cache Mutation Rules

## 1. Fresh Runner Onboarding & Setup Verification
`scripts/verify-documented-setup.mjs` validates and executes the documented contributor onboarding sequence on a fresh runner:
1. **Dependency Install**: `npm ci` in `backend/` and `frontend/`.
2. **Environment Setup**: Copies `backend/.env.example` and `frontend/.env.example` using non-production local defaults.
3. **Database Migrations**: Runs `npm run migrate:up` to apply all `node-pg-migrate` migrations.
4. **Database Seeding**: Runs `npm run seed` (`tsx src/seed/index.ts`) for local development data.
5. **Focused Verification Tests**: Executes `npm run docs:check` and unit test suites.

## 2. Wallet & Network State Invalidation (`#541`, `#543`)
- Switching active Stellar wallet public keys or network passphrases immediately invalidates all account-scoped query keys (`wallet-session`, `borrower-loans`, `lender-positions`, `remittance-history`, `credit-score`, `pending-transactions`).
- Single-transaction recovery state is keyed by `(account, networkPassphrase, txHash)` in storage so page reloads and duplicate tabs resume polling without submitting duplicate signatures.

## 3. Pool Position Reconciliation & Cache Mutation Rules (`#544`, `#546`)
- Optimistic UI mutations are tagged with the originating ledger sequence and replaced only when finalized Soroban deposit/withdrawal events (`incomingLedgerSequence >= cachedLedgerSequence`) are indexed.
