# Architecture

## Overview

This document describes the high-level architecture of the frontend application, its boundaries, and the operational contracts it must uphold.

## Frontend Boundary

The frontend is a single-page application responsible for:

- Rendering user-visible status derived from authoritative backend sources.
- Managing client-side routing, data fetching, caching, and offline behavior.
- Enforcing client-side performance and resource budgets.

Backend APIs, persisted data, and chain state remain authoritative. The frontend never invents financial values or chain state; it only reflects them.

## Routing

Routes are declared centrally and each route is associated with a lazy-loaded module boundary. Route transitions must remain compatible with existing deep links and persisted navigation state.

## Route-Level Performance Budgets

To keep the application responsive and to catch regressions early, each route declares an explicit performance budget. Budgets are validated at runtime and reported through structured diagnostics.

### Budget Dimensions

- **Load time**: maximum time from route navigation start to the route's first meaningful render.
- **Render time**: maximum time for the route's initial render commit.
- **Bundle size**: maximum transferred JavaScript size attributable to the route's lazy chunk.

### Thresholds

Thresholds are defined per route and are intentionally conservative. A route without an explicit budget inherits the default budget. Budgets are validated to be positive, finite numbers; invalid budgets are rejected and fall back to the default rather than disabling enforcement.

### Enforcement and Bounded Resource Usage

- Measurement uses the browser Performance API when available and degrades gracefully when it is not.
- Observers are bounded: a single performance observer per route, disconnected after the route settles, to avoid unbounded listener growth.
- Budget checks are non-blocking and never delay rendering or navigation.

### Failure and Diagnostics

- A budget violation emits a structured error event containing the route, the dimension, the observed value, and the configured threshold.
- Violations are reported as metrics so they can be aggregated and alerted on in production.
- Missing or unsupported performance APIs are treated as a non-fatal condition and reported as a diagnostic, not an error.

### Compatibility and Rollback

- Budget enforcement is observational only; it does not alter routing, rendering, or user-visible status.
- Budgets can be relaxed or disabled per route without changing route behavior, providing a safe rollback path.
- Existing routes, deep links, and persisted navigation state remain fully compatible.

## Offline Support

Offline state is tracked centrally and surfaced through a banner. Data fetching uses a unified query key scheme so cached data remains consistent across hooks and components.

## Deferred Wallet SDK Loading

The wallet SDK is loaded lazily to keep the initial bundle small and to avoid blocking first paint. Route-level budgets account for the deferred load so that wallet-dependent routes still meet their thresholds.

## Loan Cost Disclosure

All borrower-facing money is computed by one exact-arithmetic engine
(`frontend/src/app/utils/loanCostDisclosure.ts`) and rendered by one component
(`LoanCostDisclosurePanel`). Amounts are `bigint` minor units and rates are
integer basis points, so the disclosed total is always the sum of the disclosed
components. The lending pool amortization returned by the backend is the
settlement source of record; the local computation is an estimate that is
reconciled against it, and any divergence is surfaced rather than absorbed. A
borrower is never asked to sign a request whose cost cannot be computed.

See [docs/loan-cost-disclosure.md](docs/loan-cost-disclosure.md).

## Transaction Recovery

Every wallet-connected failure is classified into a typed failure state
(`rejected`, `expired`, `failed`, `unknown`) and turned into a recovery plan by
a pure function (`planTransactionRecovery`). The plan always states whether
resubmission is safe. **Once a signed transaction has been handed to the
network, the plan contains no action that can create a second one** — the only
safe actions are re-polling the same hash, inspecting the explorer, copying the
transaction id, reloading, or contacting support. Status polling is bounded
(`maxAttempts`, `requestTimeoutMs`, overall `timeoutMs`) and abort-aware, and it
reports a dependency failure separately from a settled failure so an unreachable
node is never presented as a failed transaction.

See [docs/transaction-recovery-ux.md](docs/transaction-recovery-ux.md).

## Donation and Unsolicited-Transfer Reconciliation

Inbound transfers that were not initiated by a known application flow are
reconciled inside the contracts boundary. Two categories are recognized:

- **Donation**: an unsolicited inbound transfer the recipient explicitly accepts
  as a donation.
- **Unsolicited transfer**: an inbound transfer that is not a donation and must
  be classified before it affects any user-visible balance or status.

### Authorization

Classification and reconciliation are privileged operations. Only an
`admin`/`operator` role may classify or reconcile a transfer; any other caller
receives an explicit authorization failure and the transfer remains in its
prior state. Authorization is checked before any state mutation so a rejected
caller cannot partially reconcile a transfer.

### Validation and Bounded Resource Usage

