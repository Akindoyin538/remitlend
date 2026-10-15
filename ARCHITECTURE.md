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

## Protocol-Wide Debt Ceiling

In addition to the per-borrower exposure limit, total protocol debt is bounded
by a single protocol-wide debt ceiling. The ceiling is an admin-settable
parameter stored in contract storage alongside the existing per-loan limits; it
is additive and does not alter the layout or semantics of existing storage
slots. The authoritative total outstanding debt and the configured ceiling are
read from contract state; the frontend only reflects them and never re-derives
total debt from partial or cached figures.

### Authorization and Validation

- Only the protocol admin may set or update the debt ceiling. Non-admin callers
  are rejected with an authorization failure before any state is written.
- The ceiling is validated to be a positive, finite integer in `bigint` minor
  units. An invalid or missing ceiling is a hard failure for the affected action
  rather than silently defaulting to unlimited.
- The ceiling is enforced at loan creation/origination: a new loan whose
  principal would push total outstanding debt above the ceiling is rejected
  before any signing or state mutation, with a structured error identifying the
  projected total debt, the new principal, and the configured ceiling.
- Boundary values are exact: a loan that brings total debt exactly to the
  ceiling is accepted; any amount above it is rejected.

### Failure, Retry, and Stale Data

- A dependency failure while fetching the authoritative ceiling or total debt is
  reported as a dependency failure, distinct from a settled ceiling violation,
  so an unreachable backend is never presented as a settled over-ceiling error.
- Retries are bounded and abort-aware, consistent with transaction recovery, and
  never create a second signed transaction.
- Stale ceiling or total-debt data is surfaced as stale rather than silently
  reused; the borrower is not asked to sign against a ceiling that cannot be
  confirmed.

### Observability and Rollback

- Ceiling violations and admin ceiling updates emit structured errors, audit
  events, and metrics carrying the projected total debt, the new principal, and
  the configured ceiling, without exposing unrelated user data.
- Enforcement is additive: raising or removing the configured ceiling restores
  the previous behavior without changing persisted data or deployed contract
  interfaces, providing a safe rollback path.

## Share-Price Rounding Policy

Share prices (the value of one pool share in underlying minor units) are derived
from authoritative contract state: total assets and total supply. The frontend
never invents a share price; it reflects the contract's value and applies the
rounding policy below only for display and for pre-signing projections.

### Rounding Direction and Precision

- Share prices are computed with integer arithmetic on `bigint` minor units and
  a fixed decimal precision of 18 fractional digits, matching the contract's
  internal fixed-point representation. No floating-point arithmetic is used.
- Rounding is **half-up** at the 18th fractional digit. The policy is explicit
  and deterministic so that two clients observing the same contract state always
  display the same value.
- Rounding is applied only at the final display/projection step. Intermediate
  arithmetic (asset and supply totals, per-share conversions) is exact and never
  rounded, so rounding error cannot accumulate across a multi-step computation.
- Conversions from shares to assets round **down** (toward zero) and conversions
  from assets to shares round **down** as well, so a user is never credited more
  assets or shares than the exact value supports. Any residual dust remains in
  the pool and is never assigned to a user.

### Edge Cases

- **Zero supply**: when total supply is zero, the share price is undefined. The
  first deposit establishes the initial share price at a 1:1 ratio (one share
  per minor unit deposited), consistent with the contract's first-deposit
  behavior. The frontend surfaces this as the initial price rather than dividing
  by zero.
- **First deposit**: the first deposit mints shares 1:1 and is exempt from the
  rounding policy; subsequent deposits use the derived share price.
- **Dust amounts**: deposits or withdrawals whose exact share value rounds to
  zero are rejected before signing with a structured error identifying the
  amount and the minimum representable value, rather than silently minting or
  burning zero shares.
- **Boundary values**: a conversion that lands exactly on a representable value
  is accepted unchanged; only values strictly between representable steps are
  rounded per the direction rules above.

### Authorization, Failure, and Stale Data

- Share-price computation is read-only and requires no elevated authorization;
  it operates only on public contract state.
- A dependency failure while fetching total assets or total supply is reported as
  a dependency failure, distinct from a settled rounding outcome, so an
  unreachable backend is never presented as a settled share price.
- Retries are bounded and abort-aware, consistent with transaction recovery, and
  never create a second signed transaction.
- Stale total-assets or total-supply data is surfaced as stale rather than
  silently reused; the user is not asked to sign against a share price that
  cannot be confirmed.

### Observability and Rollback

- Rounding-policy rejections (dust, undefined price) emit structured errors and
  metrics carrying the input amount, the computed share price, and the applied
  precision, without exposing unrelated user data.
- The policy is additive and display/projection-only: it does not alter contract
  storage, deployed contract interfaces, or persisted data. Reverting to the
  previous behavior is a matter of removing the display-time rounding, providing
  a safe rollback path.
