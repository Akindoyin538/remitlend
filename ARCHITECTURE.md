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

## Per-Borrower Exposure Limits

Borrower-facing exposure is bounded by an explicit per-borrower limit that is
derived from the authoritative lending-pool state, never invented client-side.
The limit is expressed in `bigint` minor units alongside the existing loan cost
arithmetic, so comparisons stay exact and no floating-point rounding can widen
the bound.

### Authorization and Validation

- The limit is only applied to the authenticated borrower's own exposure; the
  frontend never evaluates or displays another borrower's limit.
- Limits are validated to be positive, finite integers in minor units. An
  invalid or missing limit is treated as a hard failure for the affected action
  rather than silently defaulting to unlimited.
- A request whose projected exposure would exceed the limit is rejected before
  any signing step, with a structured error identifying the borrower, the
  projected exposure, and the configured limit.

### Failure, Retry, and Stale Data

- A dependency failure while fetching the authoritative limit is reported as a
  dependency failure, distinct from a settled limit violation, so an unreachable
  backend is never presented as a borrower over their limit.
- Retries are bounded and abort-aware, consistent with transaction recovery, and
  never create a second signed transaction.
- Stale limit data is surfaced as stale rather than silently reused; the
  borrower is not asked to sign against a limit that cannot be confirmed.

### Observability and Rollback

- Limit violations emit structured errors and metrics carrying the borrower
  reference, projected exposure, and configured limit, without exposing
  unrelated user data.
- Enforcement is additive: relaxing or removing a configured limit restores the
  previous behavior without changing persisted data or deployed contract
  interfaces, providing a safe rollback path.

## Multi-Asset Pool Accounting

Multi-asset pools hold balances and shares for more than one token. Every pool
operation is scoped to exactly one token, and accounting for one token must
never be applied to another. The authoritative per-token balances and shares
come from the pool contract state; the frontend only reflects them and never
re-derives a token's balance from another token's figures.

### Per-Token Isolation and Asset Validation

- Balances, shares, and exchange rates are keyed by token address. A lookup for
  a token that is not part of the pool is a hard failure, not a zero balance.
- Every pool operation (deposit, withdraw, transfer, share conversion) carries
  an explicit token address and validates it against the pool's registered asset
  set before any amount is computed or signed.
- Amounts are `bigint` minor units and are only ever combined with amounts of
  the same token. Cross-token arithmetic is rejected rather than coerced.
- Token addresses are normalized and compared case-insensitively so the same
  asset cannot be treated as two distinct assets.

### Authorization and Validation

- Operations are only performed for the authenticated account's own positions;
  the frontend never computes or displays another account's per-token balances.
- Asset sets and per-token figures are validated to be well-formed (non-empty,
  unique, positive where required). Malformed pool state is a hard failure for
  the affected operation rather than a silent default.
- A request that references an unregistered token, or that would mix tokens in a
  single amount, is rejected before any signing step, with a structured error
  identifying the pool, the token, and the operation.

### Failure, Retry, and Stale Data

- A dependency failure while fetching authoritative pool state is reported as a
  dependency failure, distinct from a settled validation failure, so an
  unreachable backend is never presented as a settled accounting error.
- Retries are bounded and abort-aware, consistent with transaction recovery, and
  never create a second signed transaction.
- Stale pool state is surfaced as stale rather than silently reused; the user is
  not asked to sign against per-token figures that cannot be confirmed.

### Observability and Rollback

- Cross-token accounting attempts and unregistered-token references emit
  structured errors and metrics carrying the pool reference, token address, and
  operation, without exposing unrelated user data.
- Enforcement is additive: it does not change persisted data or deployed
  contract interfaces, so it can be relaxed without a migration, providing a
  safe rollback path.

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

## Observability

- Structured errors are emitted for budget violations and dependency failures.
- Metrics are recorded for route load, render, and bundle dimensions.
- Operational diagnostics distinguish between unsupported environments and genuine regressions.
- Transaction failures are classified before they reach the UI, and carry a
  non-identifying support code (failure category, truncated transaction hash,
  attempt counter) so a support ticket can be correlated without exposing user
  data.

## Testing

Focused automated tests cover success, boundary values, invalid configuration, unsupported environments, and dependency failure paths for route budgets, alongside existing routing and offline tests. Loan cost disclosure and transaction recovery have dedicated unit and component suites covering rounding boundaries, every typed error and failure state, hostile input, stale and unavailable authoritative data, retry safety, and the double-submission invariant. Per-borrower exposure limits are covered by focused tests for success, authorization failure, boundary values, retries, stale data, and dependency failure paths. Multi-asset pool accounting is covered by focused tests for per-token isolation, unregistered-token rejection, cross-token arithmetic rejection, authorization failure, boundary values, retries, stale data, and dependency failure paths.