- Transfer references must be non-empty and well-formed; amounts are `bigint`
  minor units and must be positive.
- Classification must be one of the recognized categories; unknown values are
  rejected rather than defaulted.
- Reconciliation processes transfers in bounded batches (`maxBatchSize`) with a
  hard iteration cap, so a large backlog cannot exhaust resources or block the
  request path.

### Failure, Retry, and Stale Data

- Dependency failures (unreachable node or indexer) are reported separately from
  settled failures and are retryable; settled classifications are not retried.
- Stale transfer data is never used to derive a user-visible balance; the
  authoritative chain/indexer state is re-read before a transfer is marked
  reconciled.

### Compatibility and Rollback

- Changes are additive: no existing contract signature, storage layout, or API
  consumer is altered.
- Reconciliation state is derived from authoritative sources and can be
  recomputed, so rollback is a matter of disabling the reconciliation job
  without migrating persisted data.

### Observability

- Structured errors are emitted for authorization failures, validation
  failures, and dependency failures.
- Metrics are recorded for transfers classified, reconciled, and rejected per
  category.
- Audit events record who classified or reconciled a transfer and when.

## Contract Storage Migration Manifests

Every contract version declares a **storage migration manifest** describing its
persisted storage layout and the migration path from the previous version. The
manifest is the single source of truth for what a version stores and how it is
transformed, so deployed contracts and persisted on-chain data remain
compatible across upgrades.

### Manifest Contents

Each manifest captures, for one contract version:

- **Version identifier**: the contract version the manifest describes and the
  version it migrates from (the genesis version has no predecessor).
- **Storage keys and layout**: every persisted key, its type, and its ordering,
  so the expected storage shape can be validated before and after migration.
- **Migration steps**: the ordered, deterministic transformations applied to
  move data from the previous version's layout to this version's layout.

Manifests are declared for every contract version, including versions that
require no transformation (an empty step list), so the absence of a manifest is
itself a detectable error rather than an implicit no-op.

### Compatibility

- Migrations are **additive by default**: new keys are introduced and existing
  keys retain their meaning and encoding.
- A migration that must change or remove an existing key is explicitly marked
  **breaking** in its manifest and must document a rollback path.
- Persisted data written by a prior version remains readable; a version never
  silently reinterprets existing bytes.

### Validation and Bounded Resource Usage

- Before a migration runs, preconditions are validated: the on-chain version
  must match the manifest's `from` version, and the observed storage shape must
  match the manifest's declared layout. A mismatch aborts the migration before
  any write.
- Migration steps are applied in bounded batches with a hard iteration cap, so a
  large storage set cannot exhaust resources or block the request path.

### Authorization

Only an `admin`/`operator` role may trigger a migration. Authorization is
checked before any state mutation, so an unauthorized caller cannot partially
migrate storage.

### Failure, Retry, and Stale Data

- Migrations are idempotent per step: a step that has already been applied is
  detected and skipped, so a retry after a partial failure resumes safely.
- Dependency failures (unreachable node or indexer) are reported separately from
  validation failures and are retryable; validation failures are not retried
  until the precondition is corrected.
- Stale storage reads are never used to derive user-visible state; the
  authoritative on-chain version and layout are re-read before a migration step
  is applied.

### Rollback

- Additive migrations roll back by disabling the migration job; no persisted
  data needs to be rewritten.
- Breaking migrations declare an explicit reverse manifest so the prior layout
  can be restored from the new one.

### Observability

- Structured errors are emitted for authorization failures, precondition
  failures, and dependency failures.
- Metrics are recorded for migrations started, completed, skipped, and failed
  per contract version.
- Audit events record who triggered a migration, the from/to versions, and when.

## Observability

- Structured errors are emitted for budget violations and dependency failures.
- Metrics are recorded for route load, render, and bundle dimensions.
- Operational diagnostics distinguish between unsupported environments and genuine regressions.
- Transaction failures are classified before they reach the UI, and carry a
  non-identifying support code (failure category, truncated transaction hash,
  attempt counter) so a support ticket can be correlated without exposing user
  data.

## Testing

Focused automated tests cover success, boundary values, invalid configuration, unsupported environments, and dependency failure paths for route budgets, alongside existing routing and offline tests. Loan cost disclosure and transaction recovery have dedicated unit and component suites covering rounding boundaries, every typed error and failure state, hostile input, stale and unavailable authoritative data, retry safety, and the double-submission invariant. Donation and unsolicited-transfer reconciliation has focused tests covering success, authorization failure, boundary values, retries, stale data, and dependency failure paths. Contract storage migration manifests have focused tests covering version-match validation, storage-shape validation, additive and breaking migrations, idempotent retry after partial failure, and rollback.
