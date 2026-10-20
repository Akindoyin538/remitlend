# Workflow Isolation, PWA Cache Guard & Reproducible Score Snapshots

## 1. Zero Production Credentials or Mainnet Transactions in Workflows
`scripts/check-workflow-safety.mjs` audits CI and verification workflows to guarantee that only isolated test environments (`NODE_ENV=test`, local PostgreSQL/Redis services, and mock/testnet Soroban RPCs) are used, preventing external value-bearing transactions.

## 2. PWA Service-Worker Cache Bypass (`#550`)
- All requests bearing an `Authorization` header, non-`GET` methods, or targeting transaction-sensitive routes (`/api/v1/auth`, `/api/v1/loans`, `/api/v1/pools`, `/api/v1/remittances`, `/api/v1/scores`, `/api/v1/transactions`) strictly bypass service-worker caches (`NetworkOnly` / `Cache-Control: no-store`).

## 3. Delayed RPC Resilience & Reproducible Score Versioning (`#551`, `#552`, `#555`)
- **Reproducible Snapshots (`#552`)**: Every credit score computation records `modelVersion` and a canonical `sha256` `inputDigest` over normalized inputs.
- **Evidence Classification (`#555`)**: Delayed or unindexed remittance proofs are classified as `DELAYED_EVIDENCE_PENDING` rather than `NEGATIVE_BEHAVIOR`, preventing unfair score penalties during oracle or RPC lag.
